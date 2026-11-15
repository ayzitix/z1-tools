/**
 * `shell`: one command, argv only, no shell string.
 *
 * The child is spawned by the host through the brokered `ctx.process.run`, so
 * `process.spawn` in the manifest decides which executables are reachable. The
 * result is text: the exit status — `exit <code>`, or `killed <signal>` when
 * the child died from a signal — followed by the output.
 *
 * Output is rendered in the order the process wrote it. `process.run` returns
 * tagged `segments`, so interleaved stdout/stderr stays interleaved; when both
 * streams appear, each run of a stream is introduced by `--- stdout ---` or
 * `--- stderr ---`, and when only one appears the old single-section layout is
 * kept. A stream that is not UTF-8 text is reported as `(binary output, N
 * bytes)` rather than as replacement characters.
 *
 * A kill caused by the tool's own timeout is marked `(timeout after <ms> ms)`;
 * a run that hit the output cap says `killed … (output limit)` when it was
 * killed, or ends with `… output capped at <N> bytes` when it exited on its own
 * (the excess is discarded, not fatal, and the real exit status is kept).
 *
 * There is no interactive stdin: the child's stdin is closed unless the caller
 * passes `stdin`, which is written once and then closed. Nothing reads the
 * terminal, so a command that prompts (a pager, `apt-get` without `-y`) sees
 * EOF instead of hanging.
 *
 * `cwd` is contained by `resolvePath`, like every other path a tool accepts, and
 * the default (the workspace) is canonicalised the same way so the child starts
 * in the real path.
 *
 * @module z1-tools/shell
 */

import { fail, positiveInteger, stringArg } from './args.js'
import { resolvePath } from './paths.js'

export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_TIMEOUT_MS = 300_000

/** Upper bound the host enforces on one run's output; kept in sync by hand. */
export const MAX_OUTPUT_BYTES = 5 * 1024 * 1024
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

/** Error messages quote a command's own failure; never paste a whole log. */
const MAX_ERROR_CHARS = 600
const BINARY_MARKER = (bytes) => `(binary output, ${bytes} bytes)`

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function clip(value) {
  return value.length <= MAX_ERROR_CHARS
    ? value
    : `${value.slice(0, MAX_ERROR_CHARS)}… (${value.length - MAX_ERROR_CHARS} more characters)`
}

/** Run one argv command; shared by `shell` and the read-only git tools. */
export function runCommand(ctx, request) {
  return ctx.process.run(request)
}

/**
 * `exit 0`, or `killed SIGTERM (timeout after 100 ms)`.
 *
 * The reason comes from the host's explicit flags, never from comparing
 * `durationMs` with the timeout: a process that exits *at* the deadline has not
 * been killed, and a kill for another reason is not a timeout.
 */
export function statusLine(result, timeoutMs) {
  const signal = result.signal ?? null
  if (signal !== null) {
    const notes = []
    if (result.timedOut === true) {
      notes.push(`timeout after ${timeoutMs ?? result.durationMs} ms`)
    } else if (result.outputLimit === true) {
      notes.push('output limit')
    }
    return `killed ${signal}${notes.length === 0 ? '' : ` (${notes.join(', ')})`}`
  }
  return `exit ${result.code === null ? 'null' : result.code}`
}

/** One segment's body: text without trailing blank lines, or a binary marker. */
function segmentBody(segment) {
  const bytes = typeof segment.bytes === 'number' ? segment.bytes : 0
  const text = typeof segment.text === 'string' ? segment.text : ''
  if (segment.binary === true || text.includes('\u0000')) {
    return bytes === 0 ? '' : BINARY_MARKER(bytes)
  }
  return text.replace(/\n+$/, '')
}

/**
 * Render `result` as output lines, preserving write order.
 *
 * Hosts that predate `segments` fall back to stdout-then-stderr sections.
 */
export function outputLines(result) {
  const lines = []
  const segments = Array.isArray(result.segments) ? result.segments : []
  if (segments.length === 0) {
    const stdout = typeof result.stdout === 'string' ? result.stdout.replace(/\n+$/, '') : ''
    const stderr = typeof result.stderr === 'string' ? result.stderr.replace(/\n+$/, '') : ''
    if (stdout !== '') lines.push('--- stdout ---', stdout)
    if (stderr !== '') lines.push('--- stderr ---', stderr)
    return lines
  }

  const bothStreams = segments.some((segment) => segment.stream === 'stderr')
  for (const segment of segments) {
    const body = segmentBody(segment)
    if (body === '') continue
    // With one stream the section header is enough; with two, re-announce the
    // stream each time it switches so the order is unambiguous.
    if (bothStreams || lines.length === 0) lines.push(`--- ${segment.stream} ---`)
    lines.push(body)
  }
  return lines
}

export async function shellTool(ctx, raw) {
  const command = stringArg(raw, 'command', 'shell')
  const args = raw['args']
  if (args !== undefined) {
    if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
      fail('shell.args must be an array of strings')
    }
  }
  // The default cwd goes through the same realpath + containment resolution as
  // an explicit one, so the child never starts in a symlinked alias.
  const cwd =
    raw['cwd'] === undefined
      ? await resolvePath(ctx, '.', 'shell.cwd')
      : await resolvePath(ctx, raw['cwd'], 'shell.cwd')
  const timeoutMs = positiveInteger(raw, 'timeoutMs', 'shell', MAX_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = positiveInteger(raw, 'maxOutputBytes', 'shell', MAX_OUTPUT_BYTES)

  const stdin = raw['stdin']
  if (stdin !== undefined && typeof stdin !== 'string') {
    fail('shell.stdin must be a string')
  }

  const env = raw['env']
  if (env !== undefined) {
    if (env === null || typeof env !== 'object' || Array.isArray(env)) {
      fail('shell.env must be an object of string values')
    }
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string') fail(`shell.env.${key} must be a string`)
      if (key.length === 0 || key.includes('=')) fail(`shell.env.${key} is not a variable name`)
    }
  }

  let result
  try {
    result = await runCommand(ctx, {
      command,
      args: args ?? [],
      cwd,
      timeoutMs,
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
      ...(stdin === undefined ? {} : { stdin }),
      ...(env === undefined ? {} : { env }),
    })
  } catch (error) {
    fail(`shell: cannot run "${command}": ${clip(errorMessage(error))}`)
  }

  const parts = [statusLine(result, timeoutMs), ...outputLines(result)]
  if (result.outputLimit === true || result.truncated === true) {
    const cap = result.maxOutputBytes ?? maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    parts.push(
      `… output capped at ${cap} bytes (${result.timedOut === true ? 'the rest was dropped' : 'the rest was read and discarded; the exit status above is the real one'})`,
    )
  }
  return parts.join('\n')
}
