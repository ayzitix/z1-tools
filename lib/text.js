/**
 * Text helpers: line splitting, `1| ` numbering and read windows.
 *
 * Line endings are normalised for display only; tools never rewrite a file
 * unless the caller asked them to.
 *
 * @module z1-tools/text
 */

/** Largest file `read` will load through the broker. */
export const MAX_READ_BYTES = 1024 * 1024
/** Lines returned by `read` when the caller does not ask for a window. */
export const MAX_READ_LINES = 2000

export function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * True when `text` has a NUL byte anywhere.
 *
 * `indexOf` is a single native scan, so checking the whole string costs about
 * as much as the explicit head slice it replaces and cannot miss a NUL at
 * 12 KiB the way an 8 KiB head did. `read` and `grep` use this alone: a NUL is
 * the one signal no UTF-8 text file carries.
 */
export function hasNul(text) {
  return text.includes('\u0000')
}

/**
 * True when `text` cannot be the UTF-8 text of the file on disk.
 *
 * The broker hands tools already-decoded UTF-8, so a NUL byte means a binary
 * file and a U+FFFD replacement character means bytes that were never valid
 * UTF-8. **The whole string is checked**, not just a head: a single invalid
 * byte at 12 KiB must stop a rewrite just as firmly as one at byte 10, or
 * `edit`/`write` would silently re-encode it. Both `indexOf` calls are native
 * scans over content the tool already holds (at most `MAX_READ_BYTES`), and a
 * short string short-circuits on the first call.
 *
 * Callers that would write the text back (`edit`, `write`, `apply_patch`) must
 * refuse when this is true; they can never reproduce the original bytes.
 */
export function looksBinary(text) {
  return text.includes('\u0000') || text.includes('\uFFFD')
}

/**
 * Split text into lines without their terminators.
 *
 * `"a\nb\n"` is two lines, `"a\n\n"` is two (one empty), and `""` is none.
 * Only `\n` (optionally preceded by `\r`) ends a line.
 */
export function splitLines(text) {
  const matches = text.match(/[^\n]*\n|[^\n]+/g) ?? []
  return matches.map((line) => {
    let value = line.endsWith('\n') ? line.slice(0, -1) : line
    if (value.endsWith('\r')) value = value.slice(0, -1)
    return value
  })
}

/**
 * Number a window of lines for a model: `1| first`, `2| second`.
 *
 * `offset` is 1-based; the window is clamped to the file. `truncated` is true
 * when lines exist after the window.
 */
export function readWindow(text, offset, limit) {
  const lines = splitLines(text)
  const start = offset - 1
  const selected = lines.slice(start, start + limit)
  const body = selected
    .map((line, index) => `${start + index + 1}| ${line}`)
    .join('\n')
  const end = start + selected.length
  return {
    body,
    total: lines.length,
    first: selected.length === 0 ? 0 : start + 1,
    last: end,
    truncated: end < lines.length,
  }
}

/**
 * The line ending a file already uses: CRLF when it contains one, else LF.
 *
 * Mixed files pick CRLF; the tools only use this to match and to normalise
 * replacement text, never to rewrite untouched lines.
 */
export function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** Rewrite every line ending in `text` to `eol`. */
export function toEol(text, eol) {
  return text.replace(/\r\n/g, '\n').split('\n').join(eol)
}

/** A short single-line excerpt of a multi-line snippet, for error messages. */export function excerpt(text, maximum = 60) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= maximum ? flat : `${flat.slice(0, maximum - 1)}…`
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}
