/**
 * Search and inventory tools: `list`, `glob`, `grep` and `tree`.
 *
 * Every walk goes through the brokered `ctx.fs.list`/`ctx.fs.read`, is bounded
 * in depth and entries, and reports truncation instead of walking forever.
 * Children are sorted before the caps are applied, so the subset a caller sees
 * is deterministic.
 *
 * Globs follow the common `rg`/`fd` dialect: `*`, `**`, `?`, `{a,b}` and
 * `[abc]`/`[!abc]`. A pattern with **no `/`** is matched against the basename
 * at any depth (`*.txt` finds `a/b/c.txt`); a pattern containing `/` is
 * matched against the path relative to the root.
 *
 * The project's session store (`<workspace>/z1` carrying the `.z1-sessions`
 * marker) is not content: every walk prunes it without descending and counts it
 * as one ignored path. `list` and `tree` show it once as
 * `z1 (z1 state, ignored)`; `glob` and `grep` skip it silently. A base *inside*
 * the store answers with a short notice instead of an empty result. A `z1/`
 * folder without the marker is ordinary content and is not touched.
 *
 * Ignore rules: `.gitignore` is read from the search root and from every
 * directory that is visited (when the listing already shows one), with
 * directory patterns, `!` negation and `**`. `.git`, `node_modules` and
 * `.z1/out` are always pruned. `grep` and `glob` skip pruned paths silently;
 * `list` and `tree` show them once with an `(ignored)` marker and never
 * descend. An internal `includeIgnored: true` argument (not in the schema)
 * disables both. Caps are counted in files, not directories.
 *
 * Symlinks are never followed: the broker reports a link as its own entry
 * (`type: "symlink"`), the walk only recurses into `dir`, and `grep` only reads
 * `file`, so a link inside the workspace cannot make a search leave it. `list`
 * shows the link as `link <path>`; `tree` shows `name (symlink)` (or
 * `name -> target` when the broker supplies a target).
 *
 * `grep` returns `""`-free results: a no-match answer is `(no matches; ...)`,
 * every result ends with `(N matches in M files; ...)` and truncation is an
 * explicit `… (...)` line. Individual lines are clipped and the whole answer is
 * capped at 64 KiB.
 *
 * @module z1-tools/search
 */

import { resolve } from 'node:path'

import {
  fail,
  optionalBoolean,
  optionalInteger,
  optionalString,
  positiveInteger,
  stringArg,
} from './args.js'
import {
  displayPath,
  insideWorkspace,
  resolvePath,
  sessionRoot,
  toPosix,
  workspaceRoot,
} from './paths.js'
import { BINARY_SNIFF_BYTES, MAX_READ_BYTES, byteLength, splitLines } from './text.js'

/** Deepest recursion accepted by `list`, `glob` and `grep`. */
export const MAX_DEPTH = 8
/** Most files one walk collects before reporting truncation. */
export const MAX_ENTRIES = 5000
/** Most matches `grep` returns by default. */
export const MAX_GREP_RESULTS = 200
/** Deepest tree `tree` renders. */
export const MAX_TREE_DEPTH = 7
/** Most entries `tree` renders. */
export const MAX_TREE_ENTRIES = 3000
/** Most paths `glob` returns in one answer. */
export const MAX_GLOB_RESULTS = 1000
/** Longest grep line content, before the `… +N chars` note. */
export const MAX_GREP_LINE_CHARS = 400
/** Byte budget for one tool answer. */
export const OUTPUT_CAP_BYTES = 64 * 1024
/** Line budget for one tool answer. */
export const OUTPUT_CAP_LINES = 2000

/**
 * Directories a search never descends into.
 *
 * `.z1/out` holds the full text that `ctx.clip` spilled, so walking it makes a
 * model re-read its own truncated output; `node_modules` is noise that floods
 * the 5000-file cap; `.git` is never useful to a text search.
 */
const NOISE = new Set(['.git', 'node_modules'])
const NOISE_PATH = /(^|\/)\.z1\/out(\/|$)/

/** What a search rooted inside the session store answers instead of walking. */
const SESSION_NOTICE = '(z1 state: not project content; transcripts use /sessions)'

