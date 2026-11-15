/**
 * Filesystem tools: `write`, `edit`, `stat`, `mkdir` and `move`.
 *
 * Reads and writes go through the host's `ctx.fs` broker, so the manifest's
 * `fs` grant decides what the module may touch and denials stay auditable.
 * `stat` uses the brokered `ctx.fs.stat` (lstat semantics: a symlink reports
 * itself, not its target). The broker has no `rename`, and the worker runs
 * under Node's permission model, which denies it even on write-granted paths,
 * so `move` and the atomic write helper run a tiny `node -e` script through
 * `ctx.process.run`: argv only, no shell string, no extra dependency. `mkdir`
 * uses `node:fs` directly, which Node's permission model only allows inside the
 * granted write patterns.
 *
 * `write` and `edit` never truncate the target: the broker's `write` is only
 * used for a sibling temp file, which then replaces the target by `rename`, so
 * a failed or partial write leaves the old bytes untouched. A hardlinked file
 * (`nlink > 1`) is the exception: replacing it would break the other links, so
 * it is written in place and the result says so.
 *
 * `write` also refuses to overwrite a file this session never read, or one
 * whose bytes changed since that read: the model has to look before it
 * replaces. `read` records a sha256 of the content it returned; `write` and
 * `edit` refresh it. The map is per process and keyed by workspace and
 * resolved path, so a restart simply asks for a fresh read.
 *
 * `read` bounds its own output (not only the file it loads): at most
 * `MAX_READ_CHARS` characters, with a single line clipped to `MAX_LINE_CHARS`.
 * Clipped lines say how many characters are missing and a truncated window
 * names the next `offset`, so a `read` answer stays a fixed size whatever the
 * file looks like.
 *
 * Every path is contained by `resolvePath` before use; `move` checks both ends.
 * `stat`, `mkdir` and `move` use `resolveLexicalPath` instead, which contains
 * the parent but keeps the last component, so they see the entry the model
 * named rather than the symlink target behind it.
 *
 * `stat` prints `type size mtime [mode] [nlink=N] path`, with `-> target`
 * appended for a link (and `(dangling)` when the target is gone): `mode` is the
 * four-digit `lstat` mode (`0644`), `nlink` appears only above 1, and `mtime`
 * is a local wall clock with its UTC offset (`2026-11-15T16:09:54.553+02:00`,
 * or `Z`-style `+00:00` in UTC). A FIFO, socket or device is `other`, with its
 * kind in parentheses after the path.
 *
 * @module z1-tools/fs
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'

import { fail, isRecord, optionalBoolean, optionalInteger, positiveInteger } from './args.js'
import { runHelper, runHelperResult } from './host.js'
import {
  displayPath,
  insideWorkspace,
  refuseSessionStorePath,
  resolveLexicalPath,
  resolvePath,
  workspaceRoot,
} from './paths.js'
import {
  BINARY_SNIFF_BYTES,
  MAX_READ_BYTES,
  MAX_READ_LINES,
  byteLength,
  detectEol,
  excerpt,
  plural,
  splitLines,
  toEol,
} from './text.js'

/** Characters one `read` call returns before it stops adding lines. */
const MAX_READ_CHARS = 100_000

/** Characters of one line `read` shows before clipping it. */
const MAX_LINE_CHARS = 2_000

/**
 * `stat` helper: one `lstat` plus `readlink`, reported as JSON.
 *
 * The broker's `stat` knows only file/dir/symlink and no mode or link count,
 * and throws on a FIFO or a device. `lstat` here reports the entry itself:
 * `{ok:true, type, kind, size, mtimeMs, mode, nlink, linkTarget, dangling}`,
 * where `type` is `file`, `dir`, `symlink` or `other` and `kind` names the
 * special file (`fifo`, `socket`, `chardev`, `blockdev`). A missing path is
 * `{ok:false, code:"ENOENT"}` rather than an error, so callers can decide.
 * Everything is printed and the helper exits 0, so its output never has to be
 * parsed out of a stack trace.
 */
const STAT_SCRIPT = [
  "const fs = require('node:fs')",
  'const target = process.argv[1]',
  'function kindOf(info) {',
  '  if (info.isFile()) return "file"',
  '  if (info.isDirectory()) return "dir"',
  '  if (info.isSymbolicLink()) return "symlink"',
  '  return "other"',
  '}',
  'function specialOf(info) {',
  '  if (info.isFIFO()) return "fifo"',
  '  if (info.isSocket()) return "socket"',
  '  if (info.isCharacterDevice()) return "chardev"',
  '  if (info.isBlockDevice()) return "blockdev"',
  '  return null',
  '}',
  'try {',
  '  const info = fs.lstatSync(target)',
  '  const type = kindOf(info)',
  '  let linkTarget = null',
  '  let dangling = false',
  '  if (type === "symlink") {',
  '    try { linkTarget = fs.readlinkSync(target) } catch {}',
  '    try { fs.statSync(target) } catch { dangling = true }',
  '  }',
  '  process.stdout.write(JSON.stringify({',
  '    ok: true,',
  '    type,',
  '    kind: specialOf(info),',
  '    size: info.size,',
  '    mtimeMs: info.mtimeMs,',
  '    mode: info.mode & 0o7777,',
  '    nlink: info.nlink,',
  '    linkTarget,',
  '    dangling,',
  '  }))',
  '} catch (error) {',
  '  const code = error === null || typeof error !== "object" ? null : error.code',
  '  process.stdout.write(JSON.stringify({ ok: false, code: typeof code === "string" ? code : null }))',
  '}',
].join('\n')

