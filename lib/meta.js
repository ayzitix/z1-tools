/**
 * Metadata tools: `system.info` and the workspace todo list.
 *
 * The todo list is plain JSON at `.z1/todos.json` in the workspace, so it can
 * be inspected, diffed and deleted with ordinary tools. On disk the shape is
 * unchanged: `{ "items": [{ "text": string, "status": "pending" | "in_progress"
 * | "done" }] }`.
 *
 * The path goes through `resolvePath` like every other path a tool accepts, so
 * a `.z1` directory or `todos.json` symlinked outside the workspace is refused
 * (`path escapes workspace`) instead of read or overwritten.
 *
 * Writes replace the file atomically: the broker writes a sibling temp file,
 * a one-shot helper chmods it to 0600 and renames it over the target, and a
 * failed rename removes the temp. A crash therefore leaves the previous list
 * intact instead of a truncated JSON document.
 *
 * Reads validate and bound what they return: at most 500 items, 2000
 * characters of text per item and 64 KiB of output, with an explicit
 * `… (truncated …)` line. Items are normalised (`status` restricted to the
 * three known values, empty text dropped) and rendered one line per item —
 * `[ ] 1. text` — because pretty-printed JSON cost about twice the tokens for
 * the same list. Terminal control characters, C0/C1, bidi overrides and
 * zero-width marks are escaped (`\u001b`, `\u202e`), so a hand-edited todo
 * cannot inject terminal control into a tool result.
 *
 * A missing, 0-byte or whitespace-only file reads as "no todos"; invalid JSON
 * is a one-line error naming the file and its size, never a dump of it.
 * Unknown top-level keys and unknown item keys are not preserved: a read then
 * `todo.write` round trip keeps `text` and `status` only. That is documented
 * here for the schema agent.
 *
 * `system.info` stays secret-free: it never reads the environment except
 * `SHELL` / `ComSpec` (for the shell dialect) and reports no user, host or
 * variable values.
 *
 * @module z1-tools/meta
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { release as osRelease } from 'node:os'

import { fail, isRecord } from './args.js'
import { runHelper } from './host.js'
import { displayPath, resolvePath } from './paths.js'
import { byteLength, plural } from './text.js'

export const TODO_PATH = '.z1/todos.json'
export const TODO_STATUSES = ['pending', 'in_progress', 'done']

/** Items and characters one todo document may hold. */
const MAX_TODO_ITEMS = 500
const MAX_TODO_TEXT = 2000
/** Largest document `todo.read` will load; above this only `todo.write` may replace it. */
const MAX_TODO_FILE_BYTES = 2 * 1024 * 1024
/** Characters one `todo.read` result may contain. */
const MAX_TODO_OUTPUT_BYTES = 64 * 1024
const TODO_FILE_MODE = 0o600
const TODO_DIR_MODE = 0o700

/** Marker per status; unknown statuses are read as `pending`. */
const STATUS_MARK = { pending: '[ ]', in_progress: '[~]', done: '[x]' }

