/**
 * Path rules for every tool.
 *
 * The workspace is the project folder the host hands the worker as
 * `ctx.workspace`. Every path a tool touches is contained by it:
 *
 * - a relative path resolves against the workspace;
 * - an absolute path is accepted only when its real path (symlinks followed)
 *   is the workspace or below it;
 * - a target that does not exist yet is checked through the real path of its
 *   nearest existing parent, so `../..` escapes and symlinks leaving the
 *   workspace are refused before anything is read or written.
 *
 * Two entry points share those rules: `resolvePath` resolves the whole path,
 * final symlink included, and is what `read`/`write`/`edit` want (they follow
 * links to the bytes). `resolveLexicalPath` resolves and contains the parent
 * but keeps the last component as written, which is what `stat`, `mkdir` and
 * `move` want: they act on the directory entry itself, so a symlink is
 * reported, moved or created over rather than silently replaced by its target.
 *
 * The refusal is always `path escapes workspace: <path>`. Results display a
 * workspace-relative path when the target is inside the workspace (`.` for the
 * workspace itself) and an absolute path otherwise.
 *
 * One folder is not project content: z1 keeps a project's transcripts in
 * `<workspace>/z1`, owned by the marker file `.z1-sessions` (see
 * `@z1/session/paths` — `<repo>/z1`, or a `Z1_SESSIONS_DIR` override we cannot
 * see from here). `sessionRoot` detects that folder and the tools treat it as
 * z1's own state: hidden from walks, refused by everything that would read or
 * write bytes. A `z1/` folder *without* the marker is an ordinary project
 * folder (the SDK's own source tree, say) and stays fully visible.
 *
 * The worker cannot call `realpath` itself (Node's permission model denies
 * every read outside the module directory and the broker has no `realpath`),
 * so resolution runs in a one-shot helper child through `ctx.process.run`.
 *
 * @module z1-tools/paths
 */

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { fail } from './args.js'
import { runHelper } from './host.js'

/** Resolve symlinks manually so a dangling link is still judged by its target. */
const RESOLVE_SCRIPT = [
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  'const target = path.resolve(process.argv[1])',
  'const root = fs.realpathSync(process.cwd())',
  'function resolveReal(start) {',
  '  let current = start',
  '  const suffix = []',
  '  let hops = 0',
  '  for (;;) {',
  '    try {',
  '      const real = fs.realpathSync(current)',
  '      return suffix.length === 0 ? real : path.join(real, ...suffix.slice().reverse())',
  '    } catch (error) {',
  '      const code = error === null || typeof error !== "object" ? undefined : error.code',
  '      if (code !== "ENOENT" && code !== "ENOTDIR") throw error',
  '    }',
  '    let info = null',
  '    try { info = fs.lstatSync(current) } catch {}',
  '    if (info !== null && info.isSymbolicLink()) {',
  '      hops += 1',
  '      if (hops > 40) throw new Error("too many symbolic links")',
  '      current = path.resolve(path.dirname(current), fs.readlinkSync(current))',
  '      continue',
  '    }',
  '    const parent = path.dirname(current)',
  '    if (parent === current) return path.join(current, ...suffix.slice().reverse())',
  '    suffix.push(path.basename(current))',
  '    current = parent',
  '  }',
  '}',
  'process.stdout.write(JSON.stringify({ root, path: resolveReal(target) }))',
].join('\n')

/** Real workspace roots, learnt from the first resolution for each context. */
const roots = new WeakMap()

/** The workspace as the filesystem sees it, once a path has been resolved. */
export function workspaceRoot(ctx) {
  return roots.get(ctx) ?? resolve(ctx.workspace)
}

async function resolveReal(ctx, candidate) {
  const label = `cannot resolve "${candidate}"`
  const stdout = await runHelper(ctx, RESOLVE_SCRIPT, [candidate], label)
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    fail(`${label}: malformed helper output`)
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof parsed.root !== 'string' ||
    typeof parsed.path !== 'string'
  ) {
    fail(`${label}: malformed helper output`)
  }
  return parsed
}

/**
 * Resolve and contain one tool path.
 *
 * Throws `path escapes workspace: <path>` for `..` escapes, absolute paths
 * outside the workspace and symlinks that point outside it.
 */
