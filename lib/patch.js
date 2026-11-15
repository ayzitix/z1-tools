/**
 * `apply_patch`: a SEARCH/REPLACE patch of one or more files.
 *
 * Each block names a file, then quotes the exact text to find and its
 * replacement:
 *
 * ```text
 * src/app.js
 * <<<<<<< SEARCH
 * const port = 3000
 * =======
 * const port = 8080
 * >>>>>>> REPLACE
 * ```
 *
 * Every SEARCH block must match exactly once in the *original* text (in LF or
 * in the file's own line-ending style). All matches are located against the
 * original file and then written in one pass, so a later block can never match
 * text an earlier block inserted. A single mismatch aborts the whole patch:
 * changed files are written to a temporary file next to each original and then
 * renamed into place by one helper child, so a failure while writing or
 * renaming restores every original (bytes, mode and mtime).
 *
 * Safety rules that are part of the contract:
 *
 * - a target whose text looks binary (a NUL in the first 8 KiB, or U+FFFD from
 *   a non-UTF-8 decode) is refused, never re-encoded;
 * - the mode of an existing file is copied onto the replacement, so a 0755
 *   script stays executable;
 * - a hardlinked target (`nlink > 1`) is renamed like any other file by
 *   default, which breaks the other links (they keep the old bytes) and is
 *   reported in the result; `preserveLinks: true` rewrites the inode instead
 *   and keeps every link, at the cost of atomicity on that one file;
 * - a `=======` line inside a SEARCH body is ambiguous, so every possible
 *   split is tried against the file and an undecidable one is refused instead
 *   of being applied.
 *
 * Optional wrappers are tolerated: `*** Begin Patch`/`*** End Patch`, an
 * Aider-style code fence, `*** Update File: <path>` in place of a bare path,
 * and a bare `>>>>>>>` with no label.
 *
 * @module z1-tools/patch
 */

import { unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import { fail, optionalBoolean, stringArg } from './args.js'
import { runHelper } from './host.js'
import { displayPath, refuseSessionStorePath, resolvePath } from './paths.js'
import {
  BINARY_SNIFF_BYTES,
  detectEol,
  excerpt,
  plural,
  splitLines,
  toEol,
} from './text.js'

/**
 * Commit helper: rename every prepared temp file over its target, keeping the
 * previous bytes (and mode/timestamps) so a late failure can be rolled back.
 *
 * A target whose `nlink > 1` follows the same rule as `write`: by default the
 * rename detaches the other links (they keep the old bytes, and the helper
 * reports how many were broken), because a link outside the workspace is a way
 * around the store guard; `<pair>.preserveLinks` (the tool's `preserveLinks`)
 * asks for the in-place rewrite that keeps every link instead. Prints one JSON
 * object per target: `{to, broke, inPlace}`.
 */
const COMMIT_SCRIPT = [
  "const fs = require('node:fs/promises')",
  'async function main() {',
  '  const pairs = JSON.parse(process.argv[1])',
  '  const done = []',
  '  const report = []',
  '  try {',
  '    for (const pair of pairs) {',
  '      let info = null',
  '      try {',
  '        info = await fs.stat(pair.to)',
  '      } catch (error) {',
  '        if (error === null || typeof error !== "object" || error.code !== "ENOENT") throw error',
  '      }',
  '      let previous = null',
  '      try {',
  '        previous = await fs.readFile(pair.to)',
  '      } catch (error) {',
  '        if (error === null || typeof error !== "object" || error.code !== "ENOENT") throw error',
  '      }',
  '      done.push({',
  '        to: pair.to,',
  '        previous,',
  '        mode: info === null ? null : info.mode & 0o7777,',
  '        atime: info === null ? null : info.atimeMs,',
  '        mtime: info === null ? null : info.mtimeMs,',
  '      })',
  '      const linked = info !== null && info.nlink > 1',
  '      if (linked && pair.preserveLinks === true) {',
  '        // Caller asked for link fidelity: rewrite the inode, keep every name.',
  '        await fs.writeFile(pair.to, await fs.readFile(pair.from))',
  '        await fs.unlink(pair.from)',
  '        report.push({ to: pair.to, broke: 0, kept: info.nlink - 1 })',
  '      } else {',
  '        if (info !== null) await fs.chmod(pair.from, info.mode & 0o7777)',
  '        await fs.rename(pair.from, pair.to)',
  '        report.push({ to: pair.to, broke: linked ? info.nlink - 1 : 0, kept: 0 })',
  '      }',
  '    }',
  '  } catch (error) {',
  '    for (const step of done.reverse()) {',
  '      try {',
  '        if (step.previous === null) await fs.unlink(step.to)',
  '        else await fs.writeFile(step.to, step.previous)',
  '        if (step.mode !== null) await fs.chmod(step.to, step.mode)',
  '        if (step.mtime !== null) {',
  '          await fs.utimes(step.to, new Date(step.atime), new Date(step.mtime))',
  '        }',
  '      } catch {}',
  '    }',
  '    throw error',
  '  }',
  '  process.stdout.write(JSON.stringify(report))',
  '}',
  'main().catch((error) => {',
  '  const detail = error && error.message ? error.message : String(error)',
  '  process.stderr.write(detail)',
  '  process.exit(1)',
  '})',
].join('\n')

const SEARCH_MARKER = /^<{7}\s*SEARCH\b/
const SEPARATOR = /^={3,}$/
const TERMINATOR = /^>{7}/
const UNSUPPORTED_VERB = /^\*\*\*\s*(?:Add|Delete|Move)\b/
const UPDATE_FILE = /^\*\*\*\s*Update File:\s*(.+)$/

const BEGIN_PATCH = '*** Begin Patch'
const END_PATCH = '*** End Patch'
const END_OF_FILE = '*** End of File'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * True when `text` cannot be the UTF-8 text of the file on disk.
 *
 * The broker hands tools already-decoded UTF-8, so a NUL byte or a U+FFFD
 * replacement character in the first 8 KiB means either a binary file or bytes
 * that were never UTF-8. Both are refused rather than written back, because
 * writing would replace every undecodable byte.
 */
export function looksBinary(text) {
  const head = text.slice(0, BINARY_SNIFF_BYTES)
  return head.includes('\u0000') || head.includes('\uFFFD')
}

/** Count non-overlapping occurrences of `needle`, stopping at `limit`. */
function countOccurrences(text, needle, limit = Number.POSITIVE_INFINITY) {
  let count = 0
  let index = 0
  for (;;) {
    const at = text.indexOf(needle, index)
    if (at < 0) return count
    count += 1
    if (count >= limit) return count
    index = at + needle.length
  }
}

function blockLineCount(text) {
  return text === '' ? 0 : splitLines(text).length
}

function isSkippable(line) {
  return (
    line === '' ||
    line === BEGIN_PATCH ||
    line === END_PATCH ||
    line === END_OF_FILE ||
    line.startsWith('```')
  )
}

/** `*** Update File: p` (Codex shape) or a bare path line. */
function pathFromLine(line) {
  const match = UPDATE_FILE.exec(line)
  return match === null ? line : match[1].trim()
}

/**
 * Parse the patch text into `{ path, line, candidates }` blocks, in order.
 *
 * `candidates` holds every way the block's `=======` lines could split it into
 * SEARCH/REPLACE. A block with one candidate is the normal case; more than one
 * happens when the quoted text itself contains a `=======` line (a Markdown
 * setext heading, a row of `=`), and is resolved against the file later.
 */
export function parsePatch(patch) {
  if (typeof patch !== 'string' || patch.trim().length === 0) {
    fail('apply_patch.patch must be a non-empty string')
  }

  const lines = patch.split(/\r?\n/)
  const blocks = []
  let index = 0
  let lastPath

  while (index < lines.length) {
    const line = lines[index].trim()
    if (isSkippable(line)) {
      index += 1
      continue
    }

    let path
    let open
    if (line.startsWith('<<<<<<<')) {
      // A second block for the same file: the path is already known. This is
      // the shape models naturally produce for several hunks.
      if (lastPath === undefined) {
        fail(
          `apply_patch: expected a file path at patch line ${index + 1}, ` +
            `found "${line}"`,
        )
      }
      path = lastPath
      open = index
    } else {
      if (SEPARATOR.test(line) || TERMINATOR.test(line)) {
        fail(
          `apply_patch: expected a file path at patch line ${index + 1}, ` +
            `found "${line}"`,
        )
      }
      if (UNSUPPORTED_VERB.test(line)) {
        fail(
          `apply_patch: "${line}" at patch line ${index + 1} is not supported; ` +
            'apply_patch rewrites existing files only (create with `write`)',
        )
      }
      path = pathFromLine(line)
      if (path.length === 0) {
        fail(`apply_patch: expected a file path at patch line ${index + 1}`)
      }
      lastPath = path
      index += 1
      // Allow blank lines between the path and its first block.
      while (index < lines.length && lines[index].trim() === '') index += 1
      open = index
    }

    if (index >= lines.length || !SEARCH_MARKER.test(lines[index].trim())) {
      const at = Math.min(index + 1, lines.length)
      const found = index < lines.length ? lines[index].trim() : ''
      if (found.startsWith('@@') || /^[-+][^-+]/.test(found)) {
        fail(
          `apply_patch: patch line ${at} uses the Codex "@@" diff shape, which is ` +
            'not supported; write `<<<<<<< SEARCH`, the text to replace, ' +
            '`=======`, the replacement, `>>>>>>> REPLACE`',
        )
      }
      fail(
        `apply_patch: expected "<<<<<<< SEARCH" after "${path}" at patch line ${at}`,
      )
    }

    // The block ends at the first `>>>>>>>`; a new `<<<<<<<` or the end of the
    // envelope before that means the terminator is missing.
    let terminator = -1
    let scanned = open
    for (let probe = open + 1; probe < lines.length; probe += 1) {
      const text = lines[probe].trim()
      if (text === END_PATCH || text.startsWith('<<<<<<<')) break
      scanned = probe
      if (TERMINATOR.test(text)) {
        terminator = probe
        break
      }
    }
    if (terminator < 0) {
      let separator = false
      for (let probe = open + 1; probe <= scanned; probe += 1) {
        if (SEPARATOR.test(lines[probe].trim())) separator = true
      }
      fail(
        separator
          ? `apply_patch: missing ">>>>>>> REPLACE" for "${path}"; the block ` +
              `opened at patch line ${open + 1} never closes`
          : `apply_patch: missing "=======" separator and ">>>>>>> REPLACE" for ` +
              `"${path}" (block opened at patch line ${open + 1})`,
      )
    }

    const separators = []
    for (let probe = open + 1; probe < terminator; probe += 1) {
      if (SEPARATOR.test(lines[probe].trim())) separators.push(probe)
    }
    if (separators.length === 0) {
      fail(
        `apply_patch: missing "=======" separator for "${path}" (block opened ` +
          `at patch line ${open + 1})`,
      )
    }

    const candidates = []
    for (const separator of separators) {
      const oldText = lines.slice(open + 1, separator).join('\n')
      // An empty SEARCH half can never match an existing file, so only the
      // non-empty splits are candidates.
      if (oldText === '') continue
      candidates.push({
        oldText,
        newText: lines.slice(separator + 1, terminator).join('\n'),
        separator: separator + 1,
      })
    }
    if (candidates.length === 0) {
      fail(
        `apply_patch: the SEARCH block for "${path}" at patch line ${open + 1} ` +
          'is empty; quote the text to replace',
      )
    }

    blocks.push({ path, line: open + 1, candidates })
    index = terminator + 1
  }

  if (blocks.length === 0) fail('apply_patch.patch contains no SEARCH/REPLACE block')
  return blocks
}

/**
 * Find where a block's SEARCH text sits in the *original* file.
 *
 * Every `=======` split of the block is tried. Exact text wins; failing that
 * the text is re-spaced to the file's line ending. A split that matches once
 * is usable; when several usable splits start at the same offset, the longest
 * one is the only one that quotes the whole region, so it is chosen. Anything
 * else is refused rather than guessed.
 */
function locateBlock(state, block) {
  const options = []
  for (const candidate of block.candidates) {
    let needle = candidate.oldText
    let count = countOccurrences(state.original, needle, 2)
    if (count === 0) {
      const respaced = toEol(candidate.oldText, state.eol)
      const respacedCount = countOccurrences(state.original, respaced, 2)
      if (respacedCount > 0) {
        needle = respaced
        count = respacedCount
      }
    }
    if (count === 0) continue
    options.push({
      candidate,
      needle,
      count,
      at: state.original.indexOf(needle),
    })
  }

  if (options.length === 0) {
    fail(
      `apply_patch: no match for "${excerpt(block.candidates[0].oldText)}" in ` +
        `${state.shown} (block at patch line ${block.line}); quote the current ` +
        'text exactly',
    )
  }

  const unique = options.filter((option) => option.count === 1)
  if (unique.length === 0) {
    fail(
      `apply_patch: "${excerpt(options[0].candidate.oldText)}" matches more ` +
        `than once in ${state.shown} (block at patch line ${block.line}); ` +
        'include more context so the block is unique',
    )
  }
  if (unique.length === 1) return unique[0]

  const starts = new Set(unique.map((option) => option.at))
  if (starts.size > 1) {
    fail(
      `apply_patch: ambiguous "=======" separator in the block for ` +
        `${state.shown} at patch line ${block.line}: ${unique.length} splits ` +
        'match the file; quote text so only one separator is left',
    )
  }
  unique.sort((a, b) => b.needle.length - a.needle.length)
  return unique[0]
}

/** Splice every edit into the original text, once, from the end backwards. */
function applyEdits(state) {
  const edits = state.edits
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end)
  for (let index = 1; index < edits.length; index += 1) {
    const previous = edits[index - 1]
    const current = edits[index]
    if (current.start < previous.end) {
      fail(
        `apply_patch: overlapping SEARCH blocks in ${state.shown}: the block at ` +
          `patch line ${previous.line} and the block at patch line ` +
          `${current.line} cover the same text; combine them into one block`,
      )
    }
  }
  let content = state.original
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index]
    content =
      content.slice(0, edit.start) + edit.replacement + content.slice(edit.end)
  }
  return content
}