/**
 * `move` helper: rename, falling back to copy-and-delete across devices.
 *
 * `rename` is the same-device path and keeps every bit of metadata. On `EXDEV`
 * the source is copied to a unique temp name beside the destination and only
 * then renamed into place, so a failed copy never leaves a half-filled
 * destination and an existing destination is never merged into:
 *
 * - `cp` runs with `recursive`, `force:false`, `errorOnExist:true` and
 *   `verbatimSymlinks:true`, so it refuses to write over anything and copies a
 *   symlink as the link itself, not as a copy of its target;
 * - mode, mtime and atime are re-applied explicitly (`chmod`/`utimes`, or
 *   `lutimes` for a link), because `cp` alone does not promise the root entry's
 *   timestamps;
 * - replacing an existing destination (`overwrite`) is a `rename` of the temp
 *   entry, which refuses a non-empty directory instead of merging into it;
 * - any failure removes the temp entry, and the source is removed only after
 *   the destination is in place. A source that cannot be removed after a
 *   successful copy is reported, never hidden.
 *
 * argv is `from`, `to`, `overwrite` (`"1"`/`"0"`); argv only, no shell. On
 * Windows `rename` refuses an existing file, so an overwrite there fails
 * cleanly rather than replacing (documented limitation).
 */
const MOVE_SCRIPT = [
  "const fs = require('node:fs/promises')",
  "const path = require('node:path')",
  "const crypto = require('node:crypto')",
  'function codeOf(error) {',
  '  return error === null || typeof error !== "object" ? undefined : error.code',
  '}',
  'async function preserveMetadata(src, dst) {',
  '  const info = await fs.lstat(src)',
  '  if (info.isSymbolicLink()) {',
  '    await fs.lutimes(dst, info.atime, info.mtime).catch(() => {})',
  '    return',
  '  }',
  '  await fs.chmod(dst, info.mode & 0o7777).catch(() => {})',
  '  await fs.utimes(dst, info.atime, info.mtime).catch(() => {})',
  '}',
  'async function main() {',
  '  const from = process.argv[1]',
  '  const to = process.argv[2]',
  '  const overwrite = process.argv[3] === "1"',
  '  try {',
  '    await fs.rename(from, to)',
  '    process.stdout.write(JSON.stringify({ method: "rename" }))',
  '    return',
  '  } catch (error) {',
  '    if (codeOf(error) !== "EXDEV") throw error',
  '  }',
  '  const temp = path.join(',
  '    path.dirname(to),',
  '    ".z1-move-" + process.pid.toString(36) + "-" + crypto.randomBytes(4).toString("hex"),',
  '  )',
  '  try {',
  '    await fs.cp(from, temp, {',
  '      recursive: true,',
  '      force: false,',
  '      errorOnExist: true,',
  '      preserveTimestamps: true,',
  '      verbatimSymlinks: true,',
  '    })',
  '    await preserveMetadata(from, temp)',
  '    try {',
  '      await fs.lstat(to)',
  '      if (!overwrite) {',
  '        const error = new Error("destination exists: " + to + "; pass overwrite: true")',
  '        error.code = "EEXIST"',
  '        throw error',
  '      }',
  '    } catch (error) {',
  '      if (codeOf(error) !== "ENOENT") throw error',
  '    }',
  '    try {',
  '      await fs.rename(temp, to)',
  '    } catch (error) {',
  '      const code = codeOf(error)',
  '      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EISDIR" || code === "ENOTDIR") {',
  '        const clean = new Error(',
  '          code === "ENOTEMPTY"',
  '            ? "destination directory is not empty; refusing to merge into it"',
  '            : "destination exists and cannot be replaced (" + code + ")",',
  '        )',
  '        clean.code = code',
  '        throw clean',
  '      }',
  '      throw error',
  '    }',
  '    try {',
  '      await fs.rm(from, { recursive: true, force: false })',
  '    } catch (error) {',
  '      const detail = error && error.message ? error.message : String(error)',
  '      const clean = new Error("copied to the destination but could not remove the source: " + detail)',
  '      clean.code = "Z1_SOURCE_LEFT"',
  '      throw clean',
  '    }',
  '    process.stdout.write(JSON.stringify({ method: "copy" }))',
  '  } catch (error) {',
  '    await fs.rm(temp, { recursive: true, force: true }).catch(() => {})',
  '    throw error',
  '  }',
  '}',
  'main().catch((error) => {',
  '  const detail = error && error.message ? error.message : String(error)',
  '  process.stderr.write(detail)',
  '  process.exit(1)',
  '})',
].join('\n')

