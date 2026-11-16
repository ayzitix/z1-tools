/**
 * Background tasks: a command that does not exit.
 *
 * `shell` blocks until the process ends, which is right for a build and wrong
 * for a dev server. The host owns these children (`ctx.process.start/poll/kill`),
 * so a task outlives the tool call but not the runtime: closing z1 kills it.
 *
 * A task id is the only handle the model needs: `process.output` reads what the
 * child printed (from `cursor`, at most `limit` characters), `process.kill`
 * stops it and `process.list` shows what is still running. Text here is the
 * model's whole view of a task, so every row and every status line is one line,
 * escaped, and carries the exit code or signal rather than a bare "exited".
 *
 * @module z1-tools/process
 */

import { optionalBoolean, optionalInteger, optionalString, stringArg, fail } from './args.js'
import { displayPath, resolvePath, workspaceRoot } from './paths.js'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Characters returned by one `process.output` call unless the caller asks for less. */
export const MAX_OUTPUT_CHUNK = 64 * 1024
/** Largest `process.list` row, so one noisy argv cannot dominate a listing. */
const MAX_ROW_CHARS = 200
/** Part of a row reserved for the command itself. */
const MAX_COMMAND_CHARS = 110
/** Signals `process.kill` accepts; the host enforces the same list. */
export const SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT']
/** Finished tasks shown by default, newest first. */
const RECENT_FINISHED = 5

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isSignalName(value) {
  return typeof value === 'string' && SIGNALS.includes(value)
}

/** `exited (code N)` / `killed (SIGTERM)`; a signal beats a null code. */
function statusLine(snapshot) {
  if (snapshot.status === 'running') return `running (pid ${String(snapshot.pid ?? '?')})`
  if (snapshot.status === 'stopping') {
    return `stopping (${snapshot.killSignal ?? 'SIGTERM'} sent, pid ${String(snapshot.pid ?? '?')})`
  }
  if (snapshot.status === 'killed') {
    return `killed (${snapshot.signal ?? snapshot.killSignal ?? 'signal'})`
  }
  if (typeof snapshot.signal === 'string' && snapshot.signal.length > 0) {
    return `exited (${snapshot.signal})`
  }
  return `exited (code ${snapshot.exitCode === null || snapshot.exitCode === undefined ? '?' : String(snapshot.exitCode)})`
}

function compactStatus(snapshot) {
  const pid = snapshot.pid === undefined ? '' : ` pid=${String(snapshot.pid)}`
  if (snapshot.status === 'running') return `running${pid}`
  if (snapshot.status === 'stopping') return `stopping (${snapshot.killSignal ?? 'SIGTERM'} sent)${pid}`
  if (snapshot.status === 'killed') {
    return `killed (${snapshot.signal ?? snapshot.killSignal ?? 'signal'})${pid}`
  }
  if (typeof snapshot.signal === 'string' && snapshot.signal.length > 0) {
    return `exited (${snapshot.signal})${pid}`
  }
  const code = snapshot.exitCode === null || snapshot.exitCode === undefined ? '?' : String(snapshot.exitCode)
  return `exited (code ${code})${pid}`
}

/** `12s`, `3m`, `2h`, `4d` — one token, monotonic. */
function formatAge(startedAt, now = Date.now()) {
  const ms = Math.max(0, now - startedAt)
  if (ms < 60_000) return `${String(Math.floor(ms / 1000))}s`
  if (ms < 3_600_000) return `${String(Math.floor(ms / 60_000))}m`
  if (ms < 86_400_000) return `${String(Math.floor(ms / 3_600_000))}h`
  return `${String(Math.floor(ms / 86_400_000))}d`
}

/** `512`, `1.2k`, `256k` — characters, never bytes. */
function formatChars(count) {
  if (!Number.isFinite(count) || count < 0) return '?'
  if (count < 1000) return String(count)
  if (count < 1000 * 1000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/**
 * Make arbitrary argv printable on one line.
 *
 * Newlines, tabs, ESC and other control characters become visible escapes, so
 * a `node -e` heredoc or an ANSI-coloured server banner cannot turn one task
 * into forty rows or smuggle terminal control into the transcript.
 */
function escapeOneLine(text, max = MAX_COMMAND_CHARS) {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)
    let piece = char
    if (code === 0x0a) piece = '\\n'
    else if (code === 0x0d) piece = '\\r'
    else if (code === 0x09) piece = '\\t'
    else if (code === 0x1b) piece = '\\e'
    else if (code < 0x20 || code === 0x7f) piece = `\\x${code.toString(16).padStart(2, '0')}`
    else if (code === 0x2028) piece = '\\u2028'
    else if (code === 0x2029) piece = '\\u2029'
    if (out.length + piece.length > max) return `${out}…`
    out += piece
  }
  return out
}

/** `a b` as `"a b"`, so a row can be read back as an argv. */
function quoteArg(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg)
}

function commandLine(snapshot, max = MAX_COMMAND_CHARS) {
  const parts = [snapshot.command, ...(snapshot.args ?? [])]
  return escapeOneLine(parts.map(quoteArg).join(' '), max)
}

