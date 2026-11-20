/**
 * Reporting fixes: notes that should not be noise, counts that should be
 * comparable, and fallbacks that should not lie.
 *
 * Each block here pins one item from the low-severity list, because a report
 * that says the wrong thing trains the model to distrust the right things.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { chmod, mkdir, readFile, stat } from 'node:fs/promises'

import { keptModeNotes, readTool, statTool, writeTool } from '../lib/fs.js'
import { applyPatch } from '../lib/patch.js'
import {
  MAX_GREP_LINE_CHARS,
  globTool,
  grepTool,
  listTool,
  treeTool,
} from '../lib/search.js'
import {
  cleanup,
  makeCtx,
  makeTemp,
  rejection,
  runProcess,
  symlink,
  writeFile,
} from './helpers.js'

async function withWorkspace(fn) {
  const workspace = await makeTemp()
  try {
    return await fn(workspace, makeCtx(workspace))
  } finally {
    await cleanup(workspace)
  }
}

test('kept-mode notes leave ordinary files alone and warn about unreadable ones', () => {
  assert.deepEqual(keptModeNotes(0o644), [])
  assert.deepEqual(keptModeNotes(0o755), [])
  assert.deepEqual(keptModeNotes(0o600), ['kept mode 0600'])
  assert.deepEqual(keptModeNotes(0o000), [
    'kept mode 0000',
    'warning: the resulting file is not readable (mode 0000)',
  ])
  assert.deepEqual(keptModeNotes(0o200), [
    'kept mode 0200',
    'warning: the resulting file is not readable (mode 0200)',
  ])
})

test('an ordinary 0755 script is rewritten without a kept-mode note', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'script.sh', 'echo\n')
    await readTool(ctx, { path: 'script.sh' })
    await chmod(join(workspace, 'script.sh'), 0o755)
    assert.equal(
      await writeTool(ctx, { path: 'script.sh', content: 'echo hi\n' }),
      'wrote script.sh (8 bytes)',
    )
    const after = await stat(join(workspace, 'script.sh'))
    assert.equal(after.mode & 0o777, 0o755)
  })
})

test('apply_patch counts the applied region, not the quoted halves', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'a.txt', 'one\ntwo\nthree\n')
    const patch = [
      'a.txt',
      '<<<<<<< SEARCH',
      'two',
      '=======',
      'two',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      'three',
      '=======',
      'THREE',
      'four',
      '>>>>>>> REPLACE',
    ].join('\n')
    const result = await applyPatch(ctx, { patch })
    assert.equal(
      result,
      ['patched 1 block in 1 file (1 block made no change)', 'a.txt (+2 -1 block lines)'].join('\n'),
    )
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'one\ntwo\nTHREE\nfour\n')
  })
})

test('glob and grep report the same walked and ignored counters', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, '.gitignore', 'skip.log\n')
    await writeFile(workspace, 'skip.log', 'needle\n')
    await writeFile(workspace, 'node_modules/x.txt', 'noise\n')
    await writeFile(workspace, 'a.txt', 'needle\n')
    await writeFile(workspace, 'b.txt', 'needle\n')

    const glob = await globTool(ctx, { pattern: '**/*' })
    const globCounts = /(\d+) files walked; (\d+) ignored paths skipped/.exec(glob)
    assert.notEqual(globCounts, null, glob)

    const grep = await grepTool(ctx, { pattern: 'needle' })
    const grepCounts = /(\d+) files walked; (\d+) files searched; (\d+) ignored paths skipped/.exec(grep)
    assert.notEqual(grepCounts, null, grep)

    assert.equal(globCounts[1], grepCounts[1], 'files walked must match')
    assert.equal(globCounts[2], grepCounts[3], 'ignored paths must match')
    assert.equal(globCounts[1], '3')
    assert.equal(globCounts[2], '2')
  })
})