/** Write every changed file to a sibling temp file, then rename them in. */
async function commit(ctx, states, preserveLinks) {
  const temps = []
  try {
    for (const state of states) {
      const temp = join(
        dirname(state.path),
        `.${basename(state.path)}.z1-${randomUUID()}.tmp`,
      )
      // Registered before the write so a failed write still cleans up.
      temps.push({ from: temp, to: state.path, preserveLinks })
      try {
        await ctx.fs.write(temp, state.content)
      } catch (error) {
        try {
          await unlink(temp)
        } catch {
          // never created
        }
        fail(`apply_patch: cannot write "${state.shown}": ${errorMessage(error)}`)
      }
    }
    const label = `apply_patch: cannot write ${plural(states.length, 'file')}`
    const stdout = await runHelper(ctx, COMMIT_SCRIPT, [JSON.stringify(temps)], label)
    return readCommitReport(stdout)
  } finally {
    // Renamed temps are gone; a failed run leaves the originals untouched.
    for (const entry of temps) {
      try {
        await unlink(entry.from)
      } catch {
        // already renamed away, or never created
      }
    }
  }
}

/** `{broke, kept}` per committed path from the helper's JSON line. */
function readCommitReport(stdout) {
  const report = new Map()
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return report
  }
  if (!Array.isArray(parsed)) return report
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object' || typeof entry.to !== 'string') continue
    report.set(entry.to, {
      broke: Number.isInteger(entry.broke) ? entry.broke : 0,
      kept: Number.isInteger(entry.kept) ? entry.kept : 0,
    })
  }
  return report
}

