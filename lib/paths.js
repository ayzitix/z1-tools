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
 *   workspace are refused before anything is read or written;
 * - a dangling symlink is resolved component by component, so its target's
 *   `..` is applied to the directory the kernel would be in rather than to a
 *   lexically normalised string (`hop/../target` with `hop` a symlink cannot
 *   cancel `hop` away) — an unvalidated guess is refused, not cached.
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

/**
 * Resolve symlinks component by component so a link target's `..` is applied
 * to the directory the kernel would be in, not to the lexically normalised
 * string.
 *
 * `path.resolve(dirname(link), readlink)` is wrong for `link -> hop/../target`
 * when `hop` is a symlink: the kernel enters `hop` (possibly outside the
 * workspace), then applies `..` there, while `path.resolve` cancels `hop`
 * away. A dangling link has no `realpath` to fall back on, so the guess was
 * accepted even when the target was outside. This walks each component:
 * `..` pops the real base, a symlink restarts with its raw target, and once a
 * component is missing nothing below it can be a link, so the tail is applied
 * to the real base (popping `..` physically) and returned. That is the path
 * the kernel would produce if the missing tail were created.
 */
const RESOLVE_SCRIPT = [
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  'const target = process.argv[1]',
  'const root = fs.realpathSync(process.cwd())',
  'const rootPart = path.parse(target).root',
  'function partsOf(value) {',
  '  return value.split(path.sep).filter((part) => part !== "" && part !== ".")',
  '}',
  'let hops = 0',
  'function resolveParts(base, parts) {',
  '  for (let index = 0; index < parts.length; index += 1) {',
  '    const part = parts[index]',
  '    if (part === "" || part === ".") continue',
  '    if (part === "..") { base = path.dirname(base); continue }',
  '    const next = path.join(base, part)',
  '    let info',
  '    try { info = fs.lstatSync(next) }',
  '    catch (error) {',
  '      const code = error === null || typeof error !== "object" ? undefined : error.code',
  '      if (code !== "ENOENT" && code !== "ENOTDIR") throw error',
  '      let rest = base',
  '      for (let restIndex = index; restIndex < parts.length; restIndex += 1) {',
  '        const restPart = parts[restIndex]',
  '        if (restPart === "" || restPart === ".") continue',
  '        rest = restPart === ".." ? path.dirname(rest) : path.join(rest, restPart)',
  '      }',
  '      return rest',
  '    }',
  '    if (!info.isSymbolicLink()) { base = next; continue }',
  '    hops += 1',
  '    if (hops > 40) throw new Error("too many symbolic links")',
  '    const link = fs.readlinkSync(next)',
  '    const rest = parts.slice(index + 1)',
  '    if (path.isAbsolute(link)) {',
  '      const linkRoot = path.parse(link).root',
  '      return resolveParts(linkRoot, partsOf(link.slice(linkRoot.length)).concat(rest))',
  '    }',
  '    return resolveParts(base, partsOf(link).concat(rest))',
  '  }',
  '  return base',
  '}',
  'process.stdout.write(JSON.stringify({',
  '  root,',
  '  path: resolveParts(rootPart, partsOf(target.slice(rootPart.length))),',
  '}))',
].join('\n')

/** Real workspace roots, learnt once per context from a validated resolution. */
const roots = new WeakMap()

function sameRoot(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * The workspace as the filesystem sees it, resolved once and then cached.
 *
 * `ctx.workspace` can itself be a symlink (`/tmp/ws -> /srv/project`), so the
 * lexical string is not a containment root: comparing real paths against it
 * would either reject every valid path or accept paths the real root does not
 * contain. The real path comes from the same helper `resolvePath` uses, with
 * the helper's cwd fixed at `resolve(ctx.workspace)`, so the root and every
 * later resolution agree. A workspace that cannot be resolved fails the tool
 * instead of falling back to the guess.
 */
export async function ensureWorkspaceRoot(ctx) {
  const cached = roots.get(ctx)
  if (cached !== undefined) return cached
  if (typeof ctx.workspace !== 'string' || ctx.workspace.length === 0) {
    fail('cannot resolve the workspace: ctx.workspace is not a path')
  }
  const resolved = await resolveReal(ctx, resolve(ctx.workspace))
  // `resolved.root` is `realpath(cwd)`; `resolved.path` is the real path of
  // the name. Both are the workspace, or one of them is a guess.
  if (!sameRoot(resolved.root, resolved.path)) {
    fail(`cannot resolve workspace "${ctx.workspace}": the real root is ambiguous`)
  }
  roots.set(ctx, resolved.root)
  return resolved.root
}

/**
 * The cached real workspace root.
 *
 * Sync because containment checks and display names run after a path has been
 * resolved; callers that have no path yet (`glob`, `grep`, `tree` without
 * `path`) must `await ensureWorkspaceRoot` first. There is deliberately no
 * lexical fallback: that fallback let a default-root walk trust a path no
 * containment check had ever seen.
 */
export function workspaceRoot(ctx) {
  const root = roots.get(ctx)
  if (root === undefined) {
    fail(`cannot resolve workspace "${ctx.workspace}": the workspace root has not been resolved`)
  }
  return root
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
  // Cache only a root that has just passed containment: caching before the
  // check let a failed candidate decide the root for the rest of the process.
  if (!insideWorkspace(resolved.root, resolved.path)) {
    fail(`path escapes workspace: ${resolved.path}`)
  }
  roots.set(ctx, resolved.root)
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
  if (!insideWorkspace(parent.root, parent.path)) {
    // Only the workspace itself sits in a directory that is outside it. Any
    // other target under an outside parent (a link living out there, say) is
    // refused, because the entry itself would be outside the workspace.
    const full = await resolveReal(ctx, candidate)
    if (full.path !== parent.root || !insideWorkspace(parent.root, full.path)) {
      fail(`path escapes workspace: ${full.path}`)
    }
    roots.set(ctx, parent.root)
    return parent.root
  }

  const lexical = join(parent.path, name)
  if (!insideWorkspace(parent.root, lexical)) fail(`path escapes workspace: ${lexical}`)
  // Only a validated parent becomes the cached root; the failed branch above
  // never reaches this line.
  roots.set(ctx, parent.root)
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
  const workspace = await ensureWorkspaceRoot(ctx)
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

