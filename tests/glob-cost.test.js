/**
 * A glob becomes a regex, and a glob had no cost gate while `grep.pattern` had
 * two. `{a,aa}` thirty times divides a run of `a` in 2^30 ways, so `glob`,
 * `grep`'s file filter and a `.gitignore` line all used to hang the worker for
 * as long as the walk kept testing paths.
 *
 * These tests pin the gate at all three inputs, the price it charges (a shape
 * the gate allows must stay fast on a real 200-character name), the length cap
 * that keeps the price scan and the compiler off quadratic work, the note that
 * makes a skipped `.gitignore` line visible, and the ordinary patterns that
 * must keep working.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  GLOB_PRICE_TEXT,
  MAX_GLOB_COST,
  MAX_GLOB_PATTERN_LENGTH,
  globPatternCost,
  globPatternWays,
  globToRegExp,
  globTool,
  grepTool,
  treeTool,
} from '../lib/search.js'
import { cleanup, makeCtx, makeTemp, rejection, writeFile } from './helpers.js'

/** The shape that hung: each group doubles the ways to split the same text. */
const EXPENSIVE = '{a,aa}'.repeat(30)
/** The same braces hidden behind an unterminated class, which is a literal. */
const HIDDEN = `[a${EXPENSIVE}`
/** An escaped `]` never closes a class: 13 characters, one backslash. */
const ESCAPED_BRACKET = '[*a*a*a*a*b\\]'
/** The same text with the backslash escaped, so the class closes at the `]`. */
const CLOSED_BRACKET = '[*a*a*a*a*b\\\\]'

/** `ctx` whose broker `list` counts calls, so "no walk ran" is observable. */
function countingList(ctx) {
  ctx.listed = 0
  const list = ctx.fs.list.bind(ctx.fs)
  ctx.fs.list = async (directory) => {
    ctx.listed += 1
    return await list(directory)
  }
  return ctx
}

async function withWorkspace(fn) {
  const workspace = await makeTemp()
  try {
    return await fn(workspace, makeCtx(workspace))
  } finally {
    await cleanup(workspace)
  }
}

test('the price is alternatives times the ways k stars divide GLOB_PRICE_TEXT', () => {
  assert.equal(GLOB_PRICE_TEXT, 200)
  assert.equal(MAX_GLOB_COST, 8_000_000)
  // 3 stars: C(203, 3) = 1 373 701; the brace groups multiply it.
  assert.equal(globPatternWays('*a*a*b'), 1_373_701)
  assert.equal(globPatternWays('{a,aa}{a,aa}*a*a*b'), 4 * 1_373_701)
  assert.equal(globPatternWays('file[0-9].txt'), 1)
  // 22 `{a,aa}` groups are 2^22 ways, one more group passes the cap.
  assert.equal(globPatternWays('{a,aa}'.repeat(22)), 2 ** 22)
  assert.equal(globPatternCost('{a,aa}'.repeat(22)), undefined)
  assert.equal(globPatternCost('{a,aa}'.repeat(23)), 'cost')
  // 4 stars would be C(204, 4) = 70 058 751: the scan stops at the cap and
  // answers Infinity instead of a number, so a caller cannot keep going.
  assert.equal(globPatternWays('*a*a*a*b'), Number.POSITIVE_INFINITY)
  assert.equal(globPatternCost('*a*a*a*b'), 'cost')
})

test('the length gate bounds the price scan and the translation', () => {
  assert.equal(MAX_GLOB_PATTERN_LENGTH, 1024)
  // Over the cap the pattern is refused without being scanned at all: a
  // pattern of openers used to be quadratic (`{` x 30 000 took 7.7 s).
  assert.equal(globPatternWays('{'.repeat(30_000)), Number.POSITIVE_INFINITY)
  assert.equal(globPatternCost('['.repeat(30_000)), 'cost')
  // At the limit the price is still computed; one character more is refused.
  assert.equal(globPatternCost('a'.repeat(MAX_GLOB_PATTERN_LENGTH)), undefined)
  assert.equal(globPatternCost('a'.repeat(MAX_GLOB_PATTERN_LENGTH + 1)), 'cost')
  // Openers at the limit are allowed (no group closes, so no alternatives) and
  // must be priced in one linear pass, not look-ahead per brace.
  const started = Date.now()
  assert.equal(globPatternCost('{'.repeat(MAX_GLOB_PATTERN_LENGTH)), undefined)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 200, `pricing ${MAX_GLOB_PATTERN_LENGTH} openers took ${elapsed} ms`)
})

