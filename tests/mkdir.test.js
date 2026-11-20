/**
 * `mkdir` on a final symlink used to give two wrong answers: a link to an
 * outside directory reported `exists … (directory)` (as if it were inside),
 * and a dangling link reported "pass recursive: true" even though recursive
 * creation also fails. The link's target decides, and an outside target is a
 * containment failure.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

import { mkdirTool } from '../lib/fs.js'
import { cleanup, exists, makeCtx, makeTemp, rejection, symlink, writeFile } from './helpers.js'

async function fixture() {
  const base = await makeTemp()
  const workspace = join(base, 'ws')
  const outside = join(base, 'outside')
  await mkdir(join(workspace, 'inside-dir'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await symlink(join(outside, 'dir'), join(workspace, 'lnk-out'))
  await symlink(join(outside, 'missing'), join(workspace, 'dlnk-out'))
  await symlink('inside-dir', join(workspace, 'lnk-in'))
  await symlink('inside-missing', join(workspace, 'dlnk-in'))
  return { base, workspace, outside }
}

test('mkdir refuses a final symlink whose target is outside (existing or dangling)', async () => {
  const { base, workspace } = await fixture()
  try {
    await mkdir(join(base, 'outside/dir'), { recursive: true })
    const ctx = makeCtx(workspace)
    for (const path of ['lnk-out', 'dlnk-out']) {
      for (const recursive of [undefined, true]) {
        const error = await rejection(mkdirTool(ctx, { path, recursive }))
        assert.match(error.message, /^path escapes workspace: /, `${path} recursive=${recursive}`)
      }
    }
    // Nothing created outside.
    assert.equal(await exists(join(base, 'outside/missing')), false)
  } finally {
    await cleanup(base)
  }
})

test('mkdir accepts a symlink to an inside directory', async () => {
  const { base, workspace } = await fixture()
  try {
    const ctx = makeCtx(workspace)
    assert.equal(await mkdirTool(ctx, { path: 'lnk-in' }), 'exists lnk-in (directory)')
  } finally {
    await cleanup(base)
  }
})

test('mkdir advice for a dangling inside symlink does not suggest recursive', async () => {
  const { base, workspace } = await fixture()
  try {
    const ctx = makeCtx(workspace)
    for (const recursive of [undefined, true]) {
      const error = await rejection(mkdirTool(ctx, { path: 'dlnk-in', recursive }))
      assert.match(error.message, /symbolic link whose target does not exist/)
      assert.doesNotMatch(error.message, /recursive: true/)
    }
  } finally {
    await cleanup(base)
  }
})

test('mkdir keeps the ordinary cases unchanged', async () => {
  const { base, workspace } = await fixture()
  try {
    const ctx = makeCtx(workspace)
    assert.match(await mkdirTool(ctx, { path: 'new-dir' }), /^created new-dir with mode 0[0-7]{3}$/)
    assert.equal(await mkdirTool(ctx, { path: 'new-dir' }), 'exists new-dir (directory)')
    await writeFile(workspace, 'plain.txt', 'x\n')
    await assert.rejects(mkdirTool(ctx, { path: 'plain.txt' }), /target exists and is not a directory/)
  } finally {
    await cleanup(base)
  }
})