/**
 * Atomic-write helper.
 *
 * - `probe <target>`: lstat without following, print JSON
 *   `{exists, isFile, mode, nlink, size}`.
 * - `commit <temp> <target> <mode>`: chmod the temp file to `mode` when given
 *   (an empty string keeps the default), then rename it over the target.
 *   A failed rename removes the temp file, so no partial file is left behind
 *   and the target keeps its old bytes.
 * - `abort <temp>`: remove a temp file the broker created but never committed.
 *
 * Rename within one directory is atomic on POSIX. On Windows a rename onto an
 * existing file is refused, so `EEXIST`/`EPERM` fall back to remove-then-rename
 * (not atomic, but the file is still never truncated in place).
 */
const WRITE_SCRIPT = [
  "const fs = require('node:fs/promises')",
  'async function main() {',
  '  const verb = process.argv[1]',
  '  if (verb === "probe") {',
  '    const target = process.argv[2]',
  '    let info = null',
  '    try {',
  '      info = await fs.lstat(target)',
  '    } catch (error) {',
  '      if (error === null || typeof error !== "object" || error.code !== "ENOENT") throw error',
  '    }',
  '    if (info === null) {',
  '      process.stdout.write(JSON.stringify({ exists: false }))',
  '      return',
  '    }',
  '    process.stdout.write(JSON.stringify({',
  '      exists: true,',
  '      isFile: info.isFile(),',
  '      mode: info.mode & 0o7777,',
  '      nlink: info.nlink,',
  '      size: info.size,',
  '    }))',
  '    return',
  '  }',
  '  if (verb === "commit") {',
  '    const temp = process.argv[2]',
  '    const target = process.argv[3]',
  '    const mode = process.argv[4]',
  '    try {',
  '      if (mode !== "") await fs.chmod(temp, Number(mode))',
  '      try {',
  '        await fs.rename(temp, target)',
  '      } catch (error) {',
  '        const code = error === null || typeof error !== "object" ? undefined : error.code',
  '        if (code !== "EEXIST" && code !== "EPERM") throw error',
  '        await fs.rm(target, { force: true })',
  '        await fs.rename(temp, target)',
  '      }',
  '    } catch (error) {',
  '      await fs.rm(temp, { force: true }).catch(() => {})',
  '      throw error',
  '    }',
  '    return',
  '  }',
  '  if (verb === "abort") {',
  '    await fs.rm(process.argv[2], { force: true })',
  '    return',
  '  }',
  '  throw new Error("unknown write helper verb " + verb)',
  '}',
  'main().catch((error) => {',
  '  const detail = error && error.message ? error.message : String(error)',
  '  process.stderr.write(detail)',
  '  process.exit(1)',
  '})',
].join('\n')

/** sha256 of the content `read` returned, keyed by `workspace\0path`. */
const readHashes = new Map()

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Drop a broker's own `cannot read "<path>": ` so the tool's prefix is not doubled. */
function causeDetail(error) {
  const detail = errorMessage(error)
  const match = /^cannot read "[^"]*":\s*/.exec(detail)
  return match === null ? detail : detail.slice(match[0].length)
}

function contentHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function hashKey(ctx, path) {
  return `${workspaceRoot(ctx)}\0${path}`
}

function rememberRead(ctx, path, text) {
  readHashes.set(hashKey(ctx, path), contentHash(text))
}

/** NUL is the binary signal the broker leaves intact; U+FFFD is invalid UTF-8. */
function looksBinary(text) {
  const head = text.slice(0, BINARY_SNIFF_BYTES)
  return head.includes('\0') || head.includes('\uFFFD')
}

/** Every match start; `overlapping` counts `"aa"` twice in `"aaa"`. */
function matchStarts(text, needle, overlapping) {
  const starts = []
  let at = text.indexOf(needle)
  while (at >= 0) {
    starts.push(at)
    at = text.indexOf(needle, at + (overlapping ? 1 : needle.length))
  }
  return starts
}

/**
 * The line ending in force at `index`, taken from the matched span itself when
 * it contains one, else from the nearest newline, else from the whole file.
 * A mixed-ending file therefore keeps every untouched line byte-identical.
 */