test('the gate refuses the shapes that hang a backtracking engine', () => {
  for (const pattern of [
    EXPENSIVE,
    HIDDEN,
    HIDDEN + '*a*a*a*a*a',
    '*a*a*a*b',
    '*a'.repeat(8) + 'b',
    '**/'.repeat(20) + '*',
    '{a,aa}'.repeat(23),
  ]) {
    assert.equal(globPatternCost(pattern), 'cost', `expected ${pattern} to be refused`)
  }
})

test('the gate allows the patterns a source search writes', () => {
  for (const pattern of [
    '**/*.js',
    '*.{ts,js}',
    '*.{ts,tsx,js,jsx}',
    'src/**/test/**/*.spec.ts',
    '**/*.test.*',
    '[a-z]*.md',
    'file[0-9].txt',
    '\\{a,aa\\}',
    '!neg',
  ]) {
    assert.equal(globPatternCost(pattern), undefined, `expected ${pattern} to be affordable`)
    // An allowed pattern has to compile the same way through the real path.
    assert.doesNotThrow(() => globToRegExp(pattern))
  }
})

test('an unterminated class does not hide the braces behind it', () => {
  // `[a` is a literal `[` in the translation, so what follows it is compiled
  // and must be priced: the old scanner jumped to the end of the pattern there.
  assert.equal(globPatternCost(HIDDEN), 'cost')
  assert.equal(globPatternCost(`${HIDDEN}*a*a*a*a*a`), 'cost')
  // A closed class is skipped as a class, so its own braces are not counted.
  assert.equal(globPatternCost('[a{b]c'), undefined)
})

test('glob refuses a long pattern by length, before it prices or walks', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'keep.txt', 'x\n')
    const counting = countingList(ctx)
    for (const [pattern, length] of [
      ['{'.repeat(20_000), 20_000],
      ['['.repeat(30_000), 30_000],
    ]) {
      const started = Date.now()
      const error = await rejection(globTool(counting, { pattern }))
      const elapsed = Date.now() - started
      assert.match(error.message, new RegExp(`glob\\.pattern is too long \\(${length} chars, limit 1024\\)`))
      assert.equal(counting.listed, 0, 'a long pattern must be refused before any listing')
      assert.ok(elapsed < 200, `expected a refusal in well under 200 ms, took ${elapsed} ms`)
    }
    // One character over the limit is refused, at the limit the pattern is
    // accepted and answered from the walk.
    const over = await rejection(globTool(counting, { pattern: 'a'.repeat(1025) }))
    assert.match(over.message, /glob\.pattern is too long \(1025 chars, limit 1024\)/)
    assert.match(await globTool(counting, { pattern: 'a'.repeat(1024) }), /\(no matches\)|keep\.txt/)
  })
})

test('grep refuses a long glob filter by length, before it resolves a path', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'keep.txt', 'needle\n')
    const counting = countingList(ctx)
    for (const [glob, length] of [
      ['{'.repeat(20_000), 20_000],
      ['['.repeat(30_000), 30_000],
    ]) {
      const started = Date.now()
      const error = await rejection(grepTool(counting, { pattern: 'needle', glob }))
      const elapsed = Date.now() - started
      assert.match(error.message, new RegExp(`grep\\.glob is too long \\(${length} chars, limit 1024\\)`))
      assert.equal(counting.listed, 0, 'a long filter must be refused before any listing')
      assert.ok(elapsed < 200, `expected a refusal in well under 200 ms, took ${elapsed} ms`)
    }
    // The refusal is an argument check: no helper child ran for the workspace.
    const answer = await grepTool(ctx, { pattern: 'needle', glob: '*.txt' })
    assert.match(answer, /keep\.txt:1: needle/)
  })
})

