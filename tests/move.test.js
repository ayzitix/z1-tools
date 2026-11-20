/**
 * `move` checks the destination parent, creates it if needed, and then
 * renames. The check and the rename are separate syscalls, so a parent swapped
 * for a symlink after the check used to redirect the entry outside the
 * workspace — deliberately, in two tool calls, no race required.
 *
 * The fix has two layers: the parent is re-resolved immediately before the
 * helper, and the helper compares the parent's `dev:ino` with the identity
 * that was checked. This test injects the swap at the helper boundary (the one
 * moment a test can place it without a thread race), which is exactly what the
 * helper's identity check exists for.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { mkdir, readFile, rename } from 'node:fs/promises'

import { moveTool } from '../lib/fs.js'
import {
  cleanup,
  exists,
  makeCtx,
  makeTemp,
  runProcess,
  symlink,
  writeFile,
} from './helpers.js'

const isMoveHelper = (request) =>
  Array.isArray(request.args) && String(request.args[1] ?? '').includes('preserveMetadata')

test('move refuses a destination parent swapped for an outside symlink', async () => {
  const base = await makeTemp()
  const workspace = join(base, 'ws')
  const outside = join(base, 'outside')
  try {
    await mkdir(workspace, { recursive: true })
    await mkdir(outside, { recursive: true })
    await mkdir(join(workspace, 'dest'))
    await writeFile(workspace, 'src.txt', 'payload\n')

    let swapped = false
    const ctx = makeCtx(workspace, {
      run: async (request) => {
        // The check and re-resolution have happened; now replace the checked
        // directory with a symlink to the outside, then run the real helper.
        if (!swapped && isMoveHelper(request)) {
          swapped = true
          await rename(join(workspace, 'dest'), join(workspace, 'dest-real'))
          await symlink(outside, join(workspace, 'dest'))
        }
        return runProcess(request)
      },
    })

    await assert.rejects(
      moveTool(ctx, { from: 'src.txt', to: 'dest/src.txt' }),
      (thrown) => {
        assert.match(
          thrown.message,
          /destination parent changed|path escapes workspace/,
        )
        return true
      },
    )
    assert.equal(swapped, true)
    // The entry did not land outside and the source is untouched.
    assert.equal(await exists(join(outside, 'src.txt')), false)
    assert.equal(await readFile(join(workspace, 'src.txt'), 'utf8'), 'payload\n')
  } finally {
    await cleanup(base)
  }
})

test('move still renames inside a checked, existing parent', async () => {
  const base = await makeTemp()
  const workspace = join(base, 'ws')
  try {
    await mkdir(join(workspace, 'dest'), { recursive: true })
    await writeFile(workspace, 'src.txt', 'payload\n')
    const ctx = makeCtx(workspace)
    assert.equal(
      await moveTool(ctx, { from: 'src.txt', to: 'dest/src.txt' }),
      'moved src.txt -> dest/src.txt',
    )
    assert.equal(await readFile(join(workspace, 'dest/src.txt'), 'utf8'), 'payload\n')
    assert.equal(await exists(join(workspace, 'src.txt')), false)
  } finally {
    await cleanup(base)
  }
})

test('move creates a missing destination parent inside the workspace', async () => {
  const base = await makeTemp()
  const workspace = join(base, 'ws')
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(workspace, 'src.txt', 'payload\n')
    const ctx = makeCtx(workspace)
    assert.equal(
      await moveTool(ctx, { from: 'src.txt', to: 'new/deep/src.txt' }),
      'moved src.txt -> new/deep/src.txt',
    )
    assert.equal(await readFile(join(workspace, 'new/deep/src.txt'), 'utf8'), 'payload\n')
  } finally {
    await cleanup(base)
  }
})