function spanEol(text, needle, index) {
  if (needle.includes('\r\n')) return '\r\n'
  if (needle.includes('\n')) return '\n'
  const next = text.indexOf('\n', index)
  if (next > 0) return text[next - 1] === '\r' ? '\r\n' : '\n'
  const previous = text.lastIndexOf('\n', index)
  if (previous > 0) return text[previous - 1] === '\r' ? '\r\n' : '\n'
  return detectEol(text)
}

async function readText(ctx, path, shown) {
  let text
  try {
    text = await ctx.fs.read(path)
  } catch (error) {
    fail(`cannot read "${shown}": ${causeDetail(error)}`)
  }
  return typeof text === 'string' ? text : String(text)
}

/** lstat through the helper, because the broker's `stat` reports no mode or links. */
async function probeTarget(ctx, path, label) {
  const stdout = await runHelper(ctx, WRITE_SCRIPT, ['probe', path], label)
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    fail(`${label}: malformed helper output`)
  }
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.exists !== 'boolean') {
    fail(`${label}: malformed helper output`)
  }
  return {
    exists: parsed.exists,
    isFile: parsed.isFile === true,
    mode: Number.isInteger(parsed.mode) ? parsed.mode : 0,
    nlink: Number.isInteger(parsed.nlink) && parsed.nlink > 0 ? parsed.nlink : 1,
    size: Number.isInteger(parsed.size) ? parsed.size : 0,
  }
}

function formatMode(mode) {
  return (mode & 0o777).toString(8).padStart(3, '0')
}

/** `stat` prints the full permission word, setuid and sticky bits included. */
function formatStatMode(mode) {
  return (mode & 0o7777).toString(8).padStart(4, '0')
}

const PAD = (value, width = 2) => String(value).padStart(width, '0')

/**
 * ISO 8601 instant in local time with its UTC offset:
 * `2026-11-15T16:09:54.553+02:00` (or `+00:00` in UTC). The offset makes the
 * instant unambiguous while the wall clock matches what `ls -l` shows.
 */
function formatTime(ms) {
  if (!Number.isFinite(ms)) return 'unknown-mtime'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return 'unknown-mtime'
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  return (
    `${date.getFullYear()}-${PAD(date.getMonth() + 1)}-${PAD(date.getDate())}` +
    `T${PAD(date.getHours())}:${PAD(date.getMinutes())}:${PAD(date.getSeconds())}` +
    `.${PAD(date.getMilliseconds(), 3)}${sign}${PAD(Math.floor(abs / 60))}:${PAD(abs % 60)}`
  )
}

/** Errno names worth translating; anything else is shown as the code. */
const CODE_TEXT = {
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  ELOOP: 'too many levels of symbolic links',
  ENAMETOOLONG: 'file name too long',
  EIO: 'input/output error',
}

function codeText(code) {
  return CODE_TEXT[code] ?? code
}

/** Drop a broker's own `cannot stat "<path>": ` so the tool's prefix is not doubled. */
function brokerDetail(error) {
  const detail = errorMessage(error)
  const match = /^cannot (?:stat|lstat|read|write|list|open) "[^"]*":\s*/.exec(detail)
  return match === null ? detail : detail.slice(match[0].length)
}

/** One line, bounded: a helper's message is shown, not its whole stack. */
function clipDetail(text, limit = 300) {
  const first = text.split('\n', 1)[0].trim()
  return first.length <= limit ? first : `${first.slice(0, limit)}… (${first.length - limit} chars cut)`
}

/**
 * One path's own metadata (`lstat`), from the helper.
 *
 * Returns `{exists:true, type, kind, size, mtimeMs, mode, nlink, linkTarget,
 * dangling}` or `{exists:false, code}`. When the helper cannot run at all
 * (permission model, spawn failure) the broker's `ctx.fs.stat` is used, which
 * has no mode, link count or link target; `mode`/`nlink` are then `null` and
 * the output simply omits them instead of inventing values.
 */
async function lstatEntry(ctx, path, label) {
  let stdout = null
  try {
    stdout = await runHelper(ctx, STAT_SCRIPT, [path], label)
  } catch {
    stdout = null
  }
  if (stdout !== null) {
    let parsed = null
    try {
      parsed = JSON.parse(stdout)
    } catch {
      parsed = null
    }
    if (isRecord(parsed) && parsed.ok === true && typeof parsed.type === 'string') {
      return {
        exists: true,
        type: parsed.type,
        kind: typeof parsed.kind === 'string' ? parsed.kind : null,
        size: Number.isFinite(parsed.size) ? parsed.size : 0,
        mtimeMs: Number.isFinite(parsed.mtimeMs) ? parsed.mtimeMs : null,
        mode: Number.isInteger(parsed.mode) ? parsed.mode : null,
        nlink: Number.isInteger(parsed.nlink) ? parsed.nlink : null,
        linkTarget: typeof parsed.linkTarget === 'string' ? parsed.linkTarget : null,
        dangling: parsed.dangling === true,
      }
    }
    if (isRecord(parsed) && parsed.ok === false) {
      const code = typeof parsed.code === 'string' ? parsed.code : null
      if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false, code }
      fail(`${label}: ${code === null ? 'the path could not be inspected' : codeText(code)}`)
    }
  }

  try {
    const info = await ctx.fs.stat(path)
    return {
      exists: true,
      type: typeof info.type === 'string' ? info.type : 'other',
      kind: null,
      size: Number.isFinite(info.size) ? info.size : 0,
      mtimeMs: Number.isFinite(info.mtimeMs) ? info.mtimeMs : null,
      mode: null,
      nlink: null,
      linkTarget: null,
      dangling: false,
    }
  } catch (error) {
    const detail = brokerDetail(error)
    if (/ENOENT|ENOTDIR|no such file|not a directory/i.test(detail)) {
      return { exists: false, code: 'ENOENT' }
    }
    fail(`${label}: ${clipDetail(detail)}`)
  }
}

