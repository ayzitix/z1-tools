/**
 * One-shot `node -e` helpers.
 *
 * The worker runs under Node's permission model, which denies `realpath`,
 * `stat`, `readdir`, `rename` and `readFile` on every path outside the module
 * directory, and the broker exposes only `read`/`write`/`list`/`stat`. The few
 * operations the broker lacks therefore run in a child spawned through
 * `ctx.process.run`: argv only, no shell string, no extra dependency. Each
 * helper prints JSON (or nothing) on stdout and its message on stderr.
 *
 * @module z1-tools/host
 */

import { resolve } from 'node:path'

import { fail } from './args.js'

export const HELPER_TIMEOUT_MS = 15_000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run `node -e <source> ...args` and return `{code, stdout, stderr}`.
 *
 * `ctx.process.run` itself failing (no spawn, timeout, permission denial) still
 * throws with `label`, because that is a tool-level failure; a helper that ran
 * and exited non-zero is returned so the caller can rewrite its message
 * (absolute paths, a giant stack) before reporting it.
 */
export async function runHelperResult(ctx, source, args, label) {
  try {
    const result = await ctx.process.run({
      command: process.execPath,
      args: ['-e', source, ...args],
      cwd: resolve(ctx.workspace),
      timeoutMs: HELPER_TIMEOUT_MS,
    })
    return {
      code: typeof result.code === 'number' ? result.code : 1,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    }
  } catch (error) {
    fail(`${label}: ${errorMessage(error)}`)
  }
}

/** Longest slice of a helper's message reported in a tool error. */
const MAX_HELPER_DETAIL = 300

/**
 * The one line of a helper's stderr worth reporting.
 *
 * An uncaught `node -e` error prints the eval location, the source line, a
 * caret, then `Error: message` and a stack; leaking that into a tool result
 * buries the path the model needs. Prefer the `Error:` message anywhere in the
 * stream, fall back to the first non-empty line, and keep it to one clipped
 * line. `move` writes a bare message, which passes through unchanged.
 */
function helperDetail(stderr, code) {
  const lines = String(stderr).split('\n')
  for (const line of lines) {
    const match = /^(?:[A-Za-z_]*Error):\s*(.+)$/.exec(line.trim())
    if (match !== null) {
      return match[1].length <= MAX_HELPER_DETAIL
        ? match[1]
        : `${match[1].slice(0, MAX_HELPER_DETAIL)}…`
    }
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || /^\[(?:eval|stdin)\]:\d+$/.test(trimmed)) continue
    return trimmed.length <= MAX_HELPER_DETAIL ? trimmed : `${trimmed.slice(0, MAX_HELPER_DETAIL)}…`
  }
  return `exit ${code}`
}

/**
 * Run `node -e <source> ...args` in the workspace and return its stdout.
 *
 * `label` prefixes every failure, so callers report the tool operation rather
 * than the helper's own stack.
 */
export async function runHelper(ctx, source, args, label) {
  const result = await runHelperResult(ctx, source, args, label)
  if (result.code !== 0) {
    const detail =
      helperDetail(result.stderr, result.code) || result.stdout.trim() || `exit ${result.code}`
    fail(`${label}: ${detail}`)
  }
  return result.stdout
}