function exitSummary(snapshot) {
  if (snapshot.status === 'running' || snapshot.status === 'stopping') return 'running'
  return statusLine(snapshot)
}

export async function startTool(ctx, raw) {
  const command = stringArg(raw, 'command', 'process.start')
  // Identical to `shell.args`: a non-string is a caller bug, not something to
  // drop on the floor (dropping it silently changes the command).
  const args = raw['args']
  if (args !== undefined) {
    if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
      fail('process.start.args must be an array of strings')
    }
  }
  // Same semantics as `shell`: the workspace (real path), never the module dir.
  // A dev server started in the module dir serves the wrong tree.
  const cwd =
    raw['cwd'] === undefined
      ? await resolvePath(ctx, '.', 'process.start.cwd')
      : await resolvePath(ctx, raw['cwd'], 'process.start.cwd')
  const env = raw['env']
  if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env))) {
    throw new Error('process.start.env must be an object of string values')
  }
  for (const value of Object.values(env ?? {})) {
    if (typeof value !== 'string') throw new Error('process.start.env must be an object of string values')
  }

  // Warning only: the same command twice is usually a loop, not an intent, but
  // two servers on different ports are legitimate.
  let duplicate
  try {
    const running = await ctx.process.list()
    duplicate = running.find(
      (task) =>
        task.status === 'running' &&
        task.command === command &&
        JSON.stringify(task.args ?? []) === JSON.stringify(args ?? []) &&
        (task.cwd === undefined || task.cwd === cwd),
    )
  } catch {
    duplicate = undefined
  }

  let snapshot
  try {
    snapshot = await ctx.process.start({
      command,
      args: args ?? [],
      cwd,
      ...(env === undefined ? {} : { env }),
    })
  } catch (error) {
    throw new Error(`process.start failed: ${errorMessage(error)}`)
  }

  // A command that cannot start (port taken, missing binary) exits within a few
  // milliseconds. Reporting "running" and making the model poll to discover the
  // failure wastes a step, so give it a short grace period and report the exit
  // together with the reason it printed.
  let exited = snapshot
  for (let attempt = 0; attempt < 10 && exited.status === 'running'; attempt += 1) {
    await sleep(20)
    exited = await ctx.process.poll({ id: snapshot.id })
    if (exited.status !== 'running') break
  }
  const cwdNote = cwd === workspaceRoot(ctx) ? 'cwd .' : `cwd ${displayPath(ctx, cwd)}`
  const dupNote =
    duplicate === undefined
      ? []
      : [
          `note: ${duplicate.id} is already running the same command (pid ${String(duplicate.pid ?? '?')}); read it with process.output {"id":"${duplicate.id}"}`,
        ]

  if (exited.status !== 'running') {
    const body = exited.output.replace(/\n$/, '')
    return [
      `${exited.id} — ${statusLine(exited)} shortly after start`,
      `${commandLine(exited)} · ${cwdNote}`,
      body.length === 0 ? '(no output)' : `---\n${body}`,
      ...dupNote,
    ].join('\n')
  }

  return [
    `started ${snapshot.id} — ${statusLine(snapshot)}`,
    `${commandLine(snapshot)} · ${cwdNote}`,
    `read it with process.output {"id":"${snapshot.id}"}; stop it with process.kill {"id":"${snapshot.id}"}; all tasks: process.list`,
    ...dupNote,
  ].join('\n')
}

export async function outputTool(ctx, raw) {
  const id = stringArg(raw, 'id', 'process.output')
  // Integers only: `Number('5')` and `Number(1.5)` would silently read the
  // wrong offset, and a negative cursor would be clamped instead of refused.
  const cursor = optionalInteger(raw, 'cursor', 'process.output', 0, Number.MAX_SAFE_INTEGER)
  const requestedLimit = optionalInteger(raw, 'limit', 'process.output', 1, Number.MAX_SAFE_INTEGER)
  const limit = requestedLimit === undefined ? MAX_OUTPUT_CHUNK : Math.min(requestedLimit, MAX_OUTPUT_CHUNK)

  let snapshot
  try {
    snapshot = await ctx.process.poll({
      id,
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    })
  } catch (error) {
    throw new Error(`process.output failed: ${errorMessage(error)}`)
  }

  const from = cursor ?? 0
  const next = snapshot.cursor
  const size = snapshot.size
  const more = snapshot.more === undefined ? next < size : snapshot.more === true
  const dropped = snapshot.droppedChars ?? 0
  // A cursor past the end is legal (it is what a stale cursor looks like); the
  // range it describes is empty, so print the range that was actually read.
  const startsAt = Math.min(from, next)

  const header = [`${snapshot.id} — ${statusLine(snapshot)}`]
  const notes = []
  if (from > size) notes.push(`cursor ${String(from)} was past the end`)
  if (snapshot.truncated === true) {
    notes.push(`cursor ${String(from)} was before the retained output; ${formatChars(dropped)} chars dropped`)
  } else if (dropped > 0 && from <= dropped) {
    notes.push(`${formatChars(dropped)} chars of earlier output dropped`)
  }
  if (requestedLimit !== undefined && requestedLimit > MAX_OUTPUT_CHUNK) {
    notes.push(`limit capped at ${String(MAX_OUTPUT_CHUNK)} chars`)
  }
  notes.push(
    more
      ? `cursor ${String(startsAt)}→${String(next)} of ${String(size)} chars · more: call again with {"id":"${snapshot.id}","cursor":${String(next)}}`
      : `cursor ${String(startsAt)}→${String(next)} of ${String(size)} chars · end of output`,
  )

  const body = snapshot.output
  return [
    header.join(''),
    notes.join(' · '),
    '---',
    // Never trim the body: a chunk that ends on a newline would lose a character
    // the cursor has already advanced over.
    body.length === 0 ? '(no new output)' : body,
  ].join('\n')
}

