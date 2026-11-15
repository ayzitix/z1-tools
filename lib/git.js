/**
 * Read-only git tools: `git.status`, `git.diff` and `git.log`.
 *
 * They run `git` through `ctx.process.run` in the workspace. Nothing here
 * stages, commits or rewrites history.
 *
 * Every invocation pins the settings that change the *shape* of the output
 * (`color.ui=false`, `diff.external=`, `diff.noprefix=false`,
 * `diff.renames=true`, `core.quotePath=false`, `--no-pager`, `--no-ext-diff`)
 * so a repository or user config cannot turn a read into a program launch or a
 * quoted-path puzzle, and passes `GIT_OPTIONAL_LOCKS=0` so `git status` cannot
 * rewrite `.git/index`.
 *
 * Nothing here asks git for `-z` output. The broker decodes a command's output
 * as one text block and reports a NUL as `(binary output, N bytes)` with the
 * text discarded (`node-host/src/process-run.ts`, `decodeRun`), so a NUL-framed
 * `git status -z` or `ls-files -z` arrives empty. The line-oriented porcelain
 * v2 and `ls-files` formats are parsed instead: fixed fields first, then the
 * path (so spaces in a path are preserved), and a rename is
 * `<new path>\t<old path>` on one line. `core.quotePath=false` keeps non-ASCII
 * paths literal; a path containing a tab, newline or quote is still C-quoted by
 * git into a single line, which `visible` leaves readable rather than
 * re-splitting.
 *
 * The child environment drops `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
 * `GIT_OBJECT_DIRECTORY` and friends, and the resolved repository is checked
 * against the workspace: a repository git found *outside* the workspace is
 * refused instead of reported. Paths are always workspace-relative, so they can
 * be pasted into `read`/`edit`.
 *
 * A `ref` is attacker-controlled input, so one that starts with `-` (or carries
 * a control character) is refused outright and the ref is passed after
 * `--end-of-options`, with any pathspec after `--`. That keeps
 * `ref: "--output=/tmp/x"` (or `-O`, `--no-index`, ...) from turning a read-only
 * diff into a write.
 *
 * Output is capped (64 KiB by default) with an explicit `… truncated (N of M
 * bytes)` marker, so a huge tree never silently blows up the context window.
 *
 * @module z1-tools/git
 */

import { Buffer } from 'node:buffer'
import { join, resolve } from 'node:path'

import { fail, optionalBoolean, optionalInteger, optionalString } from './args.js'
import { insideWorkspace, resolvePath, workspaceRoot } from './paths.js'
import { runCommand, statusLine } from './shell.js'

const GIT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 64 * 1024

/** Settings pinned for every call; `-c` beats repo and user config. */
const PINNED_CONFIG = [
  '-c',
  'color.ui=false',
  '-c',
  'diff.external=',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.renames=true',
  '-c',
  'core.quotePath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'status.showUntrackedFiles=normal',
  '-c',
  'log.showSignature=false',
]

/** Variables that could point git at a different repository, index or config. */
const SCRUBBED_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_EXTERNAL_DIFF',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
]

const DIFF_MODES = ['stat', 'patch', 'numstat', 'name']

/** The child environment without the git variables a hostile shell could set. */
function childEnv() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  for (const key of Object.keys(env)) {
    if (
      SCRUBBED_ENV.includes(key) ||
      key.startsWith('GIT_CONFIG_KEY_') ||
      key.startsWith('GIT_CONFIG_VALUE_')
    ) {
      delete env[key]
    }
  }
  return env
}

