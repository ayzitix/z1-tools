/**
 * Harness sanity: the broker-shaped fake ctx drives real tools end to end.
 *
 * These are not regression tests for a fix; they prove the rest of the files
 * are exercising real `lib/*` behaviour and not a stub.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'

import { editTool, readTool, statTool, writeTool } from '../lib/fs.js'
import { globTool, grepTool, listTool, treeTool } from '../lib/search.js'
import { cleanup, makeCtx, makeTemp, rejection, writeFile } from './helpers.js'

async function withWorkspace(fn) {
  const workspace = await makeTemp()
  try {
    return await fn(workspace, makeCtx(workspace))
  } finally {
    await cleanup(workspace)
  }
}

test('read, write and edit round-trip through the fake broker', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'src/app.js', 'const port = 3000\n')
    assert.equal(await readTool(ctx, { path: 'src/app.js' }), '1| const port = 3000')

    await assert.rejects(readTool(ctx, { path: 'missing.txt' }), /cannot read "missing.txt"/)

    assert.equal(await writeTool(ctx, { path: 'src/new.txt', content: 'hello\n' }), 'wrote src/new.txt (6 bytes)')
    assert.equal(await readTool(ctx, { path: 'src/new.txt' }), '1| hello')

    await readTool(ctx, { path: 'src/app.js' })
    assert.equal(
      await editTool(ctx, { path: 'src/app.js', oldText: '3000', newText: '8080' }),
      'edited src/app.js (1 replacement)',
    )
    assert.equal((await readTool(ctx, { path: 'src/app.js' })).includes('8080'), true)
  })
})

test('stat, list, tree, glob and grep see real entries', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'a/one.txt', 'alpha\n')
    await writeFile(workspace, 'a/two.md', 'beta\n')
    await writeFile(workspace, 'b/three.txt', 'gamma\n')

    const stat = await statTool(ctx, { path: 'a/one.txt' })
    assert.match(stat, /^file 6 .+ 0644 a\/one\.txt$/)

    const listing = await listTool(ctx, { path: 'a' })
    assert.equal(listing, 'file one.txt (6)\nfile two.md (5)')

    const tree = await treeTool(ctx, { path: '.' })
    assert.match(tree, /one\.txt \(6 B\)/)

    const globbed = await globTool(ctx, { pattern: '**/*.txt' })
    assert.deepEqual(globbed.split('\n'), [
      'a/one.txt',
      'b/three.txt',
      '… (3 files walked)',
    ])

    const grepped = await grepTool(ctx, { pattern: 'alpha' })
    assert.match(grepped, /^a\/one\.txt:1: alpha/m)
    assert.match(grepped, /\(1 match in 1 file;/)
  })
})

test('grep keeps flags and context through the bounded matcher', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'words.txt', 'Alpha\nbeta\nALPHA\n')
    const result = await grepTool(ctx, { pattern: 'alpha', caseSensitive: false, context: 1 })
    assert.equal(
      result,
      [
        'words.txt:1: Alpha',
        'words.txt-2- beta',
        'words.txt:3: ALPHA',
        '(2 matches in 1 file; 1 file walked; 1 file searched)',
      ].join('\n'),
    )
    await assert.rejects(grepTool(ctx, { pattern: '(' }), /not a valid regular expression/)
  })
})

test('a content tool refuses an absolute path outside the workspace', async () => {
  await withWorkspace(async (workspace, ctx) => {
    const outside = join(workspace, '..', 'outside.txt')
    const error = await rejection(readTool(ctx, { path: outside }))
    assert.match(error.message, /^path escapes workspace: /)
  })
})