/** Characters that would break the one-line format or drive a terminal. */
const UNSAFE_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** One-line, terminal-safe rendering of any string. */
function safe(text) {
  return String(text).replace(
    UNSAFE_CHARS,
    (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`,
  )
}

/** Clip display text, saying how much was dropped. */
function clip(text, maximum) {
  return text.length <= maximum ? text : `${text.slice(0, maximum)}… (+${text.length - maximum} chars)`
}

function contentHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** sha256 of the list this process last read or wrote, keyed by real path. */
const seenHashes = new Map()

/**
 * `todo.write` helper.
 *
 * - `commit <temp> <target>`: chmod the temp to 0600, then rename it over the
 *   target. A failed rename removes the temp and leaves the old file intact.
 * - `abort <temp>`: remove a temp the broker created but never committed.
 * - `harden <dir>`: chmod a freshly created `.z1` to 0700 (best effort).
 *
 * Rename within one directory is atomic on POSIX. On Windows a rename onto an
 * existing file is refused, so `EEXIST`/`EPERM` fall back to remove-then-rename:
 * the file is still never truncated in place.
 */
const TODO_WRITE_SCRIPT = [
  "const fs = require('node:fs/promises')",
  'async function main() {',
  '  const verb = process.argv[1]',
  '  if (verb === "commit") {',
  '    const temp = process.argv[2]',
  '    const target = process.argv[3]',
  '    try {',
  '      await fs.chmod(temp, 384)',
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
  '  if (verb === "harden") {',
  '    await fs.chmod(process.argv[2], 448)',
  '    return',
  '  }',
  '  throw new Error("unknown todo helper verb " + verb)',
  '}',
  'main().catch((error) => {',
  '  const detail = error && error.message ? error.message : String(error)',
  '  process.stderr.write(detail)',
  '  process.exit(1)',
  '})',
].join('\n')

/* ------------------------------------------------------------------ */
/* system.info                                                         */
/* ------------------------------------------------------------------ */

const PLATFORM_NAMES = {
  aix: 'AIX',
  android: 'Android',
  darwin: 'macOS',
  freebsd: 'FreeBSD',
  linux: 'Linux',
  netbsd: 'NetBSD',
  openbsd: 'OpenBSD',
  sunos: 'SunOS',
  win32: 'Windows',
}

const POSIX_SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'busybox', 'csh', 'tcsh']

/** `bash` -> POSIX, `pwsh` -> PowerShell, `cmd` -> cmd.exe. */
function shellDialect(path) {
  const name = basename(path)
    .toLowerCase()
    .replace(/\.exe$/, '')
  if (name === 'fish') return 'fish'
  if (name === 'pwsh' || name === 'powershell') return 'PowerShell'
  if (name === 'cmd') return 'cmd.exe'
  return POSIX_SHELLS.includes(name) ? 'POSIX' : 'unknown dialect'
}

/** Best effort: `SHELL` on POSIX, `ComSpec` on Windows, never more of the environment. */
function shellLine() {
  const fallback = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  const raw = process.platform === 'win32' ? (process.env.ComSpec ?? process.env.SHELL) : process.env.SHELL
  const value = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
  if (value === null) return `shell ${fallback} (${shellDialect(fallback)}, assumed)`
  return `shell ${clip(safe(value), 80)} (${shellDialect(value)})`
}

function offsetLabel(date) {
  const minutes = -date.getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const rest = String(absolute % 60).padStart(2, '0')
  return `UTC${sign}${hours}:${rest}`
}

/** ISO timestamp in UTC plus the wall-clock zone, e.g. `…Z (Europe/Kyiv UTC+02:00)`. */
function nowLine() {
  const now = new Date()
  let zone = ''
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  } catch {
    zone = ''
  }
  const label = zone === '' ? offsetLabel(now) : `${safe(zone)} ${offsetLabel(now)}`
  return `now ${now.toISOString().replace(/\.\d{3}Z$/, 'Z')} (${clip(label, 48)})`
}

/** Variables that could point git at a different repository or index. */
const SCRUBBED_GIT_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]

function gitEnv() {
  const env = { ...process.env }
  for (const key of SCRUBBED_GIT_ENV) delete env[key]
  return env
}

const INFO_TIMEOUT_MS = 2_500

/** One git argv; retried without `env` for brokers that reject unknown fields. */
async function runGitInfo(ctx, workspace, args) {
  const request = {
    command: 'git',
    args: ['-C', workspace, '--no-optional-locks', ...args],
    cwd: workspace,
    timeoutMs: INFO_TIMEOUT_MS,
  }
  try {
    return await ctx.process.run({ ...request, env: gitEnv() })
  } catch (error) {
    if (!/\benv\b/i.test(errorMessage(error))) throw error
    return ctx.process.run(request)
  }
}

function stdoutLines(result) {
  const text = typeof result.stdout === 'string' ? result.stdout : ''
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** First non-empty stderr line, never a multi-line usage dump. */
function firstLine(result) {
  const text = typeof result.stderr === 'string' ? result.stderr : ''
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** `git main`, `git main @ /repo/root`, `git detached @ /repo/root`, `git (not a repo)`. */
async function gitLine(ctx, workspace) {
  if (ctx.process === undefined || ctx.process === null || typeof ctx.process.run !== 'function') {
    return 'git (unavailable)'
  }
  try {
    const result = await runGitInfo(ctx, workspace, [
      'rev-parse',
      '--show-toplevel',
      '--abbrev-ref',
      'HEAD',
    ])
    const lines = stdoutLines(result)
    const root = lines.length > 0 && isAbsolute(lines[0]) ? lines[0] : null
    if (root === null) {
      const detail = firstLine(result)
      if (/not a git repository/i.test(detail)) return 'git (not a repo)'
      if (detail === '') {
        const status = result.signal
          ? `killed ${result.signal}`
          : `exit ${result.code === null ? 'null' : result.code}`
        return `git (${status})`
      }
      if (/ENOENT|not found/i.test(detail)) return 'git (unavailable)'
      return `git (${clip(safe(detail), 60)})`
    }

    let branch = result.code === 0 && lines.length > 1 ? lines[1] : null
    if (branch === null) {
      // No commit yet: `rev-parse HEAD` fails, `symbolic-ref` still knows the branch.
      const symbolic = await runGitInfo(ctx, workspace, ['symbolic-ref', '--short', '-q', 'HEAD'])
      const value = stdoutLines(symbolic).join('')
      if (symbolic.code === 0 && value !== '') branch = value
    }
    const label = branch === null ? 'detached' : branch === 'HEAD' ? 'detached' : safe(clip(branch, 60))
    const rootIsWorkspace = resolve(root) === resolve(workspace)
    return rootIsWorkspace ? `git ${label}` : `git ${label} @ ${clip(safe(root), 80)}`
  } catch (error) {
    const detail = errorMessage(error)
    if (/ENOENT|not found/i.test(detail)) return 'git (unavailable)'
    return `git (${clip(safe(detail), 60)})`
  }
}

/** `" (missing)"` when the brokered stat says the workspace is gone. */
async function missingNote(ctx, workspace) {
  if (ctx.fs === undefined || ctx.fs === null || typeof ctx.fs.stat !== 'function') return ''
  try {
    await ctx.fs.stat(workspace)
    return ''
  } catch (error) {
    return errorMessage(error).includes('ENOENT') ? ' (missing)' : ''
  }
}

/**
 * Runtime facts a model asks about, one flat `key value` line each, under 300
 * characters: OS, Node, shell dialect, timestamp with zone, workspace and the
 * git root/branch when there is one. Never user, host or environment values.
 */
export async function systemInfo(ctx) {
  const workspace =
    ctx !== null && typeof ctx === 'object' && typeof ctx.workspace === 'string' && ctx.workspace !== ''
      ? resolve(ctx.workspace)
      : null

  const lines = [
    `os ${PLATFORM_NAMES[process.platform] ?? process.platform} ${osRelease()} (${process.arch})`,
    `node ${process.version}`,
    shellLine(),
    nowLine(),
  ]
  if (workspace === null) {
    lines.push('workspace (unset)')
    return lines.join('\n')
  }
  lines.push(`workspace ${clip(safe(workspace), 120)}${await missingNote(ctx, workspace)}`)
  lines.push(await gitLine(ctx, workspace))
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* todo list                                                           */
/* ------------------------------------------------------------------ */

/**
 * The raw file, or `null` when it does not exist (or vanished between the
 * stat and the read). `tolerateOversize` returns `{ text: null, size }` instead
 * of failing, so `todo.write` can replace a file too big to read.
 */
async function readRaw(ctx, path, tolerateOversize = false) {
  let info
  try {
    info = await ctx.fs.stat(path)
  } catch (error) {
    if (errorMessage(error).includes('ENOENT')) return null
    fail(`todo: cannot stat "${TODO_PATH}": ${errorMessage(error)}`)
  }
  if (info.type !== 'file') {
    fail(`todo: "${TODO_PATH}" is not a regular file (${info.type})`)
  }
  if (info.size > MAX_TODO_FILE_BYTES) {
    if (!tolerateOversize) {
      fail(
        `todo: "${TODO_PATH}" is ${info.size} bytes, over the ${MAX_TODO_FILE_BYTES}-byte cap; ` +
          'delete it or replace it with todo.write',
      )
    }
    return { text: null, size: info.size }
  }
  try {
    const text = await ctx.fs.read(path)
    return { text: typeof text === 'string' ? text : String(text), size: info.size }
  } catch (error) {
    if (!tolerateOversize && errorMessage(error).includes('ENOENT')) return null
    fail(`todo: cannot read "${TODO_PATH}": ${errorMessage(error)}`)
  }
}

/** Write-side validation: strict, with caps, before anything is touched. */
function normalizeItems(raw) {
  const items = raw['items']
  if (!Array.isArray(items)) fail('todo.write.items must be an array')
  if (items.length > MAX_TODO_ITEMS) {
    fail(
      `todo.write.items has ${items.length} items, over the ${MAX_TODO_ITEMS}-item cap; ` +
        'split the work or drop finished items',
    )
  }
  return items.map((item, index) => {
    const where = `todo.write.items[${index}]`
    if (!isRecord(item)) fail(`${where} must be an object`)
    const text = item['text']
    if (typeof text !== 'string' || text.trim().length === 0) {
      fail(`${where}.text must be a non-empty string`)
    }
    if (text.length > MAX_TODO_TEXT) {
      fail(`${where}.text is ${text.length} characters, over the ${MAX_TODO_TEXT}-character cap`)
    }
    const status = item['status'] ?? 'pending'
    if (typeof status !== 'string' || !TODO_STATUSES.includes(status)) {
      fail(`${where}.status must be one of ${TODO_STATUSES.join(', ')}`)
    }
    return { text, status }
  })
}

/**
 * Read-side validation: never throws for bad items. Unknown statuses become
 * `pending`, empty/non-object items are skipped, long text is clipped; each
 * case is reported by index so the model knows the list needs a rewrite.
 */
function normalizeReadItems(rawItems) {
  const items = []
  const skipped = []
  const unknownStatus = []
  let clippedText = 0
  for (let index = 0; index < rawItems.length; index += 1) {
    const item = rawItems[index]
    if (!isRecord(item)) {
      skipped.push(index + 1)
      continue
    }
    const text = item['text']
    if (typeof text !== 'string' || text.trim().length === 0) {
      skipped.push(index + 1)
      continue
    }
    let value = text
    if (value.length > MAX_TODO_TEXT) {
      value = value.slice(0, MAX_TODO_TEXT)
      clippedText += 1
    }
    let status = item['status'] ?? 'pending'
    if (typeof status !== 'string' || !TODO_STATUSES.includes(status)) {
      unknownStatus.push(index + 1)
      status = 'pending'
    }
    items.push({ text: value, status })
  }
  return { items, skipped, unknownStatus, clippedText }
}

/** `1, 2, 3` for at most `limit` indices, then `…`. */
function indexList(indices, limit = 8) {
  const shown = indices.slice(0, limit).join(', ')
  return indices.length <= limit ? shown : `${shown}, …`
}

function renderTodos(items, notes) {
  const counts = { pending: 0, in_progress: 0, done: 0 }
  for (const item of items) counts[item.status] += 1
  if (items.length === 0 && notes.length === 0) return `no todos (${TODO_PATH})`

  const lines = [
    `todos ${plural(items.length, 'item')}: ` +
      `${counts.pending} pending, ${counts.in_progress} in_progress, ${counts.done} done`,
    ...notes,
  ]
  if (items.length === 0) return lines.join('\n')

  const shownLimit = Math.min(items.length, MAX_TODO_ITEMS)
  let used = byteLength(lines.join('\n'))
  let shown = 0
  for (; shown < shownLimit; shown += 1) {
    const item = items[shown]
    const line = `${STATUS_MARK[item.status]} ${shown + 1}. ${clip(safe(item.text), MAX_TODO_TEXT)}`
    const size = byteLength(line) + 1
    if (shown > 0 && used + size > MAX_TODO_OUTPUT_BYTES) break
    lines.push(line)
    used += size
  }
  if (shown < items.length) {
    const why =
      shown < shownLimit
        ? `output capped at ${Math.round(MAX_TODO_OUTPUT_BYTES / 1024)} KiB`
        : `item cap ${MAX_TODO_ITEMS}`
    lines.push(`… (truncated: items 1-${shown} of ${items.length}; ${why}; rewrite with todo.write to trim)`)
  }
  return lines.join('\n')
}

/**
 * Read the list as one line per item, bounded and validated.
 *
 * Missing, empty and whitespace-only files read as "no todos"; invalid JSON is
 * a one-line error; unknown item keys are dropped (see the module note).
 */
export async function todoRead(ctx) {
  const path = await resolvePath(ctx, TODO_PATH, 'todo.read path')
  const file = await readRaw(ctx, path)
  if (file === null || file.text.trim() === '') return `no todos (${TODO_PATH})`

  let parsed
  try {
    parsed = JSON.parse(file.text)
  } catch (error) {
    // The parser quotes the document in its message; keep only the position,
    // so a malformed 2 MB file cannot paste itself into a tool result.
    const at = /at position (\d+)/.exec(errorMessage(error))
    const lineColumn = /at line (\d+) column (\d+)/.exec(errorMessage(error))
    const where = at === null ? (lineColumn === null ? '' : ` at line ${lineColumn[1]} column ${lineColumn[2]}`) : ` at position ${at[1]}`
    fail(`${TODO_PATH} is not valid JSON (${file.size} bytes${where}); fix it or replace it with todo.write`)
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['items'])) {
    fail(`${TODO_PATH} must be an object with an "items" array`)
  }

  const { items, skipped, unknownStatus, clippedText } = normalizeReadItems(parsed['items'])
  seenHashes.set(path, contentHash(file.text))

  const notes = []
  if (skipped.length > 0) {
    notes.push(`! skipped items ${indexList(skipped)} (not an object, or empty text)`)
  }
  if (unknownStatus.length > 0) {
    notes.push(`! unknown status on items ${indexList(unknownStatus)} (read as pending)`)
  }
  if (clippedText > 0) {
    notes.push(`! ${plural(clippedText, 'item')} clipped to ${MAX_TODO_TEXT} characters`)
  }
  return renderTodos(items, notes)
}

async function abortTemp(ctx, temp) {
  try {
    await runHelper(ctx, TODO_WRITE_SCRIPT, ['abort', temp], `cannot clean up "${TODO_PATH}"`)
  } catch {
    // The temp name is unique per call; a leftover never shadows the target.
  }
}

/**
 * Replace `path` without ever truncating it: sibling temp through the broker,
 * chmod 0600 + rename through the helper, temp removed on failure. `.z1` is
 * created 0700 when it did not exist.
 */
async function writeAtomic(ctx, path, content) {
  const directory = dirname(path)
  const label = `cannot write "${TODO_PATH}"`

  let directoryExists = true
  try {
    await ctx.fs.stat(directory)
  } catch {
    directoryExists = false
  }
  try {
    await mkdir(directory, { recursive: true, mode: TODO_DIR_MODE })
  } catch (error) {
    fail(`${label}: ${errorMessage(error)}`)
  }
  if (!directoryExists) {
    try {
      await runHelper(ctx, TODO_WRITE_SCRIPT, ['harden', directory], label)
    } catch {
      // Mode is a hardening step; a failure here must not cost the write.
    }
  }

  const temp = join(
    directory,
    `${basename(path)}.z1-tmp-${process.pid.toString(36)}-${randomBytes(4).toString('hex')}`,
  )
  try {
    await ctx.fs.write(temp, content)
  } catch (error) {
    await abortTemp(ctx, temp)
    fail(`${label}: ${errorMessage(error)}`)
  }
  try {
    await runHelper(ctx, TODO_WRITE_SCRIPT, ['commit', temp, path], label)
  } catch (error) {
    await abortTemp(ctx, temp)
    throw error
  }
}

/** How many items the previous file held, when it can be counted cheaply. */
function previousCount(file) {
  if (file === null) return 'created'
  if (file.text === null) return `replaced a ${file.size}-byte file`
  try {
    const parsed = JSON.parse(file.text)
    if (isRecord(parsed) && Array.isArray(parsed['items'])) {
      return `replaced ${parsed['items'].length}`
    }
  } catch {
    // Falls through to the unreadable note below.
  }
  return 'replaced an unreadable file'
}

/**
 * Replace the whole list and confirm with a one-line summary.
 *
 * Caps: 500 items and 2000 characters of text per item. If this process read
 * the list and it changed since (another session, a hand edit), the write is
 * refused until `todo.read` is called again — the read-modify-write loop is
 * protected without adding a schema field.
 */
export async function todoWrite(ctx, raw) {
  const items = normalizeItems(raw)
  const path = await resolvePath(ctx, TODO_PATH, 'todo.write path')
  const file = await readRaw(ctx, path, true)

  if (file !== null && file.text !== null) {
    const expected = seenHashes.get(path)
    if (expected !== undefined && contentHash(file.text) !== expected) {
      fail(`todo.write: "${TODO_PATH}" changed since todo.read; read it again before replacing it`)
    }
  }

  const content = `${JSON.stringify({ items }, null, 2)}\n`
  await writeAtomic(ctx, path, content)
  seenHashes.set(path, contentHash(content))

  const shown = displayPath(ctx, path)
  return `wrote ${shown} (${plural(items.length, 'item')}, ${previousCount(file)}) — read it with todo.read`
}