async function abortTemp(ctx, temp, shown) {
  try {
    await runHelper(ctx, WRITE_SCRIPT, ['abort', temp], `cannot clean up after writing "${shown}"`)
  } catch {
    // The temp name is unique per call; a leftover never shadows the target.
  }
}

/**
 * Replace `path` without ever truncating it: temp file next to the target,
 * then rename. Returns a short suffix for the tool's confirmation.
 */
async function writeAtomic(ctx, path, content, shown, state) {
  if (state.exists && state.nlink > 1) {
    // Renaming over a hardlink would leave the other names on the old inode.
    try {
      await ctx.fs.write(path, content)
    } catch (error) {
      fail(`cannot write "${shown}": ${causeDetail(error)}`)
    }
    return ', in place: hardlinked file keeps its other links'
  }

  const directory = dirname(path)
  try {
    await mkdir(directory, { recursive: true })
  } catch (error) {
    fail(`cannot write "${shown}": ${errorMessage(error)}`)
  }

  const temp = join(
    directory,
    `${basename(path)}.z1-tmp-${process.pid.toString(36)}-${randomBytes(4).toString('hex')}`,
  )
  try {
    await ctx.fs.write(temp, content)
  } catch (error) {
    await abortTemp(ctx, temp, shown)
    fail(`cannot write "${shown}": ${causeDetail(error)}`)
  }
  try {
    await runHelper(
      ctx,
      WRITE_SCRIPT,
      ['commit', temp, path, state.exists ? String(state.mode) : ''],
      `cannot write "${shown}"`,
    )
  } catch (error) {
    await abortTemp(ctx, temp, shown)
    throw error
  }

  const kept = state.exists && (state.mode & 0o777) !== 0o644
  return kept ? `, kept mode ${formatMode(state.mode)}` : ''
}

/** Clip one line, reporting how much of it is missing. */
function clipLine(line) {
  if (line.length <= MAX_LINE_CHARS) return { text: line, clipped: 0 }
  return {
    text: line.slice(0, MAX_LINE_CHARS),
    clipped: line.length - MAX_LINE_CHARS,
  }
}

/** Numbered lines within `limit`, `MAX_READ_CHARS` and `MAX_LINE_CHARS`. */
function renderWindow(lines, shown, offset, limit) {
  const total = lines.length
  if (total === 0) return `(no lines: ${shown} is empty)`
  if (offset > total) {
    return `(no lines: ${shown} has ${plural(total, 'line')}; offset ${offset} is past the end)`
  }

  const start = offset - 1
  const end = Math.min(total, start + limit)
  const body = []
  let used = 0
  let clippedLines = 0
  let index = start
  for (; index < end; index += 1) {
    const line = clipLine(lines[index])
    const rendered =
      line.clipped === 0
        ? `${index + 1}| ${line.text}`
        : `${index + 1}| ${line.text} … +${line.clipped} chars`
    if (body.length > 0 && used + rendered.length + 1 > MAX_READ_CHARS) break
    body.push(rendered)
    used += rendered.length + 1
    if (line.clipped > 0) clippedLines += 1
  }

  const text = body.join('\n')
  const notes = []
  if (index < total) {
    notes.push(`… (truncated: lines ${start + 1}-${index} of ${total}; call read with offset=${index + 1})`)
  }
  if (clippedLines > 0) {
    notes.push(
      `… (${plural(clippedLines, 'line')} clipped to ${MAX_LINE_CHARS} chars; use shell sed -n for the full line)`,
    )
  }
  return notes.length === 0 ? text : `${text}\n${notes.join('\n')}`
}