export async function resolvePath(ctx, value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be a non-empty path string`)
  }
  const candidate = isAbsolute(value) ? resolve(value) : resolve(ctx.workspace, value)
  const resolved = await resolveReal(ctx, candidate)
  roots.set(ctx, resolved.root)
  if (!insideWorkspace(resolved.root, resolved.path)) {
    fail(`path escapes workspace: ${resolved.path}`)
  }
  return resolved.path
}

/**
 * Resolve and contain one tool path, but keep its last component as written.
 *
 * `resolvePath` follows a symlink in the final position, so `stat("link")`
 * would describe the target and `move("link", …)` would move the target. This
 * variant resolves and contains the *parent* only, so callers get `lstat`
 * semantics on the entry the model named: a link is a link, and a broken link
 * is still a link rather than a missing file.
 *
 * Containment is still real-path based: `..` escapes and a symlinked parent
 * that leaves the workspace are refused, and a destination whose parent does
 * not exist yet is contained through that parent's nearest existing ancestor.
 * Trailing separators are normalised away by `resolve`, so `a/b/` names the
 * entry `b` (POSIX `lstat("b/")` would follow a link instead).
 *
 * A path that names the workspace itself has no last component to keep apart
 * (its parent is outside the workspace by definition), so it is resolved fully.
 */
export async function resolveLexicalPath(ctx, value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be a non-empty path string`)
  }
  const candidate = isAbsolute(value) ? resolve(value) : resolve(ctx.workspace, value)
  const name = basename(candidate)
  if (name.length === 0) {
    // `"/"`, or a drive root on Windows: nothing to keep unresolved.
    return await resolvePath(ctx, candidate, field)
  }

  const parent = await resolveReal(ctx, dirname(candidate))
  roots.set(ctx, parent.root)
  if (!insideWorkspace(parent.root, parent.path)) {
    // Only the workspace itself sits in a directory that is outside it. Any
    // other target under an outside parent (a link living out there, say) is
    // refused, because the entry itself would be outside the workspace.
    const full = await resolveReal(ctx, candidate)
    if (full.path !== parent.root || !insideWorkspace(parent.root, full.path)) {
      fail(`path escapes workspace: ${full.path}`)
    }
    return parent.root
  }

  const lexical = join(parent.path, name)
  if (!insideWorkspace(parent.root, lexical)) fail(`path escapes workspace: ${lexical}`)
  return lexical
}

export function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/')
}

/** True when `target` is the workspace or a path below it (lexical). */
export function insideWorkspace(workspace, target) {
  const root = resolve(workspace)
  const rel = relative(root, resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Workspace-relative when inside it, absolute otherwise. */
export function displayPath(ctx, target) {
  const root = typeof ctx === 'string' ? resolve(ctx) : workspaceRoot(ctx)
  const resolved = resolve(target)
  if (!insideWorkspace(root, resolved)) return toPosix(resolved)
  const rel = relative(root, resolved)
  return rel === '' ? '.' : toPosix(rel)
}

/** Folder name of the project's session store, under the workspace root. */
export const SESSION_ROOT_NAME = 'z1'

/** Owner marker: only a `z1/` carrying this file is the session store. */
export const SESSION_MARKER = '.z1-sessions'

/**
 * The project's session store (`<workspaceRoot>/z1`), or `undefined`.
 *
 * A folder is z1's own state only when the owner marker `<root>/.z1-sessions`
 * is a regular file; the marker is what the session package itself writes, so
 * a project that merely *has* a `z1/` directory (the SDK's source tree) is
 * plain content and must not be hidden. `Z1_SESSIONS_DIR` can move the store
 * elsewhere; that root is not derivable here and is therefore not guarded.
 *
 * The answer is the store's **real path**, not the name `<workspace>/z1`: a
 * `z1 -> realz1` symlink makes the lexical name a different path from the
 * folder the transcripts live in, and every tool path is resolved to its real
 * path before the guard runs. Returning the real path is what makes the guard
 * hold for both names. If the marker is found but the path cannot be resolved
 * (a broken helper), the lexical candidate is returned rather than failing the
 * tool: the comparison then still covers the common, non-aliased case.
 *
 * Deliberately *not* memoised: the answer is re-read from the brokered `stat`
 * on every guard and every walk, so a store created after the first lookup is
 * hidden and refused immediately, and a store deleted with `rm -rf z1` stops
 * being refused in the same process. Caching the "not ours" or "ours" verdict
 * for the life of the worker is exactly the bug this avoids; a `stat` per call
 * is noise beside the `node -e` child every path resolution already spawns
 * (measured at a few microseconds against ~29 ms, see the README).
 *
 * A broker error (missing marker, denied path, odd filesystem) means "not
 * ours" rather than a failed tool.
 */
export async function sessionRoot(ctx) {
  const workspace = workspaceRoot(ctx)
  const candidate = join(workspace, SESSION_ROOT_NAME)
  try {
    const info = await ctx.fs.stat(join(candidate, SESSION_MARKER))
    if (info !== null && typeof info === 'object' && info.type === 'file') {
      try {
        return (await resolveReal(ctx, candidate)).path
      } catch {
        return candidate
      }
    }
  } catch {
    // not ours
  }
  return undefined
}

/**
 * Refuse a path that is the session store or inside it.
 *
 * Called after a path is resolved and contained, before any byte is written:
 * the transcript folder is managed by z1 itself (`/sessions`), and a file tool
 * editing `events.jsonl` would corrupt or forge a transcript. Reading it is
 * allowed and is not guarded here.
 *
 * Both the store's real path (what `sessionRoot` returns, so a `z1 -> realz1`
 * symlink is covered) and the lexical `<workspace>/z1` name are compared: a
 * rewrite or move through either name is refused, and a directory-level tool
 * (`mkdir`, `move`) that keeps the last component as written still cannot
 * rename the store's own symlink out of the way.
 * `tool` prefixes the message (`write: …`) like every other tool failure.
 */
export async function refuseSessionStorePath(ctx, absolute, tool) {
  const root = await sessionRoot(ctx)
  if (root === undefined) return
  const target = resolve(absolute)
  // `insideWorkspace` counts the root itself, so the folder and its children
  // are refused while a sibling `z1-sdk/` or an unmarked `z1/` is not.
  const roots = [root, join(workspaceRoot(ctx), SESSION_ROOT_NAME)]
  if (!roots.some((candidate) => insideWorkspace(candidate, target))) return
  fail(
    `${tool}: "${displayPath(ctx, target)}" is z1's own session store; ` +
      'transcripts are managed with /sessions, not file tools',
  )
}

