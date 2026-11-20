/**
 * The workspace root is a real path, not the string the host passed.
 *
 * A workspace can itself be a symlink. If the default base of a search is that
 * lexical name, either the walk has no valid containment root (the real root
 * does not contain `/tmp/ws/link`) or, worse, containment is decided against a
 * path that is not the filesystem's. These tests pin both halves: the root is
 * the real directory, and every content tool refuses a nested symlink that
 * leaves it.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'

import { editTool, readTool, writeTool } from '../lib/fs.js'
import { globTool, grepTool, listTool, treeTool, walk } from '../lib/search.js'
import {
  cleanup,
  exists,
  makeCtx,
  makeTemp,
  rejection,
  symlink,
  writeFile,
} from './helpers.js'
import { ensureWorkspaceRoot, workspaceRoot } from '../lib/paths.js'

test('a workspace that is a symlink resolves to its real directory', async () => {
  const base = await makeTemp()
  try {
    const real = join(base, 'real')
    const link = join(base, 'workspace-link')
    await writeFile(real, 'a.txt', 'hello\n')
    await writeFile(real, 'sub/b.txt', 'world\n')
    await symlink(real, link)
    const ctx = makeCtx(link)

    assert.equal(await readTool(ctx, { path: 'a.txt' }), '1| hello')
    assert.equal(await ensureWorkspaceRoot(ctx), await realpath(real))
    assert.equal(workspaceRoot(ctx), await realpath(real))

    // Default-root walks must see the real directory, not fail containment.
    assert.deepEqual((await globTool(ctx, { pattern: '**/*.txt' })).split('\n'), [
      'a.txt',
      'sub/b.txt',
      '… (2 files walked)',
    ])
    assert.match(await grepTool(ctx, { pattern: 'hello' }), /^a\.txt:1: hello/m)
    assert.equal(await listTool(ctx, { path: 'sub' }), 'file b.txt (6)')
    assert.match(await treeTool(ctx, {}), /sub\//)
  } finally {
    await cleanup(base)
  }
})

async function escapeFixture() {
  const base = await makeTemp()
  const workspace = join(base, 'ws')
  const outside = join(base, 'outside')
  await writeFile(workspace, 'inside/a.txt', 'alpha\n')
  await writeFile(outside, 'secret.txt', 'the outside secret\n')
  await symlink(outside, join(workspace, 'inside/escape'))
  return { base, workspace, outside }
}

test('every content tool refuses a nested directory symlinked outside', async () => {
  const { base, workspace } = await escapeFixture()
  try {
    const ctx = makeCtx(workspace)
    // Cache the real root first, so the refusal is not an artefact of no root.
    assert.equal(await readTool(ctx, { path: 'inside/a.txt' }), '1| alpha')
    const root = workspaceRoot(ctx)

    const calls = [
      () => readTool(ctx, { path: 'inside/escape/secret.txt' }),
      () => listTool(ctx, { path: 'inside/escape' }),
      () => globTool(ctx, { pattern: '*', path: 'inside/escape' }),
      () => grepTool(ctx, { pattern: 'secret', path: 'inside/escape' }),
      () => treeTool(ctx, { path: 'inside/escape' }),
      () => writeTool(ctx, { path: 'inside/escape/new.txt', content: 'x' }),
      () => editTool(ctx, { path: 'inside/escape/secret.txt', oldText: 'the', newText: 'a' }),
    ]
    for (const call of calls) {
      const error = await rejection(call())
      assert.match(error.message, /^path escapes workspace: /)
    }
    assert.equal(workspaceRoot(ctx), root, 'a refused candidate must not change the cached root')
  } finally {
    await cleanup(base)
  }
})

test('a failed first resolution does not become the cached root', async () => {
  const { base, workspace } = await escapeFixture()
  try {
    const ctx = makeCtx(workspace)
    // No successful resolution yet: the failing candidate must not be cached.
    const error = await rejection(readTool(ctx, { path: 'inside/escape/secret.txt' }))
    assert.match(error.message, /^path escapes workspace: /)
    assert.equal(await ensureWorkspaceRoot(ctx), await realpath(workspace))
    assert.equal(workspaceRoot(ctx), await realpath(workspace))
  } finally {
    await cleanup(base)
  }
})

test('walk asserts containment for a base no tool resolved', async () => {
  const { base, workspace } = await escapeFixture()
  try {
    const ctx = makeCtx(workspace)
    const outside = join(base, 'outside')
    const error = await rejection(walk(ctx, outside, 2))
    assert.match(error.message, /^path escapes workspace: /)
    assert.equal(await exists(join(outside, 'secret.txt')), true)
  } finally {
    await cleanup(base)
  }
})