export async function readTool(ctx, raw) {
  const path = await resolvePath(ctx, raw['path'], 'read.path')
  const shown = displayPath(ctx, path)
  const offset = positiveInteger(raw, 'offset', 'read') ?? 1
  const limit = positiveInteger(raw, 'limit', 'read', MAX_READ_LINES) ?? MAX_READ_LINES

  // Guard before loading: a huge file or a binary is refused by metadata only.
  let info
  try {
    info = await ctx.fs.stat(path)
  } catch (error) {
    fail(`cannot read "${shown}": ${causeDetail(error)}`)
  }
  if (info.type === 'file' && info.size > MAX_READ_BYTES) {
    fail(`cannot read "${shown}": file is ${info.size} bytes, over the ${MAX_READ_BYTES}-byte cap; use shell sed -n`)
  }

  const text = await readText(ctx, path, shown)
  if (text.slice(0, BINARY_SNIFF_BYTES).includes('\0')) {
    fail(`cannot read "${shown}": binary file: ${shown}`)
  }

  // The model has now seen this content, so a `write` may replace it.
  rememberRead(ctx, path, text)
  return renderWindow(splitLines(text), shown, offset, limit)
}

export async function writeTool(ctx, raw) {
  const path = await resolvePath(ctx, raw['path'], 'write.path')
  await refuseSessionStorePath(ctx, path, 'write')
  const content = raw['content']
  if (typeof content !== 'string') fail('write.content must be a string')
  const shown = displayPath(ctx, path)
  const bytes = byteLength(content)
  const label = `cannot write "${shown}"`

  const state = await probeTarget(ctx, path, label)
  if (state.exists && !state.isFile) {
    fail(`${label}: target exists and is not a regular file`)
  }
  if (state.exists) {
    if (state.size > MAX_READ_BYTES) {
      fail(`${label}: file is ${state.size} bytes, over the ${MAX_READ_BYTES}-byte cap; move it aside instead`)
    }
    const expected = readHashes.get(hashKey(ctx, path))
    if (expected === undefined) {
      fail(`write: read "${shown}" before overwriting it`)
    }
    const current = await readText(ctx, path, shown)
    if (looksBinary(current)) {
      fail(`write: "${shown}" is binary; read cannot verify it (move it aside, then write)`)
    }
    if (contentHash(current) !== expected) {
      fail(`write: "${shown}" changed since read; read it again before overwriting it`)
    }
  }

  const outcome = await writeAtomic(ctx, path, content, shown, state)
  rememberRead(ctx, path, content)
  return `wrote ${shown} (${bytes} bytes${outcome})`
}

/**
 * Read one of two accepted keys. `edit` also takes Claude Code's
 * `old_string` / `new_string`, so a prompt written for another harness works
 * without renaming; the canonical key wins and the error names both.
 */
function aliasedArg(raw, key, alias, allowEmpty) {
  const canonical = raw[key]
  const alternate = raw[alias]
  if (canonical !== undefined && alternate !== undefined && canonical !== alternate) {
    fail(`edit: pass either "${key}" or its alias "${alias}", not both`)
  }
  const value = canonical === undefined ? alternate : canonical
  if (value === undefined) fail(`edit: "${key}" is required (also accepted: "${alias}")`)
  if (typeof value !== 'string') fail(`edit: "${key}" must be a string (also accepted: "${alias}")`)
  if (!allowEmpty && value.length === 0) fail(`edit: "${key}" must be a non-empty string`)
  return value
}