/** True when `path` is exactly the detected session root (never a child). */
function isSessionEntry(session, path) {
  return session !== undefined && resolve(path) === session
}

/** True when `base` is the session root or somewhere inside it. */
function insideSessionStore(session, base) {
  return session !== undefined && insideWorkspace(session, base)
}

/** Bytes consumed by an answer, refusing the line that would exceed a cap. */
function makeBudget(maxBytes = OUTPUT_CAP_BYTES, maxLines = OUTPUT_CAP_LINES) {
  let bytes = 0
  let lines = 0
  let exceeded
  return {
    add(text) {
      const cost = byteLength(text) + 1
      if (lines >= maxLines) {
        exceeded = 'lines'
        return false
      }
      if (bytes + cost > maxBytes) {
        exceeded = 'bytes'
        return false
      }
      bytes += cost
      lines += 1
      return true
    },
    get bytes() {
      return bytes
    },
    get lines() {
      return lines
    },
    get exceeded() {
      return exceeded
    },
  }
}

/** What a capped answer ran out of: whole lines or bytes. */
function budgetCap(budget) {
  return budget.exceeded === 'lines'
    ? countLabel(budget.lines, 'line', 'lines')
    : `${OUTPUT_CAP_BYTES / 1024} KiB`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function relPosix(base, path) {
  const rel = toPosix(path).slice(toPosix(base).length)
  return rel.startsWith('/') ? rel.slice(1) : rel
}

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`
}

function basenameOf(path) {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

/** Sort by name without locale so the order is identical on every host. */
function compareNames(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function sortEntries(entries) {
  entries.sort(compareNames)
}

/**
 * Escape control characters so a file name cannot inject extra output lines.
 * Newlines, carriage returns and tabs become the familiar `\n`/`\r`/`\t`.
 */
export function escapeControls(value) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    if (character === '\n') return '\\n'
    if (character === '\r') return '\\r'
    if (character === '\t') return '\\t'
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

/** Compact human-readable size for `tree` (`0 B`, `1.5 KB`, `2 MB`). */
function formatSize(size) {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return undefined
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) {
    const value = size / 1024
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} KB`
  }
  const value = size / (1024 * 1024)
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} MB`
}

/** Clip one line, never splitting a surrogate pair. */
function clipLine(line, maximum = MAX_GREP_LINE_CHARS) {
  if (line.length <= maximum) return line
  let cut = maximum
  const code = line.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return `${line.slice(0, cut)}… +${line.length - cut} chars`
}

/** Regex metacharacters that need a backslash outside a character class. */
function escapeLiteral(character) {
  return /[\\^$.*+?()[\]{}|/]/.test(character) ? `\\${character}` : character
}

function escapeClassCharacter(character) {
  return /[\\\]^]/.test(character) ? `\\${character}` : character
}

/**
 * Translate one `[...]` class starting at `start`.
 *
 * Returns `undefined` when the class never closes, so the caller can treat the
 * `[` as a literal. `!` and `^` negate, and a negated class never matches `/`.
 */
function translateClass(pattern, start) {
  let index = start + 1
  let negated = false
  if (pattern[index] === '!' || pattern[index] === '^') {
    negated = true
    index += 1
  }
  let body = ''
  let closed = false
  let first = true
  while (index < pattern.length) {
    const character = pattern[index]
    if (character === ']' && !first) {
      closed = true
      index += 1
      break
    }
    first = false
    if (character === '\\') {
      index += 1
      if (index >= pattern.length) return undefined
      body += escapeClassCharacter(pattern[index])
      index += 1
      continue
    }
    if (character === '[') {
      body += '\\['
      index += 1
      continue
    }
    body += escapeClassCharacter(character)
    index += 1
  }
  if (!closed) return undefined
  return { source: negated ? `[^/${body}]` : `[${body}]`, next: index }
}

/** Index of the `}` matching the `{` at `start`, or -1. */
function findBraceClose(pattern, start) {
  let depth = 0
  for (let index = start; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '[') {
      const characterClass = translateClass(pattern, index)
      if (characterClass !== undefined) {
        index = characterClass.next - 1
        continue
      }
    }
    if (character === '{') depth += 1
    if (character === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Split `a,{b,c}` into `a` and `{b,c}`. */
function splitAlternatives(body) {
  const parts = []
  let depth = 0
  let current = ''
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (character === '\\') {
      current += character
      if (index + 1 < body.length) {
        current += body[index + 1]
        index += 1
      }
      continue
    }
    if (character === '[') {
      const characterClass = translateClass(body, index)
      if (characterClass !== undefined) {
        current += body.slice(index, characterClass.next)
        index = characterClass.next - 1
        continue
      }
    }
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    if (character === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  parts.push(current)
  return parts
}

function translateGlob(pattern) {
  let source = ''
  let index = 0
  while (index < pattern.length) {
    const character = pattern[index]
    if (character === '\\') {
      index += 1
      if (index < pattern.length) {
        source += escapeLiteral(pattern[index])
        index += 1
      } else {
        source += '\\\\'
      }
      continue
    }
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 2
        while (pattern[index] === '*') index += 1
        if (pattern[index] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        index += 1
        source += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      index += 1
      source += '[^/]'
      continue
    }
    if (character === '[') {
      const characterClass = translateClass(pattern, index)
      if (characterClass !== undefined) {
        source += characterClass.source
        index = characterClass.next
        continue
      }
      source += '\\['
      index += 1
      continue
    }
    if (character === '{') {
      const close = findBraceClose(pattern, index)
      if (close !== -1) {
        const parts = splitAlternatives(pattern.slice(index + 1, close))
        if (parts.length > 1) {
          source += `(?:${parts.map((part) => translateGlob(part)).join('|')})`
          index = close + 1
          continue
        }
      }
      source += '\\{'
      index += 1
      continue
    }
    source += escapeLiteral(character)
    index += 1
  }
  return source
}

/**
 * Anchored glob: `**` crosses `/`, `*` and `?` do not, `{a,b}` alternates and
 * `[...]` is a character class. Compiled with `u` so `?` matches one code
 * point and property escapes in a literal pattern stay valid.
 */
export function globToRegExp(pattern) {
  return new RegExp(`^${translateGlob(pattern)}$`, 'u')
}

function normalizeGlob(pattern) {
  return pattern.startsWith('./') ? pattern.slice(2) : pattern
}

/** A pattern without `/` matches the basename at any depth. */
function matchGlob(matcher, pattern, rel) {
  return matcher.test(pattern.includes('/') ? rel : basenameOf(rel))
}

/**
 * Parse one `.gitignore` line.
 *
 * Supports comments, escaped leading `#`/`!`, negation, directory-only
 * patterns (trailing `/`), a leading `/` anchor and `**`. A pattern with no `/`
 * matches the basename at any depth.
 */
function parseIgnoreLine(line) {
  let text = line.replace(/^\uFEFF/, '').replace(/\r$/, '')
  if (text.trim() === '' || text.startsWith('#')) return undefined
  if (text.startsWith('\\#') || text.startsWith('\\!')) text = text.slice(1)
  let negate = false
  if (text.startsWith('!')) {
    negate = true
    text = text.slice(1)
  }
  // Trailing spaces are ignored unless escaped with a backslash.
  text = text.replace(/(?<!\\) +$/, '')
  if (text === '') return undefined
  const dirOnly = text.endsWith('/')
  if (dirOnly) text = text.slice(0, -1)
  if (text === '') return undefined
  let anchored = text.startsWith('/')
  if (anchored) text = text.slice(1)
  if (text.includes('/')) anchored = true
  if (text === '') return undefined
  let regex
  try {
    regex = globToRegExp(anchored ? text : `**/${text}`)
  } catch {
    return undefined
  }
  return { regex, negate, dirOnly }
}

function parseIgnoreText(text) {
  const rules = []
  for (const line of splitLines(text)) {
    const rule = parseIgnoreLine(line)
    if (rule !== undefined) rules.push(rule)
  }
  return rules
}

/**
 * Read `<directory>/.gitignore` if the listing already shows one.
 *
 * Using the listing avoids a failed broker read in every directory. Failure to
 * read an existing ignore file is not fatal: the walk continues unfiltered.
 */
async function readIgnoreRules(ctx, children) {
  const marker = children.find((entry) => entry.name === '.gitignore' && entry.type === 'file')
  if (marker === undefined) return undefined
  let text
  try {
    text = await ctx.fs.read(marker.path)
  } catch {
    return undefined
  }
  const rules = parseIgnoreText(text)
  return rules.length === 0 ? undefined : rules
}

/** Last matching rule wins; rules from nested files apply after their parents. */
function isIgnored(chain, entryPath, isDirectory) {
  let ignored = false
  for (const ruleSet of chain) {
    const rel = relPosix(ruleSet.dir, entryPath)
    for (const rule of ruleSet.rules) {
      if (rule.dirOnly && !isDirectory) continue
      if (rule.regex.test(rel)) ignored = !rule.negate
    }
  }
  return ignored
}

function isNoise(rel, name) {
  return NOISE.has(name) || NOISE_PATH.test(rel)
}

async function listChildren(ctx, directory) {
  let listed
  try {
    listed = await ctx.fs.list(directory)
  } catch (error) {
    fail(`cannot list "${displayPath(ctx.workspace, directory)}": ${errorMessage(error)}`)
  }
  return Array.isArray(listed.entries) ? listed.entries : []
}

/**
 * Walk `base` depth first through the broker.
 *
 * `depth` counts levels below `base`: its immediate children are depth 1.
 * Directories do not count against `maxFiles`; the cap is about files a caller
 * might have to read. A pruned entry (noise or `.gitignore`) is either skipped
 * or, with `markIgnored`, listed once with `ignored: true` and never descended.
 *
 * Returns `truncated` (the file/entry cap stopped the walk), `depthLimited`
 * (directories not descended because of `maxDepth`), `ignored` (pruned paths),
 * `files` and `dirs` (entries collected).
 */
export async function walk(ctx, base, maxDepth, options = {}) {
  const ignore = options.ignore !== false
  const useNoise = options.noise !== false
  const markIgnored = options.markIgnored === true
  const session = await sessionRoot(ctx)
  const maxFiles = options.maxFiles ?? MAX_ENTRIES
  const maxTotalEntries = maxFiles * 4
  const entries = []
  const chain = []
  let files = 0
  let dirs = 0
  let ignored = 0
  let truncated = false
  let depthLimited = 0

  const visit = async (directory, depth) => {
    if (depth > maxDepth || truncated) return
    const children = await listChildren(ctx, directory)
    let pushed = false
    if (ignore) {
      const rules = await readIgnoreRules(ctx, children)
      if (rules !== undefined) {
        chain.push({ dir: directory, rules })
        pushed = true
      }
    }
    try {
      sortEntries(children)
      for (const entry of children) {
        if (truncated) return
        const rel = relPosix(base, entry.path)
        const isDirectory = entry.type === 'dir'
        // z1's own store is pruned whatever the ignore options say: it is not
        // project content, so no caller may walk into a transcript.
        const store = isSessionEntry(session, entry.path)
        const pruned =
          store ||
          (useNoise && isNoise(rel, entry.name)) ||
          (ignore && isIgnored(chain, entry.path, isDirectory))
        if (pruned) {
          ignored += 1
          if (!markIgnored) continue
          if (entries.length >= maxTotalEntries) {
            truncated = true
            return
          }
          entries.push({ ...entry, depth, ignored: true, ...(store ? { session: true } : {}) })
          continue
        }
        if (!isDirectory && files >= maxFiles) {
          truncated = true
          return
        }
        if (entries.length >= maxTotalEntries) {
          truncated = true
          return
        }
        entries.push({
          name: entry.name,
          path: entry.path,
          type: entry.type,
          ...(entry.size === undefined ? {} : { size: entry.size }),
          depth,
        })
        if (!isDirectory) {
          files += 1
          continue
        }
        dirs += 1
        // Only real directories are entered; a symlink is an entry, not a path.
        if (depth < maxDepth) await visit(entry.path, depth + 1)
        else depthLimited += 1
      }
    } finally {
      if (pushed) chain.pop()
    }
  }

  await visit(base, 1)
  return { entries, truncated, depthLimited, ignored, files, dirs }
}

export async function listTool(ctx, raw) {
  const base = await resolvePath(ctx, raw['path'], 'list.path')
  if (insideSessionStore(await sessionRoot(ctx), base)) return SESSION_NOTICE
  const includeIgnored = optionalBoolean(raw, 'includeIgnored', 'list') === true
  const recursive = optionalBoolean(raw, 'recursive', 'list') === true
  const requested = positiveInteger(raw, 'maxDepth', 'list', MAX_DEPTH)
  const maxDepth = requested ?? (recursive ? MAX_DEPTH : 1)

  // A file is a legitimate target: `read` and `grep` accept one, and a model
  // often reaches for `list` after seeing a path in their output.
  const baseInfo = await ctx.fs.stat(base).catch(() => undefined)
  if (baseInfo?.type === 'file') {
    const size = baseInfo.size === undefined ? '?' : String(baseInfo.size)
    return `file ${escapeControls(displayPath(ctx.workspace, base))} (${size})`
  }
  if (baseInfo?.type === 'symlink') {
    return `link ${escapeControls(displayPath(ctx.workspace, base))}`
  }

  const { entries, truncated, depthLimited, files } = await walk(ctx, base, maxDepth, {
    ignore: !includeIgnored,
    noise: !includeIgnored,
    markIgnored: true,
  })
  const lines = []
  const budget = makeBudget()
  let capped = false
  for (const entry of entries) {
    const rel = escapeControls(relPosix(base, entry.path))
    let line
    if (entry.session === true) {
      line = `dir ${rel} (z1 state, ignored)`
    } else if (entry.type === 'dir') {
      line = `dir ${rel}${entry.ignored ? ' (ignored)' : ''}`
    } else if (entry.type === 'symlink') {
      line = `link ${rel}${entry.ignored ? ' (ignored)' : ''}`
    } else {
      const size = entry.size === undefined ? '?' : String(entry.size)
      line = `file ${rel} (${size}${entry.ignored ? ', ignored' : ''})`
    }
    if (!budget.add(line)) {
      capped = true
      break
    }
    lines.push(line)
  }

  if (lines.length === 0 && !truncated) return '(empty directory)'
  if (capped) {
    lines.push(`… (output capped at ${budgetCap(budget)})`)
  }
  if (truncated) {
    lines.push(`… (truncated: ${countLabel(files, 'file', 'files')} listed; more entries not listed)`)
  }
  if (maxDepth > 1 && depthLimited > 0) {
    lines.push(
      `… (depth limit ${maxDepth} reached; ${countLabel(depthLimited, 'directory', 'directories')} not expanded)`,
    )
  }
  return lines.join('\n')
}

export async function globTool(ctx, raw) {
  const includeIgnored = optionalBoolean(raw, 'includeIgnored', 'glob') === true
  const pattern = normalizeGlob(stringArg(raw, 'pattern', 'glob'))
  if (pattern.startsWith('/')) {
    fail('glob.pattern must be relative to glob.path; absolute patterns are not supported')
  }
  const base =
    raw['path'] === undefined
      ? workspaceRoot(ctx)
      : await resolvePath(ctx, raw['path'], 'glob.path')
  if (insideSessionStore(await sessionRoot(ctx), base)) return SESSION_NOTICE
  let matcher
  try {
    matcher = globToRegExp(pattern)
  } catch (error) {
    fail(`glob.pattern is not a valid glob: ${errorMessage(error)}`)
  }

  const baseInfo = await ctx.fs.stat(base).catch(() => undefined)
  if (baseInfo?.type === 'file') {
    const matches = !pattern.includes('/') && matcher.test(basenameOf(toPosix(base)))
    return matches ? escapeControls(displayPath(ctx.workspace, base)) : '(no matches)'
  }

  const { entries, truncated, depthLimited, ignored, files } = await walk(ctx, base, MAX_DEPTH, {
    ignore: !includeIgnored,
    noise: !includeIgnored,
  })
  const matches = []
  for (const entry of entries) {
    if (entry.type === 'dir') continue
    const rel = relPosix(base, entry.path)
    if (matchGlob(matcher, pattern, rel)) {
      matches.push(escapeControls(displayPath(ctx.workspace, entry.path)))
    }
  }
  matches.sort()

  const lines = []
  const budget = makeBudget()
  let capped = false
  for (const path of matches.slice(0, MAX_GLOB_RESULTS)) {
    if (!budget.add(path)) {
      capped = true
      break
    }
    lines.push(path)
  }
  if (lines.length === 0) lines.push('(no matches)')
  if (matches.length > lines.length && !capped) {
    lines.push(`… (showing ${lines.length} of ${matches.length} matches; sorted)`)
  }
  if (capped) {
    lines.push(`… (output capped at ${budgetCap(budget)})`)
  }
  if (truncated) {
    lines.push(
      `… (truncated: walked ${countLabel(files, 'file', 'files')}; more files not searched)`,
    )
  }
  if (depthLimited > 0) {
    lines.push(
      `… (depth limit ${MAX_DEPTH} reached; ${countLabel(depthLimited, 'directory', 'directories')} not searched)`,
    )
  }
  if (ignored > 0) {
    lines.push(`… (${countLabel(ignored, 'ignored path', 'ignored paths')} skipped)`)
  }
  return lines.join('\n')
}

/** Merge the context windows around each matching line index. */
function contextRanges(indexes, context) {
  const ranges = []
  for (const index of indexes) {
    const start = Math.max(0, index - context)
    const end = index + context
    const last = ranges[ranges.length - 1]
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end)
    } else {
      ranges.push({ start, end })
    }
  }
  return ranges
}