test('glob refuses an expensive pattern before it walks', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'a'.repeat(80), 'x\n')
    const counting = countingList(ctx)
    for (const pattern of [EXPENSIVE, HIDDEN]) {
      const error = await rejection(globTool(counting, { pattern }))
      assert.match(error.message, /glob\.pattern is too expensive/)
      // Deterministic: the answer cannot come from a walk that never started.
      assert.equal(counting.listed, 0, 'the pattern must be priced before any listing')
    }
  })
})

test('grep refuses an expensive glob filter before it walks', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'a'.repeat(80), 'needle\n')
    const counting = countingList(ctx)
    for (const glob of [EXPENSIVE, HIDDEN]) {
      const error = await rejection(grepTool(counting, { pattern: 'needle', glob }))
      assert.match(error.message, /grep\.glob is too expensive/)
      assert.equal(counting.listed, 0, 'the filter must be priced before any listing')
    }
  })
})

test('an expensive .gitignore line is skipped, counted, and the rest still applies', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'a'.repeat(80), 'kept\n')
    await writeFile(workspace, 'debug.log', 'noise\n')
    await writeFile(workspace, 'keep.txt', 'kept\n')
    // Both spellings that used to hang: plain braces, and braces after an
    // unterminated class (one rule each, however long the line is).
    await writeFile(workspace, '.gitignore', `${EXPENSIVE}\n${HIDDEN}\n*.log\n`)

    // Deterministic: neither line can be compiled, so neither is applied.
    assert.equal(globPatternCost(EXPENSIVE), 'cost')
    assert.equal(globPatternCost(HIDDEN), 'cost')

    const globOut = await globTool(ctx, { pattern: '**/*' })
    const grepOut = await grepTool(ctx, { pattern: 'kept' })
    const treeOut = await treeTool(ctx, {})

    for (const answer of [globOut, grepOut, treeOut]) {
      assert.match(answer, /… \(ignored 2 unsafe \.gitignore rules\)/)
    }
    // The ordinary rule from the same file still prunes, so the unsafe lines
    // did not disable the file.
    assert.doesNotMatch(globOut, /debug\.log/)
    assert.match(globOut, /keep\.txt/)
    assert.match(grepOut, /keep\.txt:1: kept/)
    // The rules were skipped, not applied: the pathological names are content.
    assert.match(globOut, new RegExp(`^${'a'.repeat(80)}$`, 'm'))
  })
})

test('a 30 KB .gitignore line is skipped by length and the walk still finishes', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, 'keep.txt', 'kept\n')
    await writeFile(workspace, 'debug.log', 'noise\n')
    // One 30 KB rule and eight 15 KB ones: each is skipped by the length gate
    // rather than scanned and compiled (that cost 4.9 s per walk, per rule).
    const lines = ['{'.repeat(30_000)]
    for (let index = 0; index < 8; index += 1) lines.push('['.repeat(15_000))
    lines.push('*.log')
    await writeFile(workspace, '.gitignore', `${lines.join('\n')}\n`)

    const started = Date.now()
    const globOut = await globTool(ctx, { pattern: '**/*' })
    const elapsed = Date.now() - started
    assert.match(globOut, /… \(ignored 9 unsafe \.gitignore rules\)/)
    assert.match(globOut, /keep\.txt/)
    assert.doesNotMatch(globOut, /debug\.log/)
    // Coarse guard: the point is that the walk returns at all, not a benchmark.
    assert.ok(elapsed < 2000, `a 30 KB ignore rule took ${elapsed} ms to get past`)
  })
})

test('the worst affordable shapes stay fast on a 200-character name', async () => {
  // What the cap buys, measured on a 200-character name with a trailing
  // mismatch: 3 stars = 12 ms, 3 stars x 4 alternatives = 43 ms, 22 brace
  // groups = 259 ms (see the table on MAX_GLOB_COST). The bound is coarse on
  // purpose — it is a hang guard, not a benchmark; the exact boundary is
  // pinned deterministically by the `globPatternWays` values above.
  const text = 'a'.repeat(200)
  for (const pattern of ['*a*a*b', '{a,aa}{a,aa}*a*a*b', '{a,aa}'.repeat(22)]) {
    assert.equal(globPatternCost(pattern), undefined, `${pattern} must be affordable`)
    const started = Date.now()
    globToRegExp(pattern).test(text)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000, `${pattern} took ${elapsed} ms on a 200-character name`)
  }
})

