/**
 * The hard half of grep's ReDoS defence.
 *
 * `patternCost` is a heuristic and cannot be complete, so the actual match runs
 * with a deadline. `([a-z]|[a-z][a-z])+$` passes the heuristic on purpose: its
 * two branches start with character classes, which `firstMatcher` cannot
 * compare cheaply, and one line of 36 `a`s makes it backtrack for seconds.
 * The test is therefore "bounded time", not "rejected up front".
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { grepTool, matchLines } from '../lib/search.js'
import { cleanup, makeCtx, makeTemp, writeFile } from './helpers.js'

const BOMB = '([a-z]|[a-z][a-z])+$'
const LINE = 'a'.repeat(36) + '!'

test('matchLines stops one catastrophic line at the slice deadline', () => {
  const started = Date.now()
  const result = matchLines(BOMB, 'u', [LINE], Date.now() + 5_000)
  const elapsed = Date.now() - started
  assert.equal(result.timedOut, true)
  assert.deepEqual(result.matched, [])
  assert.ok(elapsed < 2_000, `match took ${elapsed} ms`)
})

test('matchLines returns indices, clips long lines and reports the clip', () => {
  const tailOnly = `${'x'.repeat(16_100)}needle`
  const result = matchLines('needle', 'u', ['needle', 'no', tailOnly, 'needle'], Date.now() + 5_000)
  assert.equal(result.timedOut, false)
  assert.deepEqual(result.matched, [0, 3])
  assert.equal(result.clipped, 1)
})

test('grep ends a catastrophic pattern within the bound instead of hanging', async () => {
  const workspace = await makeTemp()
  try {
    const ctx = makeCtx(workspace)
    await writeFile(workspace, 'bomb.txt', `${LINE}\n`)
    const started = Date.now()
    const result = await grepTool(ctx, { pattern: BOMB, path: 'bomb.txt' })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2_000, `grep took ${elapsed} ms`)
    assert.match(result, /grep: (?:stopped after \d+ ms; narrow the query|pattern is too expensive)/)
  } finally {
    await cleanup(workspace)
  }
})
