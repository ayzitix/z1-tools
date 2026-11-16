/**
 * Small argument validators shared by every tool.
 *
 * Tools receive raw JSON from a model, so every field is checked here and a
 * bad value throws an `Error` whose message names the tool and the field.
 *
 * @module z1-tools/args
 */

export function fail(message) {
  throw new Error(message)
}

/** A thrown value's message, without assuming it is an `Error`. */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Drop a broker's own `cannot read "<path>": ` before a tool adds its own
 * prefix, so a failure reads `cannot read "a.txt": ENOENT` and not
 * `cannot read "a.txt": cannot read "/ws/a.txt": ENOENT`.
 */
export function causeDetail(error) {
  const detail = errorMessage(error)
  const match = /^cannot read "[^"]*":\s*/.exec(detail)
  return match === null ? detail : detail.slice(match[0].length)
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `null` and `undefined` mean "no arguments"; anything else must be an object. */
export function readArgs(raw, tool) {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) fail(`${tool} expects an object of arguments`)
  return raw
}

export function stringArg(raw, key, tool) {
  const value = raw[key]
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${tool}.${key} must be a non-empty string`)
  }
  return value
}

export function optionalString(raw, key, tool) {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${tool}.${key} must be a non-empty string`)
  }
  return value
}

export function optionalBoolean(raw, key, tool) {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') fail(`${tool}.${key} must be a boolean`)
  return value
}

export function optionalInteger(raw, key, tool, minimum, maximum) {
  const value = raw[key]
  if (value === undefined) return undefined
  if (!Number.isInteger(value)) fail(`${tool}.${key} must be an integer`)
  if (value < minimum) fail(`${tool}.${key} must be at least ${minimum}`)
  if (maximum !== undefined && value > maximum) {
    fail(`${tool}.${key} must be at most ${maximum}`)
  }
  return value
}

export function positiveInteger(raw, key, tool, maximum) {
  return optionalInteger(raw, key, tool, 1, maximum)
}