/** First non-empty line of a git message: never a usage dump. */
function firstLine(text) {
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** One git failure, as a single line naming the tool, the cause and the state. */
function gitError(tool, verb, result, extra = {}) {
  const detail = firstLine(result.stderr) || firstLine(result.stdout)
  if (/not a git repository/i.test(detail)) {
    return `${tool}: not a git repository (no .git in or above the workspace)`
  }
  if (/must be run in a work tree/i.test(detail)) {
    return `${tool}: the workspace has no work tree (bare repository)`
  }
  if (/does not have any commits yet/i.test(detail)) {
    return `${tool}: the repository has no commits yet`
  }
  if (/unknown revision|bad revision|ambiguous argument|unknown ref|not a valid object/i.test(detail)) {
    return extra.ref === undefined
      ? `${tool}: ${detail}`
      : `${tool}: unknown ref "${extra.ref}"`
  }
  if (/pathspec .* did not match|is outside repository|outside repository/i.test(detail)) {
    return extra.path === undefined ? `${tool}: ${detail}` : `${tool}: path is outside the workspace or not tracked`
  }
  const status = statusLine(result, GIT_TIMEOUT_MS)
  return `${tool}: git ${verb} failed (${status})${detail === '' ? '' : `: ${detail}`}`
}

/**
 * Run git with the pinned config, the scrubbed environment and no pager.
 *
 * Returns the raw result so callers can read stdout untouched (a diff line may
 * end in whitespace) and decide how to report a non-zero exit themselves.
 */
async function runGit(ctx, args, tool) {
  const request = {
    command: 'git',
    args: ['--no-pager', ...PINNED_CONFIG, ...args],
    cwd: resolve(ctx.workspace),
    timeoutMs: GIT_TIMEOUT_MS,
    env: childEnv(),
  }
  let result
  try {
    result = await runCommand(ctx, request)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A broker that validates request fields strictly may reject `env`; retry
    // once without it rather than failing every git call.
    if (/\benv\b/i.test(message) && /(unknown|unexpected|invalid|additional|not allowed)/i.test(message)) {
      delete request.env
      try {
        result = await runCommand(ctx, request)
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
        fail(`${tool}: git could not run: ${firstLine(retryMessage)}`)
      }
    } else {
      fail(`${tool}: git could not run: ${firstLine(message)}`)
    }
  }
  return result
}

/** A single value field (`--author=`, `--since=`) is data, not an option. */
function fieldValue(value, field, tool, maximum = 200) {
  if (value.length > maximum) fail(`${tool}.${field} is too long (${maximum} characters maximum)`)
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${tool}.${field} must not contain control characters`)
  return value
}

/** A revision is data, never an option. */
function revision(ref, tool) {
  if (ref.startsWith('-')) fail(`${tool}.ref must not start with "-"`)
  if (/[\u0000-\u001f\u007f]/.test(ref)) fail(`${tool}.ref must not contain control characters`)
  return ref
}

/** Absolute path for a git pathspec: resolves relative to the workspace. */
async function pathspec(ctx, value, tool) {
  return await resolvePath(ctx, value, `${tool}.path`)
}

/** Same filesystem path, tolerating a trailing separator. */
function samePath(left, right) {
  return resolve(left) === resolve(right)
}

/** Paths in output are one line each: control characters would break that. */
function visible(path) {
  return path.replace(/[\u0000-\u001f\u007f]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(2, '0')
    return `\\x${code}`
  })
}

const NOT_A_REPO = /not a git repository/i

/**
 * Resolve the repository the workspace belongs to.
 *
 * `memo` keeps this to two git calls per tool invocation; the result is never
 * cached across calls, so `git init` in the workspace is picked up immediately.
 *
 * Returns `{ bare, toplevel, prefix }` where `prefix` is the workspace path
 * inside the repository with a trailing slash (`''` at the root).
 */
async function repoInfo(ctx, tool, memo) {
  if (memo.repo !== undefined) return memo.repo

  const probe = await runGit(
    ctx,
    ['rev-parse', '--is-bare-repository', '--is-inside-work-tree', '--absolute-git-dir'],
    tool,
  )
  if (probe.code !== 0) {
    const detail = firstLine(probe.stderr) || firstLine(probe.stdout)
    if (NOT_A_REPO.test(detail)) {
      fail(`${tool}: not a git repository (no .git in or above the workspace)`)
    }
    fail(gitError(tool, 'rev-parse', probe))
  }
  const [bareLine, insideLine, gitDir] = probe.stdout.trimEnd().split('\n')
  const bare = bareLine === 'true'

  if (bare) {
    if (!insideWorkspace(resolve(ctx.workspace), gitDir)) {
      fail(`${tool}: git resolved a repository outside the workspace (${gitDir}); GIT_DIR is ignored`)
    }
    memo.repo = { bare: true, toplevel: null, prefix: '' }
    return memo.repo
  }

  if (insideLine !== 'true') {
    if (!insideWorkspace(resolve(ctx.workspace), gitDir)) {
      fail(`${tool}: git resolved a repository outside the workspace (${gitDir}); GIT_DIR is ignored`)
    }
    fail(`${tool}: not a git working tree (no .git in or above the workspace)`)
  }

  const where = await runGit(ctx, ['rev-parse', '--show-toplevel', '--show-prefix'], tool)
  if (where.code !== 0) fail(gitError(tool, 'rev-parse', where))
  const [toplevel, rawPrefix = ''] = where.stdout.trimEnd().split('\n')
  const prefix = rawPrefix === '' || rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`

  const reported = join(toplevel, prefix)
  const workspace = resolve(ctx.workspace)
  if (!samePath(reported, workspace) && !samePath(reported, workspaceRoot(ctx))) {
    const real = await resolvePath(ctx, '.', `${tool}.workspace`)
    if (!samePath(reported, real)) {
      fail(`${tool}: git resolved a repository outside the workspace (${toplevel}); GIT_DIR is ignored`)
    }
  }

  memo.repo = { bare: false, toplevel, prefix }
  return memo.repo
}

/** Repository-root path to a workspace-relative one. */
function relativePath(repo, path) {
  if (repo.prefix === '') return path
  if (path === repo.prefix.slice(0, -1)) return '.'
  return path.startsWith(repo.prefix) ? path.slice(repo.prefix.length) : path
}

/** Push whole lines until the byte budget is spent, then one explicit marker. */
function capLines(lines, maxBytes, unit = 'lines') {
  const full = lines.join('\n')
  const total = Buffer.byteLength(full)
  if (total <= maxBytes) return full
  const budget = Math.max(0, maxBytes - 96)
  const kept = []
  let used = 0
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1
    if (used + size > budget) break
    kept.push(line)
    used += size
  }
  const marker = `… truncated (${used} of ${total} bytes, ${kept.length} of ${lines.length} ${unit})`
  return kept.length === 0 ? marker : `${kept.join('\n')}\n${marker}`
}