/** Apply every block in memory, then commit the changed files atomically. */
export async function applyPatch(ctx, raw) {
  const blocks = parsePatch(stringArg(raw, 'patch', 'apply_patch'))
  const preserveLinks = optionalBoolean(raw, 'preserveLinks', 'apply_patch') === true
  const files = new Map()
  const order = []
  const resolved = new Map()

  // One `resolvePath` per distinct path string: it spawns a helper child, and
  // a hundred blocks naming one file must not mean a hundred children.
  const pathFor = (rawPath) => {
    let pending = resolved.get(rawPath)
    if (pending === undefined) {
      pending = resolvePath(ctx, rawPath, 'apply_patch.path')
      resolved.set(rawPath, pending)
    }
    return pending
  }

  for (const block of blocks) {
    const path = await pathFor(block.path)
    await refuseSessionStorePath(ctx, path, 'apply_patch')
    const shown = displayPath(ctx, path)
    let state = files.get(path)
    if (state === undefined) {
      let content
      try {
        content = await ctx.fs.read(path)
      } catch (error) {
        fail(`apply_patch: cannot read "${shown}": ${errorMessage(error)}`)
      }
      if (looksBinary(content)) {
        fail(`apply_patch: "${shown}" is not a UTF-8 text file`)
      }
      state = {
        path,
        shown,
        original: content,
        content,
        eol: detectEol(content),
        edits: [],
        added: 0,
        removed: 0,
        changed: false,
      }
      files.set(path, state)
      order.push(state)
    }

    const located = locateBlock(state, block)
    const added = blockLineCount(located.candidate.newText)
    const removed = blockLineCount(located.candidate.oldText)
    state.edits.push({
      start: located.at,
      end: located.at + located.needle.length,
      replacement: toEol(located.candidate.newText, state.eol),
      line: block.line,
      added,
      removed,
    })
    state.added += added
    state.removed += removed
  }

  const changed = []
  for (const state of order) {
    state.content = applyEdits(state)
    state.changed = state.content !== state.original
    if (state.changed) changed.push(state)
  }

  if (changed.length === 0) {
    return (
      `no change: ${plural(blocks.length, 'block')} in ` +
      `${plural(order.length, 'file')} matched text that is already there`
    )
  }

  const report = await commit(ctx, changed, preserveLinks)

  const header = `patched ${plural(blocks.length, 'block')} in ${plural(order.length, 'file')}`
  const lines = order.map((state) => {
    if (!state.changed) return `${state.shown} (no change)`
    const notes = [`+${state.added} -${state.removed} block lines`]
    const links = report.get(state.path)
    if (links !== undefined) {
      // Say it out loud: a by-default rename detaches the other links, which
      // keep the old bytes; `preserveLinks` rewrites the inode instead.
      if (links.broke > 0) notes.push(`broke ${plural(links.broke, 'hard link')}`)
      if (links.kept > 0) notes.push(`in place: kept ${plural(links.kept, 'hard link')}`)
    }
    return `${state.shown} (${notes.join(', ')})`
  })
  return [header, ...lines].join('\n')
}
