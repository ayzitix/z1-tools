/**
 * A symlink loop is not a dangling link, and it is not a helper stack trace.
 *
 * `stat` must say `(loop)` (or `(unresolvable)`), and `read` must fail with one
 * line that names the path. Before the fix `stat` called any `statSync` error
 * "dangling", and the resolver's uncaught `node -e` error arrived as a 15-line
 * `[eval] … Error: … Node.js v26` trace.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'

import { readTool, statTool } from '../lib/fs.js'
import { cleanup, makeCtx, makeTemp, rejection, symlink } from './helpers.js'

test('stat distinguishes a symlink loop from a dangling target', async () => {
  const workspace = await makeTemp()
  try {
    const ctx = makeCtx(workspace)
    await symlink('b', join(workspace, 'a'))
    await symlink('a', join(workspace, 'b'))
    await symlink('missing', join(workspace, 'gone'))

    const loop = await statTool(ctx, { path: 'a' })
    assert.match(loop, /^symlink .* a -> b \(loop\)$/)
    assert.doesNotMatch(loop, /dangling/)

    const dangling = await statTool(ctx, { path: 'gone' })
    assert.match(dangling, /^symlink .* gone -> missing \(dangling\)$/)
    assert.doesNotMatch(dangling, /loop/)
  } finally {
    await cleanup(workspace)
  }
})

test('read through a loop reports one line, not a helper stack trace', async () => {
  const workspace = await makeTemp()
  try {
    const ctx = makeCtx(workspace)
    await symlink('b', join(workspace, 'a'))
    await symlink('a', join(workspace, 'b'))

    const error = await rejection(readTool(ctx, { path: 'a' }))
    assert.equal(error.message.includes('\n'), false, 'a tool error must be one line')
    assert.match(error.message, /^cannot resolve "[^"]*\/a": too many symbolic links$/)
    assert.ok(error.message.length < 200, `message was ${error.message.length} chars`)
    assert.doesNotMatch(error.message, /Node\.js v|\bat |\[eval\]/)
  } finally {
    await cleanup(workspace)
  }
})