export async function grepTool(ctx, raw) {
  const pattern = stringArg(raw, 'pattern', 'grep')
  const includeIgnored = optionalBoolean(raw, 'includeIgnored', 'grep') === true
  const base =
    raw['path'] === undefined
      ? workspaceRoot(ctx)
      : await resolvePath(ctx, raw['path'], 'grep.path')
  if (insideSessionStore(await sessionRoot(ctx), base)) return SESSION_NOTICE
  const fileGlob = optionalString(raw, 'glob', 'grep')
  // Case-sensitive by default, like ripgrep; `caseSensitive: false` opts in.
  const caseSensitive = optionalBoolean(raw, 'caseSensitive', 'grep') !== false
  const context = optionalInteger(raw, 'context', 'grep', 0, 20) ?? 0
  const maxResults = positiveInteger(raw, 'maxResults', 'grep', MAX_GREP_RESULTS) ?? MAX_GREP_RESULTS

  let regex
  try {
    // `u` makes `\p{L}` work and turns unsupported PCRE escapes into a clear
    // invalid-regex error instead of a silent literal match.
    regex = new RegExp(pattern, caseSensitive ? 'u' : 'iu')
  } catch (error) {
    fail(`grep.pattern is not a valid regular expression: ${errorMessage(error)}`)
  }
  const normalizedGlob = fileGlob === undefined ? undefined : normalizeGlob(fileGlob)
  let fileMatcher
  if (normalizedGlob !== undefined) {
    try {
      fileMatcher = globToRegExp(normalizedGlob)
    } catch (error) {
      fail(`grep.glob is not a valid glob: ${errorMessage(error)}`)
    }
  }

  // A file path is a legitimate base: read that one file instead of failing in
  // `fs.list`, which is what a model does after reading a path from an error.
  const baseInfo = await ctx.fs.stat(base).catch(() => undefined)
  const singleFile = baseInfo?.type === 'file'
  let entries
  let walked = { truncated: false, depthLimited: 0, ignored: 0, files: 0 }
  if (singleFile) {
    entries = [
      {
        name: base,
        path: base,
        type: 'file',
        ...(baseInfo.size === undefined ? {} : { size: baseInfo.size }),
        depth: 1,
      },
    ]
  } else {
    walked = await walk(ctx, base, MAX_DEPTH, {
      ignore: !includeIgnored,
      noise: !includeIgnored,
    })
    entries = walked.entries
  }

  const output = []
  const budget = makeBudget()
  const skipped = { binary: 0, large: 0, unreadable: 0 }
  let stopped = false
  let matchCount = 0
  let matchedFiles = 0
  let scanned = 0
  let resultLimited = false
  let outputCapped = false

  for (const entry of entries) {
    if (stopped) break
    if (entry.type !== 'file') continue
    const rel = relPosix(base, entry.path)
    if (
      fileMatcher !== undefined &&
      normalizedGlob !== undefined &&
      !singleFile &&
      !matchGlob(fileMatcher, normalizedGlob, rel)
    ) {
      continue
    }
    // Files over 1 MiB are skipped, but counted and reported.
    if (entry.size !== undefined && entry.size > MAX_READ_BYTES) {
      skipped.large += 1
      continue
    }

    let text
    try {
      text = await ctx.fs.read(entry.path)
    } catch {
      skipped.unreadable += 1
      continue
    }
    // A NUL byte in the head is the usual "this is not text" signal.
    if (text.slice(0, BINARY_SNIFF_BYTES).includes('\0')) {
      skipped.binary += 1
      continue
    }
    scanned += 1

    const lines = splitLines(text)
    const matched = []
    for (let index = 0; index < lines.length; index += 1) {
      if (regex.test(lines[index])) matched.push(index)
    }
    if (matched.length === 0) continue

    const shownPath = escapeControls(displayPath(ctx.workspace, entry.path))
    const contentLimit = Math.max(120, MAX_GREP_LINE_CHARS - shownPath.length)
    const matchedSet = new Set(matched)
    let fileMatched = false
    scan: for (const range of contextRanges(matched, context)) {
      for (let index = range.start; index < Math.min(range.end + 1, lines.length); index += 1) {
        const isMatch = matchedSet.has(index)
        if (isMatch && matchCount >= maxResults) {
          resultLimited = true
          stopped = true
          break scan
        }
        const content = clipLine(lines[index], contentLimit)
        const label = `${shownPath}${isMatch ? ':' : '-'}${index + 1}${isMatch ? ': ' : '- '}${content}`
        if (!budget.add(label)) {
          outputCapped = true
          stopped = true
          break scan
        }
        output.push(label)
        if (isMatch) {
          if (!fileMatched) {
            matchedFiles += 1
            fileMatched = true
          }
          matchCount += 1
        }
      }
    }
  }

  if (resultLimited) {
    output.push(`… (${maxResults}-result limit reached; more matches not shown)`)
  }
  if (outputCapped) {
    output.push(
      `… (output capped at ${budgetCap(budget)}; ${countLabel(matchCount, 'match', 'matches')} in ${countLabel(matchedFiles, 'file', 'files')} shown)`,
    )
  }
  if (walked.truncated) {
    output.push(
      `… (truncated: walked ${countLabel(walked.files, 'file', 'files')}; more files not scanned)`,
    )
  }
  if (walked.depthLimited > 0) {
    output.push(
      `… (depth limit ${MAX_DEPTH} reached; ${countLabel(walked.depthLimited, 'directory', 'directories')} not searched)`,
    )
  }

  const counts = [`${scanned} ${scanned === 1 ? 'file' : 'files'} searched`]
  const skipTotal = skipped.binary + skipped.large + skipped.unreadable
  if (skipTotal > 0) {
    const parts = []
    if (skipped.binary > 0) parts.push(`${skipped.binary} binary`)
    if (skipped.large > 0) parts.push(`${skipped.large} over 1 MiB`)
    if (skipped.unreadable > 0) parts.push(`${skipped.unreadable} unreadable`)
    counts.push(`${skipTotal} ${skipTotal === 1 ? 'file' : 'files'} skipped (${parts.join(', ')})`)
  }
  if (walked.ignored > 0) {
    counts.push(countLabel(walked.ignored, 'ignored path', 'ignored paths'))
  }
  const summary =
    matchCount === 0
      ? `(no matches; ${counts.join('; ')})`
      : `(${countLabel(matchCount, 'match', 'matches')} in ${countLabel(matchedFiles, 'file', 'files')}; ${counts.join('; ')})`

  if (output.length === 0) return summary
  output.push(summary)
  return output.join('\n')
}