/** Truncate free text on a line boundary, keeping complete lines. */
function capText(text, maxBytes) {
  const total = Buffer.byteLength(text)
  if (total <= maxBytes) return text
  const buffer = Buffer.from(text)
  const limit = Math.max(0, maxBytes - 96)
  let cut = buffer.subarray(0, limit).lastIndexOf(0x0a)
  if (cut <= 0) cut = limit
  const kept = buffer.subarray(0, cut).toString('utf8').replace(/\n$/, '')
  return `${kept}\n… truncated (${Buffer.byteLength(kept)} of ${total} bytes)`
}

/** Split `count` space-separated fields off a porcelain v2 record. */
function fields(record, count) {
  let index = -1
  for (let step = 0; step < count; step += 1) {
    index = record.indexOf(' ', index + 1)
    if (index < 0) return null
  }
  return { head: record.slice(0, index).split(' '), rest: record.slice(index + 1) }
}

/** Human detail for a porcelain v2 submodule field (`S<c><m><u>`). */
function submoduleNote(sub) {
  if (typeof sub !== 'string' || !sub.startsWith('S')) return ''
  const flags = []
  if (sub[1] === 'C') flags.push('new commit')
  if (sub[2] === 'M') flags.push('modified')
  if (sub[3] === 'U') flags.push('untracked')
  return flags.length === 0 ? '' : ` [submodule: ${flags.join(', ')}]`
}

/** Branch name from `symbolic-ref`, for the bare-repository message. */
async function headName(ctx, tool) {
  const result = await runGit(ctx, ['symbolic-ref', '--short', '-q', 'HEAD'], tool)
  return result.code === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : '(unknown)'
}

/**
 * `git.status` — porcelain v2 with a branch/counts header.
 *
 * Output:
 *
 *     branch main -> origin/main +1 -2 | staged 1 unstaged 2 untracked 3 conflicts 0
 *     M. a.txt
 *     .M blob.bin
 *     R. old.txt -> new.txt
 *     UU conflicted.txt
 *     ?? untracked.txt
 *
 * `XY` is the porcelain status pair (`.` = unmodified), paths are
 * workspace-relative, untracked directories are expanded (`-uall`), renames
 * carry both paths and submodule entries say what changed inside. Nothing is
 * written: `GIT_OPTIONAL_LOCKS=0` plus `--no-optional-locks` equivalent.
 *
 * The output is the newline-delimited porcelain v2 form, not `-z`: see the
 * module note above on why NUL framing cannot cross the broker.
 */
