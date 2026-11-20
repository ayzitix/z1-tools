/**
 * `read` refuses a NUL or U+FFFD, and `write` used to refuse the same file
 * because the read-before-overwrite map had no entry: the README's "replace
 * the whole file with write" was impossible.
 *
 * The escape hatch is narrow: `write` accepts a binary file only when this
 * process's `read` refused *those exact bytes* (sha256) and nothing changed
 * since. A text file still needs a successful read; `edit`/`apply_patch` still
 * refuse a binary file outright.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile as writeRaw } from 'node:fs/promises'
import { join } from 'node:path'

import { editTool, readTool, writeTool } from '../lib/fs.js'
import { cleanup, makeCtx, makeTemp, rejection, writeFile } from './helpers.js'

async function withWorkspace(fn) {
  const workspace = await makeTemp()
  try {
    return await fn(workspace, makeCtx(workspace))
  } finally {
    await cleanup(workspace)
  }
}

for (const [label, binary] of [
  ['a NUL byte', 'a\u0000b\n'],
  ['a valid UTF-8 U+FFFD', 'a\uFFFDb\n'],
]) {
  test(`write replaces a file read refused for ${label}`, async () => {
    await withWorkspace(async (workspace, ctx) => {
      await writeFile(workspace, 'data.txt', binary)

      // Before the refused read there is no escape hatch.
      const blind = await rejection(writeTool(ctx, { path: 'data.txt', content: 'ok\n' }))
      assert.match(blind.message, /^write: read "data\.txt" before overwriting it$/)

      const refused = await rejection(readTool(ctx, { path: 'data.txt' }))
      assert.match(refused.message, /^cannot read "data\.txt": binary file: data\.txt$/)

      assert.equal(
        await writeTool(ctx, { path: 'data.txt', content: 'ok\n' }),
        'wrote data.txt (3 bytes, replaced a file the tools read as binary)',
      )
      assert.equal(await readFile(join(workspace, 'data.txt'), 'utf8'), 'ok\n')
      // The file is text now; the next write is allowed because this process
      // wrote (and refreshed) those bytes, exactly like any other `write`.
      assert.equal(
        await writeTool(ctx, { path: 'data.txt', content: 'more\n' }),
        'wrote data.txt (5 bytes)',
      )
    })
  })
}

test('the refused-read escape hatch is invalidated by a change', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'data.txt', 'a\u0000b\n')
    await assert.rejects(readTool(ctx, { path: 'data.txt' }), /binary file/)
    // Something else rewrote the bytes after the refused read.
    await writeRaw(join(workspace, 'data.txt'), 'different\u0000bytes\n')
    const error = await rejection(writeTool(ctx, { path: 'data.txt', content: 'ok\n' }))
    assert.match(error.message, /^write: "data\.txt" changed since read; read it again before overwriting it$/)
  })
})

test('edit still refuses a binary file even after read refused it', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'data.txt', 'a\uFFFDb\n')
    await assert.rejects(readTool(ctx, { path: 'data.txt' }), /binary file/)
    const error = await rejection(
      editTool(ctx, { path: 'data.txt', oldText: 'a', newText: 'c' }),
    )
    assert.match(error.message, /binary file \(NUL or U\+FFFD in the file\); edit never re-encodes it/)
  })
})

test('write replaces a binary file even after an earlier text read was recorded', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'data.txt', 'text\n')
    await readTool(ctx, { path: 'data.txt' }) // a normal read hash exists
    await writeRaw(join(workspace, 'data.txt'), 'a\u0000b\n') // became binary
    await assert.rejects(readTool(ctx, { path: 'data.txt' }), /binary file/)
    assert.equal(
      await writeTool(ctx, { path: 'data.txt', content: 'ok\n' }),
      'wrote data.txt (3 bytes, replaced a file the tools read as binary)',
    )
    assert.equal(await readFile(join(workspace, 'data.txt'), 'utf8'), 'ok\n')
  })
})

test('a text file still cannot be overwritten without a read', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'data.txt', 'plain text\n')
    const error = await rejection(writeTool(ctx, { path: 'data.txt', content: 'ok\n' }))
    assert.match(error.message, /^write: read "data\.txt" before overwriting it$/)
    assert.equal(await readFile(join(workspace, 'data.txt'), 'utf8'), 'plain text\n')
  })
})
