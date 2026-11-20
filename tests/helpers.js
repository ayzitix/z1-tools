/**
 * Test harness: a real temp workspace plus a fake worker context.
 *
 * The tools only see `ctx`, so the tests build the same three things the host
 * gives a worker — a workspace path, a brokered filesystem and a process
 * runner — over real `node:fs` in a `mkdtemp` directory. Nothing here talks to
 * the actual broker or permission model; the point is to drive `lib/*` as a
 * worker would, without a dependency or a build step.
 *
 * The broker shapes mimic the host's documented behaviour: `stat` follows
 * links (which is why `fs.js` has an lstat helper), `list` reports a symlink as
 * its own entry, and a failure is an `Error` starting with
 * `cannot <op> "<path>": <CODE>` so the tools' prefix-stripping is exercised.
 */

import { spawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Fresh directory under the system temp dir; caller removes it. */
export async function makeTemp(prefix = 'z1-tools-') {
  return await fsp.mkdtemp(join(tmpdir(), prefix))
}

/** Remove a directory tree, ignoring a missing path. */
export async function cleanup(directory) {
  await fsp.rm(directory, { recursive: true, force: true }).catch(() => {})
}

function typeOf(info) {
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'dir'
  if (info.isSymbolicLink()) return 'symlink'
  return 'other'
}

/** One `spawn`, with a deadline; mirrors the host's `ctx.process.run` result. */
export function runProcess(request) {
  const { command, args = [], cwd, env, timeoutMs, stdin, maxOutputBytes } = request
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env: env === undefined ? process.env : { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      fn(value)
    }
    const cap = (text, chunk) => {
      if (maxOutputBytes === undefined) return text + chunk
      const room = maxOutputBytes - Buffer.byteLength(text)
      if (room <= 0) return text
      return text + Buffer.from(chunk).subarray(0, room).toString('utf8')
    }
    child.stdout.on('data', (chunk) => {
      stdout = cap(stdout, chunk.toString('utf8'))
    })
    child.stderr.on('data', (chunk) => {
      stderr = cap(stderr, chunk.toString('utf8'))
    })
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code, signal) => finish(resolvePromise, { code, signal, stdout, stderr }))
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(reject, new Error(`process timed out after ${timeoutMs} ms`))
      }, timeoutMs)
    }
    if (typeof stdin === 'string') child.stdin.end(stdin)
    else child.stdin.end()
  })
}

/**
 * The fake worker context.
 *
 * `options.stat` can replace the broker's stat (used to model a broker whose
 * stat differs, or one that fails); `options.list` can be removed to exercise
 * the helper-less fallbacks. `options.run` wraps `ctx.process.run`, so a test
 * can inject a filesystem change at the moment a helper runs.
 */
export function makeCtx(workspace, options = {}) {
  const brokerStat = async (path) => {
    try {
      const info = await fsp.stat(path)
      return { type: typeOf(info), size: info.size, mtimeMs: info.mtimeMs }
    } catch (error) {
      throw new Error(`cannot stat "${path}": ${error.code ?? error.message}`)
    }
  }
  const brokerList = async (directory) => {
    let dirents
    try {
      dirents = await fsp.readdir(directory, { withFileTypes: true })
    } catch (error) {
      throw new Error(`cannot list "${directory}": ${error.code ?? error.message}`)
    }
    const entries = []
    for (const dirent of dirents) {
      const path = join(directory, dirent.name)
      let info
      try {
        info = await fsp.lstat(path)
      } catch (error) {
        throw new Error(`cannot list "${directory}": ${error.code ?? error.message}`)
      }
      const entry = { name: dirent.name, path, type: typeOf(info) }
      if (entry.type === 'file') entry.size = info.size
      if (entry.type === 'symlink') {
        entry.size = info.size
        try {
          entry.target = await fsp.readlink(path)
        } catch {
          // A link that vanished between readdir and readlink is just an entry.
        }
      }
      entries.push(entry)
    }
    return { entries }
  }

  const fs = {
    async read(path) {
      try {
        return await fsp.readFile(path, 'utf8')
      } catch (error) {
        throw new Error(`cannot read "${path}": ${error.code ?? error.message}`)
      }
    },
    async write(path, content) {
      try {
        await fsp.writeFile(path, content)
      } catch (error) {
        throw new Error(`cannot write "${path}": ${error.code ?? error.message}`)
      }
    },
    stat: options.stat ?? brokerStat,
  }
  if (options.list !== false) fs.list = options.list ?? brokerList

  const run = options.run ?? runProcess
  return {
    workspace,
    fs,
    process: {
      run(request) {
        return run(request)
      },
    },
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    ...(options.ctx ?? {}),
  }
}

/** Build a file with its parent directories. */
export async function writeFile(root, name, content) {
  const path = join(root, name)
  await fsp.mkdir(join(path, '..'), { recursive: true })
  await fsp.writeFile(path, content)
  return path
}

/** `ln -s target link`, with the link's parent created when needed. */
export async function symlink(target, link) {
  await fsp.mkdir(join(link, '..'), { recursive: true })
  await fsp.symlink(target, link)
  return link
}

/** Make `directory` a real session store: marker file, owned by z1. */
export async function markSessionStore(directory) {
  await fsp.mkdir(directory, { recursive: true })
  await fsp.writeFile(join(directory, '.z1-sessions'), '')
  return directory
}

/** Await a rejection and return the `Error` (fails if it resolved). */
export async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the call to reject')
}

/** True when `path` exists (lstat, so a dangling link counts). */
export async function exists(path) {
  try {
    await fsp.lstat(path)
    return true
  } catch {
    return false
  }
}
