/**
 * `patternCost` is the cheap half of grep's ReDoS defence: it must reject the
 * shapes that actually blow up, and above all it must not reject ordinary
 * regexes (a false positive costs the model a working query).
 *
 * The "bad" table is measured shapes: each one backtracks exponentially or
 * quadratically on a short line. The "good" table is the kind of pattern a
 * model writes for source search; none of them repeats an ambiguous body.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { patternCost } from '../lib/search.js'

const BAD = [
  '(a|a)+$',
  '(a|a?)+$',
  '((a)*)+$',
  '(a?)+$',
  '(a?){25}a{25}',
  '(\\w|\\w\\w)+$',
  '(?:a|a)*$',
  '(?:\\w|\\w\\w)+$',
  '(a{1,9}){1,9}$',
  '(a|ab)+$',
  '(.|a)+$',
  '(\\w+\\s+)*',
  '(\\d|\\d\\d)+$',
  '(\\w|a)+$',
  '(a|\\w)+$',
  '(?:a|ab)+$',
  '([^x]|a)+$',
  '(\\p{L}|a)+$',
  '(\\s|\\s\\s)+$',
  // Unbounded outer with any inner repeat still rejects, however small the
  // inner bound looks.
  '(a{1,9})+$',
  '(\\d{1,3})+',
  '(a{2,}){3}',
]

const GOOD = [
  '^foo\\.bar$',
  '\\bclass\\s+\\w+',
  'a{3,5}',
  '(?:foo|bar)+',
  '(foo|bar)+',
  '(?:a|b)*',
  'a?b?c?',
  '[abc]+',
  '[^abc]+',
  '(?=foo)bar',
  '^\\s*#\\s*',
  'function\\s+\\w+\\([^)]*\\)',
  '(?:[a-z]|[0-9])+',
  'a+b*c?',
  '(?:ab|cd)+',
  '\\d{4}-\\d{2}-\\d{2}',
  '(?:foo){3}',
  '\\bconst\\s+\\w+\\s*=',
  '(?<name>\\w+)',
  // The reported false-positive corpus: ordinary bounded repeats that a model
  // writes for source search, each matching in microseconds via matchLines.
  '(\\d{1,3}\\.){3}\\d{1,3}',
  '(?:[a-f0-9]{2}:){5}[a-f0-9]{2}',
  '(\\d{3}-){2}\\d{4}',
  // Bounded nested repeats whose division count (inner ** outer) stays small.
  '(\\d{1,2}:){2}\\d{2}',
  '(?:[a-z]{2}-){4}',
  '(\\w{2}\\.){3}',
]

test('patternCost rejects known exponential and quadratic shapes', () => {
  for (const pattern of BAD) {
    assert.notEqual(patternCost(pattern), undefined, `expected ${pattern} to be rejected`)
  }
})

test('patternCost allows ordinary source-search patterns', () => {
  for (const pattern of GOOD) {
    assert.equal(patternCost(pattern), undefined, `expected ${pattern} to be allowed`)
  }
})

test('patternCost rejects a pattern over the length cap', () => {
  assert.equal(patternCost('a'.repeat(513)), 'length')
})