export async function gitStatus(ctx, raw = {}) {
  const tool = 'git.status'
  const maxBytes = optionalInteger(raw, 'maxBytes', tool, 1024, 1024 * 1024) ?? MAX_OUTPUT_BYTES
  const memo = {}
  const repo = await repoInfo(ctx, tool, memo)

  if (repo.bare) {
    return `branch ${await headName(ctx, tool)} | bare repository (no work tree)`
  }

  const result = await runGit(
    ctx,
    [
      'status',
      '--porcelain=v2',
      '--branch',
      '-uall',
      '--ignore-submodules=none',
      '--',
      '.',
    ],
    tool,
  )
  if (result.code !== 0) fail(gitError(tool, 'status', result))

  let branch = '(unknown)'
  let oid = null
  let upstream = null
  let ahead = null
  let behind = null
  const entries = []
  const counts = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }
  // Newline-delimited porcelain v2: a rename's two paths share one line,
  // separated by a TAB. A path may contain spaces, so fields are counted from
  // the left and the remainder is the path.
  const records = result.stdout.split('\n')

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === '') continue

    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') oid = value === '(initial)' ? null : value
      else if (key === 'branch.head') branch = value
      else if (key === 'branch.upstream') upstream = value
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        if (match !== null) {
          ahead = Number(match[1])
          behind = Number(match[2])
        }
      }
      continue
    }

    if (record[0] === '?') {
      counts.untracked += 1
      entries.push(`?? ${visible(relativePath(repo, record.slice(2)))}`)
      continue
    }
    if (record[0] === '!') continue

    if (record[0] === '1' || record[0] === '2') {
      const rename = record[0] === '2'
      const parts = fields(record, rename ? 9 : 8)
      if (parts === null) continue
      const code = parts.head[1] ?? '..'
      const sub = parts.head[2] ?? 'N...'
      if (code[0] !== '.') counts.staged += 1
      if (code[1] !== '.') counts.unstaged += 1
      if (rename) {
        // `<new path>\t<original path>`; git C-quotes a tab inside a pathname,
        // so the only raw TAB here is the separator.
        const tab = parts.rest.indexOf('\t')
        const path = visible(relativePath(repo, tab < 0 ? parts.rest : parts.rest.slice(0, tab)))
        if (tab < 0) {
          entries.push(`${code} ${path}${submoduleNote(sub)}`)
        } else {
          const original = visible(relativePath(repo, parts.rest.slice(tab + 1)))
          entries.push(`${code} ${original} -> ${path}${submoduleNote(sub)}`)
        }
      } else {
        entries.push(`${code} ${visible(relativePath(repo, parts.rest))}${submoduleNote(sub)}`)
      }
      continue
    }

    if (record[0] === 'u') {
      const parts = fields(record, 10)
      if (parts === null) continue
      counts.conflicts += 1
      const code = parts.head[1] ?? 'UU'
      entries.push(`${code} ${visible(relativePath(repo, parts.rest))}`)
    }
  }

  const parts = [`branch ${branch}`]
  if (oid === null) parts.push('(no commits yet)')
  if (branch === '(detached)' && oid !== null) parts.push(`detached at ${oid.slice(0, 7)}`)
  if (upstream !== null) parts.push(`-> ${upstream} +${ahead ?? 0} -${behind ?? 0}`)
  const header = `${parts.join(' ')} | staged ${counts.staged} unstaged ${counts.unstaged} untracked ${counts.untracked} conflicts ${counts.conflicts}`

  const lines = [header, ...entries]
  const body = capLines(lines, maxBytes, 'entries')
  if (result.truncated === true) {
    return `${body}\n… truncated by the host (${Buffer.byteLength(result.stdout)} bytes received)`
  }
  return body
}

/**
 * `git.diff` — stat, patch, numstat or name-status, in one cap.
 *
 * `staged` diffs the index, `ref` diffs the working tree against a commit, and
 * `path` limits either; `staged` and `ref` are refused together because
 * `--staged <ref>` means something else (index against `<ref>`). Untracked
 * files never appear in a diff, so they are listed in their own section unless
 * `untracked: false`.
 */
