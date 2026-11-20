/**
 * A dangling symlink has no `realpath` to consult, so the resolver must not
 * guess the way `path.resolve(dirname(link), readlink)` guesses.
 *
 * `link -> hop/../target` with `hop` a symlink (possibly outside) is the
 * case: the kernel enters `hop` first and applies `..` there; a lexical
 * normalisation cancels `hop` and lands inside the workspace. The old resolver
 * accepted the link and `read`/`write` acted on an inside name. Every content
 * tool must refuse, before and after the real target exists.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'

import { readTool, statTool, writeTool } from '../lib/fs.js'
import { globTool, grepTool, listTool, treeTool } from '../lib/search.js'
import { ensureWorkspaceRoot, resolvePath, workspaceRoot } from '../lib/paths.js'
import { cleanup, makeCtx, makeTemp, rejection, symlink } from './helpers.js'

async function fixture() {
  const base = await makeTemp()
  const workspace = join(base, 'ws')
  const outside = join(base, 'outside')
  await mkdir(workspace, { recursive: true })
  await mkdir(outside, { recursive: true })
  // The kernel: <ws>/hop -> <base>/outside, then .. -> <base>, then target.
  await symlink('../outside', join(workspace, 'hop'))
  await symlink('hop/../target', join(workspace, 'dlnk'))
  return { base, workspace, outside }
}

function contentCalls(ctx) {
  return [
    () => readTool(ctx, { path: 'dlnk' }),
    () => writeTool(ctx, { path: 'dlnk', content: 'poison\n' }),
    () => listTool(ctx, { path: 'dlnk' }),
    () => treeTool(ctx, { path: 'dlnk' }),
    () => globTool(ctx, { pattern: '*', path: 'dlnk' }),
    () => grepTool(ctx, { pattern: 'secret', path: 'dlnk' }),
  ]
}

test('a dangling link whose real target is outside is refused before it exists', async () => {
  const { base, workspace } = await fixture()
  try {
    const ctx = makeCtx(workspace)
    const error = await rejection(resolvePath(ctx, 'dlnk', 'probe'))
    assert.match(error.message, /^path escapes workspace: /)

    for (const call of contentCalls(ctx)) {
      const refusal = await rejection(call())
      assert.match(refusal.message, /^path escapes workspace: /)
    }

    // Metadata is still lexical: the entry is a dangling link, not a failure.
    const stat = await statTool(ctx, { path: 'dlnk' })
    assert.match(stat, /^symlink .* dlnk -> hop\/\.\.\/target \(dangling\)$/)
    assert.equal(workspaceRoot(ctx), await realpath(workspace))
  } finally {
    await cleanup(base)
  }
})

test('the same link stays refused once the outside target exists', async () => {
  const { base, workspace, outside } = await fixture()
  try {
    await writeFile(join(base, 'target'), 'the outside secret\n')
    const ctx = makeCtx(workspace)
    for (const call of contentCalls(ctx)) {
      const refusal = await rejection(call())
      assert.match(refusal.message, /^path escapes workspace: /)
    }
    // Nothing wrote through the link into the workspace.
    await assert.rejects(readFile(join(workspace, 'target')), { code: 'ENOENT' })
    assert.equal(await readFile(join(base, 'target'), 'utf8'), 'the outside secret\n')
    // Every candidate failed, so the root must be learnt from the workspace
    // itself, never from a refused candidate.
    assert.equal(await ensureWorkspaceRoot(ctx), await realpath(workspace))
    assert.equal(workspaceRoot(ctx), await realpath(workspace))
    assert.equal(outside.endsWith('outside'), true)
  } finally {
    await cleanup(base)
  }
})

test('a dangling link whose target is inside is still usable', async () => {
  const { base, workspace } = await fixture()
  try {
    await mkdir(join(workspace, 'sub'))
    await symlink('../sibling', join(workspace, 'sub/lnk'))
    const ctx = makeCtx(workspace)
    // Accepted (the resolved target is inside) but absent: a read error, not
    // a containment error.
    const missing = await rejection(readTool(ctx, { path: 'sub/lnk' }))
    assert.match(missing.message, /^cannot read "sibling": ENOENT$/)

    assert.equal(await writeTool(ctx, { path: 'sub/lnk', content: 'inside\n' }), 'wrote sibling (7 bytes)')
    assert.equal(await readTool(ctx, { path: 'sub/lnk' }), '1| inside')
    assert.equal(await readFile(join(workspace, 'sibling'), 'utf8'), 'inside\n')
  } finally {
    await cleanup(base)
  }
})