export async function editTool(ctx, raw) {
  const path = await resolvePath(ctx, raw['path'], 'edit.path')
  await refuseSessionStorePath(ctx, path, 'edit')
  const oldText = aliasedArg(raw, 'oldText', 'old_string', false)
  const newText = aliasedArg(raw, 'newText', 'new_string', true)
  const replaceAll = optionalBoolean(raw, 'replaceAll', 'edit') === true
  const shown = displayPath(ctx, path)
  const label = `cannot edit "${shown}"`

  if (oldText.trim() === '') {
    fail('edit: oldText is whitespace-only; include some of the surrounding text')
  }

  let info
  try {
    info = await ctx.fs.stat(path)
  } catch (error) {
    fail(`cannot read "${shown}": ${causeDetail(error)}`)
  }
  if (info.type === 'file' && info.size > MAX_READ_BYTES) {
    fail(`${label}: file is ${info.size} bytes, over the ${MAX_READ_BYTES}-byte cap`)
  }

  const before = await readText(ctx, path, shown)
  // The broker decoded the file as UTF-8 before we saw it, so invalid bytes
  // arrive as U+FFFD and cannot be re-encoded; a NUL means a binary file. Both
  // are refused before any edit, which also means a UTF-8 file that genuinely
  // contains U+FFFD (already damaged, or a deliberate sentinel) is refused:
  // rewrite such a file with `write` rather than `edit`.
  if (looksBinary(before)) {
    fail(`${label}: binary file (NUL or U+FFFD in the first 8 KiB); edit never re-encodes it`)
  }

  // Match the text as given first, then in the file's own line-ending style, so
  // a block copied from a CRLF file works and one pasted from a LF tool works.
  const eol = detectEol(before)
  let needle = oldText
  let starts = matchStarts(before, needle, true)
  if (starts.length === 0) {
    needle = toEol(oldText, eol)
    starts = matchStarts(before, needle, true)
  }
  if (starts.length === 0) {
    fail(`edit: "${excerpt(oldText)}" does not occur in ${shown}`)
  }
  // Overlaps count for uniqueness: "aa" twice in "aaa" means an ambiguous edit.
  // `replaceAll` then replaces the non-overlapping matches, as split/join would.
  if (starts.length > 1 && !replaceAll) {
    fail(
      `edit: "${excerpt(oldText)}" occurs ${plural(starts.length, 'time')} in ${shown}; ` +
        'pass replaceAll: true to replace every occurrence',
    )
  }

  const targets = replaceAll ? matchStarts(before, needle, false) : [starts[0]]
  let after = before
  for (let at = targets.length - 1; at >= 0; at -= 1) {
    const index = targets[at]
    const replacement = toEol(newText, spanEol(before, needle, index))
    after = after.slice(0, index) + replacement + after.slice(index + needle.length)
  }

  if (after === before) {
    return `no change: ${shown} (the replacement text is identical)`
  }

  const beforeHash = contentHash(before)
  const state = await probeTarget(ctx, path, label)
  if (state.exists && !state.isFile) {
    fail(`${label}: target is not a regular file`)
  }
  const current = await readText(ctx, path, shown)
  if (contentHash(current) !== beforeHash) {
    fail(`edit: "${shown}" changed during edit; re-read it and retry`)
  }

  const outcome = await writeAtomic(ctx, path, after, shown, state)
  rememberRead(ctx, path, after)
  return `edited ${shown} (${plural(targets.length, 'replacement')}${outcome})`
}

/**
 * Report one directory entry as `type size mtime [mode] [nlink=N] path`.
 *
 * The path is the one the model named (lexical: the parent is resolved, the
 * last component is not), so a symlink reports itself plus `-> target` and its
 * own size, and a broken link is a link with `(dangling)`, never "missing".
 * `type` is `file`, `dir`, `symlink` or `other`; the kind of a special file
 * (`fifo`, `socket`, `chardev`, `blockdev`) follows the path in parentheses.
 * A directory reports its real `lstat` size, not 0.
 */
export async function statTool(ctx, raw) {
  const path = await resolveLexicalPath(ctx, raw['path'], 'stat.path')
  const shown = displayPath(ctx, path)
  const label = `cannot stat "${shown}"`
  const entry = await lstatEntry(ctx, path, label)
  if (!entry.exists) {
    const reason = entry.code === 'ENOTDIR' ? 'a parent component is not a directory' : 'no such file or directory'
    fail(`${label}: ${reason}`)
  }

  const parts = [entry.type, String(entry.size), formatTime(entry.mtimeMs)]
  if (entry.mode !== null) parts.push(formatStatMode(entry.mode))
  if (entry.nlink !== null && entry.nlink > 1) parts.push(`nlink=${entry.nlink}`)
  let line = `${parts.join(' ')} ${shown}`
  if (entry.type === 'symlink' && entry.linkTarget !== null) {
    line += ` -> ${entry.linkTarget}`
    if (entry.dangling) line += ' (dangling)'
  }
  if (entry.kind !== null) line += ` (${entry.kind})`
  return line
}

/**
 * Create a directory (`recursive` defaults to true, `mode` as an integer).
 *
 * An existing directory is success (it says so); an existing file, FIFO or
 * device is refused. With `recursive:false` the parent must already exist, so
 * a typo cannot silently create a chain of directories.
 *
 * Order: resolve and contain the lexical path, check the parent is inside the
 * workspace, look at the target, then create. The containment re-check happens
 * immediately before `mkdir`, but the check and the create are still two
 * syscalls: a parent swapped for a symlink between them can redirect the
 * create (a TOCTOU window no Node API closes). A failure after the check is
 * reported with its errno rather than assumed to have been impossible.
 */