test('a long path does not eat the content clip', async () => {
  await withWorkspace(async (workspace, ctx) => {
    const segment = 'd'.repeat(50)
    const directory = [segment, segment, segment, segment, segment].join('/')
    const content = `needle${'x'.repeat(600)}`
    await writeFile(workspace, `${directory}/file.txt`, `${content}\n`)

    const output = await grepTool(ctx, { pattern: 'needle' })
    const hit = output.split('\n')[0]
    const split = hit.indexOf(':1: ')
    assert.notEqual(split, -1, hit)
    const shownPath = hit.slice(0, split)
    const shownContent = hit.slice(split + 4)
    assert.match(shownPath, /… \+\d+ chars$/)
    assert.ok(shownContent.startsWith('needle'))
    assert.ok(shownContent.length > MAX_GREP_LINE_CHARS, `content was ${shownContent.length} chars`)
    assert.match(shownContent, /… \+\d+ chars$/)
  })
})

test('glob rejects an unterminated class and a bare slash clearly', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'a.txt', 'a\n')
    await writeFile(workspace, 'b.txt', 'b\n')
    const bad = await rejection(globTool(ctx, { pattern: '[' }))
    assert.match(bad.message, /^glob\.pattern is not a valid glob: unterminated character class/)
    const slash = await rejection(globTool(ctx, { pattern: '/' }))
    assert.match(slash.message, /^glob\.pattern is not a valid glob: "\/" is not a file pattern$/)
    assert.equal(await globTool(ctx, { pattern: '[ab].txt' }), 'a.txt\nb.txt\n… (2 files walked)')
  })
})

test('list, tree and the searches treat a symlink alias of the store as the store', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await mkdir(join(workspace, 'z1'))
    await writeFile(workspace, 'z1/.z1-sessions', '')
    await writeFile(workspace, 'a.txt', 'needle\n')
    await symlink('z1', join(workspace, 'realz1'))

    const listing = await listTool(ctx, { path: '.', recursive: true })
    assert.match(listing, /^dir z1 \(z1 state, ignored\)$/m)
    assert.match(listing, /^link realz1 \(z1 state, ignored\)$/m)

    const tree = await treeTool(ctx, {})
    assert.match(tree, /realz1 -> z1 \(z1 state, ignored\)/)

    const glob = await globTool(ctx, { pattern: '**/*' })
    assert.match(glob, /2 ignored paths skipped/)
    const grep = await grepTool(ctx, { pattern: 'needle' })
    assert.match(grep, /2 ignored paths skipped/)
  })
})

test('the documented z1 -> realz1 direction keeps both names marked', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await mkdir(join(workspace, 'realz1'))
    await writeFile(workspace, 'realz1/.z1-sessions', '')
    await symlink('realz1', join(workspace, 'z1'))
    const listing = await listTool(ctx, { path: '.', recursive: true })
    assert.match(listing, /^dir realz1 \(z1 state, ignored\)$/m)
    assert.match(listing, /^link z1 \(z1 state, ignored\)$/m)
  })
})

test('the stat fallback reports unknown rather than a symlink target type', async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(workspace, 'target.txt', 'x\n')
    await symlink('target.txt', join(workspace, 'link'))
    const denyStatHelper = (request) => {
      if (String(request.args?.[1] ?? '').includes('specialOf')) {
        return Promise.reject(new Error('helper denied'))
      }
      return runProcess(request)
    }

    const unknownCtx = makeCtx(workspace, { run: denyStatHelper, list: false })
    const unknown = await statTool(unknownCtx, { path: 'link' })
    assert.match(unknown, /^unknown /)
    assert.doesNotMatch(unknown, /^file /)

    // With the broker's list available, the entry type can be reported
    // honestly instead of guessing from the target.
    const listedCtx = makeCtx(workspace, { run: denyStatHelper })
    const honest = await statTool(listedCtx, { path: 'link' })
    assert.match(honest, /^symlink /)
  })
})