test('an escaped `]` never closes a class, so the tail behind it is priced', () => {
  // `translateClass` rejects a class whose `]` is escaped, so the `[` is a
  // literal and every star after it is compiled into the regex. The scan used
  // to read the final `]` as the closer, price this 13-character pattern at one
  // way, and the matcher then backtracked for 27.8 s on a 190-character name.
  assert.equal(ESCAPED_BRACKET.length, 13)
  assert.equal(globPatternCost(ESCAPED_BRACKET), 'cost')
  assert.equal(globPatternWays(ESCAPED_BRACKET), Number.POSITIVE_INFINITY)
  // `\\` is an escaped backslash, so the `]` after it does close the class and
  // the text before it stays a plain class: priced at one way, allowed.
  assert.equal(CLOSED_BRACKET.length, 14)
  assert.equal(globPatternCost(CLOSED_BRACKET), undefined)
  assert.equal(globPatternWays(CLOSED_BRACKET), 1)
  assert.doesNotThrow(() => globToRegExp(CLOSED_BRACKET))
  // A lone `[` is still one literal character for the price, and still reported
  // as an unterminated class rather than silently matching nothing.
  assert.equal(globPatternWays('['), 1)
  assert.equal(globPatternCost('['), undefined)
})

test('glob and grep refuse the escaped-`]` shape before they walk', async () => {
  await withWorkspace(async (workspace, ctx) => {
    await writeFile(workspace, `[${'a'.repeat(60)}`, 'needle\n')
    const counting = countingList(ctx)
    const started = Date.now()
    const globError = await rejection(globTool(counting, { pattern: ESCAPED_BRACKET }))
    assert.match(globError.message, /glob\.pattern is too expensive/)
    const grepError = await rejection(grepTool(counting, { pattern: 'needle', glob: ESCAPED_BRACKET }))
    assert.match(grepError.message, /grep\.glob is too expensive/)
    const elapsed = Date.now() - started
    // Deterministic: no helper walked, so neither answer can come from a walk.
    assert.equal(counting.listed, 0, 'both patterns must be priced before any listing')
    assert.ok(elapsed < 200, `expected two refusals in well under 200 ms, took ${elapsed} ms`)
    // The class check keeps its own message for a class that really is open.
    const unterminated = await rejection(globTool(counting, { pattern: '[' }))
    assert.match(unterminated.message, /unterminated character class at character 1/)
  })
})

test('an escaped-`]` .gitignore line is skipped, and the walk still finishes', async () => {
  await withWorkspace(async (workspace, ctx) => {
    // A name the skipped rule would have had to test: 190 characters starting
    // with `[` made the compiled rule backtrack for 6 s per walk.
    const bracketed = `[${'a'.repeat(189)}`
    await writeFile(workspace, bracketed, 'kept\n')
    await writeFile(workspace, 'keep.txt', 'kept\n')
    await writeFile(workspace, 'debug.log', 'noise\n')
    await writeFile(workspace, '.gitignore', `${ESCAPED_BRACKET}\n*.log\n`)

    // Deterministic: the line cannot be compiled, so it is counted, not applied.
    assert.equal(globPatternCost(ESCAPED_BRACKET), 'cost')

    const started = Date.now()
    const globOut = await globTool(ctx, { pattern: '**/*' })
    const grepOut = await grepTool(ctx, { pattern: 'kept' })
    const elapsed = Date.now() - started

    for (const answer of [globOut, grepOut]) {
      assert.match(answer, /… \(ignored 1 unsafe \.gitignore rule\)/)
    }
    // Skipped, not applied: the pathological name is still content, while the
    // ordinary rule from the same file still prunes.
    assert.match(globOut, new RegExp(`^\\[${'a'.repeat(189)}$`, 'm'))
    assert.match(globOut, /keep\.txt/)
    assert.doesNotMatch(globOut, /debug\.log/)
    assert.match(grepOut, /keep\.txt:1: kept/)
    // Coarse guard: the point is that the walk returns at all, not a benchmark.
    assert.ok(elapsed < 2000, `an escaped-] ignore rule took ${elapsed} ms to get past`)
  })
})