export async function mkdirTool(ctx, raw) {
  const path = await resolveLexicalPath(ctx, raw['path'], 'mkdir.path')
  await refuseSessionStorePath(ctx, path, 'mkdir')
  const shown = displayPath(ctx, path)
  const label = `cannot create "${shown}"`
  const recursive = optionalBoolean(raw, 'recursive', 'mkdir') ?? true
  const mode = optionalInteger(raw, 'mode', 'mkdir', 0, 0o7777)

  const parent = dirname(path)
  // The workspace root's own parent is outside it, so re-check the target, not
  // its parent; the parent was already resolved and contained above.
  if (!insideWorkspace(workspaceRoot(ctx), path)) {
    fail(`path escapes workspace: ${shown}`)
  }
  if (path !== workspaceRoot(ctx) && !insideWorkspace(workspaceRoot(ctx), parent)) {
    fail(`path escapes workspace: ${shown}`)
  }

  const current = await lstatEntry(ctx, path, label)
  if (current.exists) {
    if (current.type === 'dir') return `exists ${shown} (directory)`
    // A symlink is left to mkdir: it decides from the target, and a link to a
    // directory is an existing directory (recursive mkdir accepts it).
    if (current.type !== 'symlink') fail(`${label}: target exists and is not a directory`)
  }

  try {
    await mkdir(path, recursive ? { recursive: true, mode } : { mode })
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code === 'EEXIST' || (code === 'ENOTDIR' && current.exists)) {
      fail(`${label}: target exists and is not a directory`)
    }
    if (code === 'ENOTDIR') {
      fail(`${label}: a parent of "${shown}" is not a directory`)
    }
    if (code === 'ENOENT') {
      fail(`${label}: parent directory does not exist (pass recursive: true to create it)`)
    }
    fail(`${label}: ${clipDetail(errorMessage(error))}`)
  }

  if (current.exists) return `exists ${shown} (directory)`
  return `created ${shown}${mode === undefined ? '' : ` with mode ${formatStatMode(mode)}`}`
}

/** Rewrite absolute helper paths back to the display names the model used. */
function rewritePaths(text, pairs) {
  let out = text
  for (const [absolute, shown] of pairs) out = out.split(absolute).join(shown)
  return out
}

/**
 * Move or rename one entry, the entry the model named (a symlink moves as the
 * link, not as its target).
 *
 * A destination that already exists needs `overwrite: true`: replacing a file
 * is destructive and never implied. The source is validated first, so a
 * missing source never creates the destination parent. A move into the
 * destination's own subtree is refused before the helper runs (the kernel
 * would also refuse it with `EINVAL`). Different devices fall back to a copy
 * plus delete inside the helper, which never merges into an existing
 * directory.
 */
export async function moveTool(ctx, raw) {
  const from = await resolveLexicalPath(ctx, raw['from'], 'move.from')
  await refuseSessionStorePath(ctx, from, 'move')
  const to = await resolveLexicalPath(ctx, raw['to'], 'move.to')
  await refuseSessionStorePath(ctx, to, 'move')
  const shownFrom = displayPath(ctx, from)
  const shownTo = displayPath(ctx, to)
  const label = `cannot move "${shownFrom}" to "${shownTo}"`
  const overwrite = optionalBoolean(raw, 'overwrite', 'move') === true

  if (from === to) {
    fail(`move: "${shownFrom}" and "${shownTo}" are the same path; nothing to move`)
  }
  if (to.startsWith(from + sep)) {
    fail(`move: cannot move "${shownFrom}" into its own subtree ("${shownTo}")`)
  }

  const source = await lstatEntry(ctx, from, label)
  if (!source.exists) fail(`cannot move "${shownFrom}": no such file or directory`)

  const destination = await lstatEntry(ctx, to, label)
  if (destination.exists && !overwrite) {
    fail(`${label}: destination exists: "${shownTo}"; pass overwrite: true to replace it`)
  }

  const parent = dirname(to)
  if (!insideWorkspace(workspaceRoot(ctx), to)) fail(`path escapes workspace: ${shownTo}`)
  if (!insideWorkspace(workspaceRoot(ctx), parent)) fail(`path escapes workspace: ${shownTo}`)
  try {
    await mkdir(parent, { recursive: true })
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code === 'ENOTDIR' || code === 'EEXIST') {
      fail(`${label}: a parent of "${shownTo}" is not a directory`)
    }
    fail(`${label}: ${clipDetail(errorMessage(error))}`)
  }

  const result = await runHelperResult(ctx, MOVE_SCRIPT, [from, to, overwrite ? '1' : '0'], label)
  if (result.code !== 0) {
    const raw = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    // The helper speaks in absolute paths; report the names the model used.
    const pairs = from.length >= to.length
      ? [[from, shownFrom], [to, shownTo]]
      : [[to, shownTo], [from, shownFrom]]
    if (raw.includes('ENOTEMPTY')) {
      fail(`${label}: destination directory is not empty; refusing to merge into it`)
    }
    if (/EISDIR|EEXIST|ENOTDIR/.test(raw)) {
      fail(`${label}: destination exists and cannot be replaced`)
    }
    fail(`${label}: ${clipDetail(rewritePaths(raw, pairs))}`)
  }

  let method = 'rename'
  try {
    const parsed = JSON.parse(result.stdout)
    if (isRecord(parsed) && parsed.method === 'copy') method = 'copy'
  } catch {
    method = 'rename'
  }
  const note = method === 'copy' ? ' (copied across devices)' : ''
  if (destination.exists) return `moved ${shownFrom} -> ${shownTo}${note}, replaced the previous entry`
  return `moved ${shownFrom} -> ${shownTo}${note}`
}