export async function gitDiff(ctx, raw) {
  const tool = 'git.diff'
  const mode = optionalString(raw, 'mode', tool) ?? 'stat'
  if (!DIFF_MODES.includes(mode)) {
    fail(`${tool}.mode must be one of ${DIFF_MODES.join(', ')}`)
  }
  const staged = optionalBoolean(raw, 'staged', tool) === true
  const ref = optionalString(raw, 'ref', tool)
  const untracked = optionalBoolean(raw, 'untracked', tool) ?? true
  const maxBytes = optionalInteger(raw, 'maxBytes', tool, 256, 1024 * 1024) ?? MAX_OUTPUT_BYTES
  if (staged && ref !== undefined) {
    fail(
      `${tool}: staged and ref are mutually exclusive — staged diffs the index against HEAD, ref diffs the working tree against <ref>`,
    )
  }

  const path = raw['path'] === undefined ? undefined : await pathspec(ctx, raw['path'], tool)
  const memo = {}
  const repo = await repoInfo(ctx, tool, memo)
  if (repo.bare) return 'bare repository (no work tree to diff)'

  const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv']
  if (mode === 'stat') args.push('--stat')
  else if (mode === 'numstat') args.push('--numstat')
  else if (mode === 'name') args.push('--name-status')
  if (staged) args.push('--staged')
  if (ref !== undefined) args.push('--end-of-options', revision(ref, tool))
  args.push('--', path ?? '.')

  const result = await runGit(ctx, args, tool)
  if (result.code !== 0) fail(gitError(tool, 'diff', result, { ref, path }))

  const body = result.stdout.replace(/\n$/, '')
  let untrackedSection = ''
  if (!staged && untracked) {
    // No `-z`: the broker would flag the NULs as binary and drop the whole
    // list. One path per line survives the text transport; a path with a tab
    // or newline is C-quoted by git into one line (`core.quotePath=false` only
    // relaxes non-ASCII quoting).
    const listArgs = ['ls-files', '--others', '--exclude-standard']
    if (path !== undefined) listArgs.push('--', path)
    const listing = await runGit(ctx, listArgs, tool)
    if (listing.code === 0) {
      const names = listing.stdout.split('\n').filter((name) => name !== '')
      if (names.length > 0) {
        untrackedSection = `--- untracked (${names.length}; not in this diff) ---\n${names.map(visible).join('\n')}`
      }
    }
  }

  const sections = [body, untrackedSection].filter((section) => section !== '')
  if (sections.length === 0) return '(no changes)'
  return capText(sections.join('\n\n'), maxBytes)
}

/**
 * `git.log` — newest first, tab-separated `hash  iso-date  author  subject`.
 *
 * `ref` is validated and passed after `--end-of-options`; `author` and `since`
 * become `--author=`/`--since=` values; merges are hidden unless `merges: true`;
 * the history is scoped to the workspace when it is a subdirectory.
 */
export async function gitLog(ctx, raw) {
  const tool = 'git.log'
  const maxCount =
    optionalInteger(raw, 'maxCount', tool, 1, 200) ?? optionalInteger(raw, 'limit', tool, 1, 200) ?? 20
  const author = optionalString(raw, 'author', tool)
  const since = optionalString(raw, 'since', tool)
  const merges = optionalBoolean(raw, 'merges', tool) === true
  const ref = optionalString(raw, 'ref', tool)
  const maxBytes = optionalInteger(raw, 'maxBytes', tool, 256, 1024 * 1024) ?? MAX_OUTPUT_BYTES
  const path = raw['path'] === undefined ? undefined : await pathspec(ctx, raw['path'], tool)

  const memo = {}
  const repo = await repoInfo(ctx, tool, memo)

  const args = ['log', `--max-count=${maxCount}`, '--pretty=format:%h\t%aI\t%an\t%s', '--no-color']
  if (!merges) args.push('--no-merges')
  if (author !== undefined) args.push(`--author=${fieldValue(author, 'author', tool)}`)
  if (since !== undefined) args.push(`--since=${fieldValue(since, 'since', tool)}`)
  if (ref !== undefined) args.push('--end-of-options', revision(ref, tool))
  // A path limits the log to the workspace. At the repository root `.` would
  // only trigger history simplification, so it is added for subdirectories.
  if (path !== undefined) args.push('--', path)
  else if (repo.prefix !== '') args.push('--', '.')

  const result = await runGit(ctx, args, tool)
  if (result.code !== 0) {
    const detail = firstLine(result.stderr)
    if (/does not have any commits yet/i.test(detail)) return '(no commits yet)'
    if (ref !== undefined && /unknown revision|bad revision|ambiguous argument/i.test(detail)) {
      fail(`${tool}: unknown ref "${ref}"`)
    }
    fail(gitError(tool, 'log', result, { ref }))
  }

  const body = result.stdout.replace(/\n$/, '')
  if (body === '') {
    const filtered = author !== undefined || since !== undefined || ref !== undefined || path !== undefined
    return filtered ? '(no matching commits)' : '(no commits)'
  }
  return capText(body, maxBytes)
}