function treeLabel(entry, pruned) {
  const name = escapeControls(entry.name)
  if (entry.type === 'dir') return `${name}/${pruned ? ' (ignored)' : ''}`
  if (entry.type === 'symlink') {
    const target = typeof entry.target === 'string' ? escapeControls(entry.target) : undefined
    if (target !== undefined) return `${name} -> ${target}${pruned ? ' (ignored)' : ''}`
    return `${name} (symlink${pruned ? ', ignored' : ''})`
  }
  if (entry.type === 'file') {
    const size = formatSize(entry.size)
    if (size === undefined) return `${name}${pruned ? ' (ignored)' : ''}`
    return `${name} (${size}${pruned ? ', ignored' : ''})`
  }
  return `${name} (other${pruned ? ', ignored' : ''})`
}

export async function treeTool(ctx, raw) {
  const includeIgnored = optionalBoolean(raw, 'includeIgnored', 'tree') === true
  const base =
    raw['path'] === undefined
      ? workspaceRoot(ctx)
      : await resolvePath(ctx, raw['path'], 'tree.path')
  if (insideSessionStore(await sessionRoot(ctx), base)) return SESSION_NOTICE
  const depth = positiveInteger(raw, 'depth', 'tree', MAX_TREE_DEPTH) ?? 3

  const baseInfo = await ctx.fs.stat(base).catch(() => undefined)
  if (baseInfo !== undefined && baseInfo.type !== 'dir') {
    const name = escapeControls(displayPath(ctx.workspace, base))
    if (baseInfo.type === 'file') {
      const size = formatSize(baseInfo.size)
      return size === undefined ? name : `${name} (${size})`
    }
    return `${name} (${baseInfo.type})`
  }

  const session = await sessionRoot(ctx)
  const lines = [escapeControls(displayPath(ctx.workspace, base))]
  const budget = makeBudget()
  budget.add(lines[0])
  const chain = []
  let count = 0
  let entryCapped = false
  let byteCapped = false
  let depthLimited = 0

  const visit = async (directory, prefix, level) => {
    if (level > depth || entryCapped || byteCapped) return
    const children = await listChildren(ctx, directory)
    let pushed = false
    if (!includeIgnored) {
      const rules = await readIgnoreRules(ctx, children)
      if (rules !== undefined) {
        chain.push({ dir: directory, rules })
        pushed = true
      }
    }
    try {
      sortEntries(children)
      for (let index = 0; index < children.length; index += 1) {
        if (entryCapped || byteCapped) return
        if (count >= MAX_TREE_ENTRIES) {
          entryCapped = true
          return
        }
        const entry = children[index]
        const rel = relPosix(base, entry.path)
        const isDirectory = entry.type === 'dir'
        const store = isSessionEntry(session, entry.path)
        const pruned =
          store ||
          (!includeIgnored &&
            (isNoise(rel, entry.name) || isIgnored(chain, entry.path, isDirectory)))
        const last = index === children.length - 1
        const branch = `${prefix}${last ? '└── ' : '├── '}`
        const label = store
          ? `${escapeControls(entry.name)}/ (z1 state, ignored)`
          : treeLabel(entry, pruned)
        if (!budget.add(`${branch}${label}`)) {
          byteCapped = true
          return
        }
        lines.push(`${branch}${label}`)
        count += 1
        if (!isDirectory || pruned) continue
        if (level < depth) await visit(entry.path, `${prefix}${last ? '    ' : '│   '}`, level + 1)
        else depthLimited += 1
      }
    } finally {
      if (pushed) chain.pop()
    }
  }

  await visit(base, '', 1)
  if (entryCapped) lines.push(`… (${MAX_TREE_ENTRIES}-entry limit reached)`)
  if (byteCapped) {
    lines.push(`… (output capped at ${budgetCap(budget)})`)
  }
  if (depthLimited > 0) {
    lines.push(
      `… (depth limit ${depth} reached; ${countLabel(depthLimited, 'directory', 'directories')} not shown)`,
    )
  }
  return lines.join('\n')
}