export async function killTool(ctx, raw) {
  const id = stringArg(raw, 'id', 'process.kill')
  const signal = optionalString(raw, 'signal', 'process.kill')
  if (signal !== undefined && !isSignalName(signal)) {
    fail(`process.kill.signal must be one of ${SIGNALS.join(', ')}`)
  }
  let snapshot
  try {
    snapshot = await ctx.process.kill({
      id,
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    throw new Error(`process.kill failed: ${errorMessage(error)}`)
  }

  // A kill is a request. Wait a short, bounded time for the fact (exit) so a
  // clean stop is reported as one, and a TERM-ignoring child is not called
  // dead while it is still running.
  if (snapshot.endedAt === null) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      await sleep(25)
      snapshot = await ctx.process.poll({ id })
      if (snapshot.endedAt !== null) break
    }
  }

  const sent = signal ?? snapshot.killSignal ?? 'SIGTERM'
  if (snapshot.endedAt !== null) {
    if (snapshot.killSignal === null) {
      return `${snapshot.id} — already ${exitSummary(snapshot)} before the signal`
    }
    return `${snapshot.id} — ${statusLine(snapshot)}`
  }
  return [
    `${snapshot.id} — stopping (${sent} sent, pid ${String(snapshot.pid ?? '?')})`,
    sent === 'SIGKILL'
      ? 'SIGKILL delivered; the process has not exited yet — check again with process.output'
      : 'SIGKILL is sent automatically after 2 s if it ignores the signal; check with process.output',
  ].join('\n')
}

export async function listTool(ctx, raw) {
  const all = optionalBoolean(raw ?? {}, 'all', 'process.list') === true
  const limit = optionalInteger(raw ?? {}, 'limit', 'process.list', 1, 200)
  let tasks
  try {
    tasks = await ctx.process.list()
  } catch (error) {
    throw new Error(`process.list failed: ${errorMessage(error)}`)
  }
  if (tasks.length === 0) return 'no background tasks'

  const running = tasks.filter((task) => task.status === 'running' || task.status === 'stopping')
  const finished = tasks
    .filter((task) => task.status !== 'running' && task.status !== 'stopping')
    .sort((left, right) => (left.endedAt ?? 0) - (right.endedAt ?? 0))
  const keepFinished = limit ?? (all ? undefined : RECENT_FINISHED)
  // `limit` bounds the rows with or without `all`; `all` alone means every
  // finished task. One row per task either way, capped by MAX_ROW_CHARS.
  const shownFinished = keepFinished === undefined ? finished : finished.slice(-keepFinished)
  const omitted = finished.length - shownFinished.length
  const rows = [...running, ...shownFinished]
  const now = Date.now()

  const lines = rows.map((task) => {
    const id = escapeOneLine(task.id, 40)
    const cwd =
      task.cwd === undefined ? '' : ` cwd=${escapeOneLine(displayPath(ctx, task.cwd), 40)}`
    const age = ` age=${formatAge(task.startedAt, now)}`
    const out = ` out=${formatChars(task.size ?? 0)}`
    const row = `${id} ${compactStatus(task)}${age}${out}${cwd} · ${commandLine(task, MAX_COMMAND_CHARS)}`
    if (row.length <= MAX_ROW_CHARS) return row
    // Cut whole code points only: half of a surrogate pair is not printable.
    let cut = MAX_ROW_CHARS - 1
    const code = row.charCodeAt(cut)
    if (code >= 0xdc00 && code <= 0xdfff) cut -= 1
    return `${row.slice(0, cut)}…`
  })

  if (omitted > 0) {
    lines.push(
      all
        ? `… ${String(omitted)} finished task${omitted === 1 ? '' : 's'} omitted (limit ${String(keepFinished)}; pass a larger limit for more)`
        : `… ${String(omitted)} finished task${omitted === 1 ? '' : 's'} omitted (showing the last ${String(keepFinished)}; pass {"all":true} for every task)`,
    )
  }
  const first = running[0]
  if (first !== undefined) {
    lines.push(`stop one with process.kill {"id":"${first.id}"}`)
  }
  return lines.join('\n')
}
