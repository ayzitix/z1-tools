/**
 * `com.z1.tools` — a small, well-behaved tool stack for z1 workers.
 *
 * One worker-mode `tools` service. Every tool takes a JSON object and returns
 * text: numbered lines for reads, `path:line: text` for search hits, and short
 * confirmations for mutations. Failures throw an `Error` whose message says
 * what was wrong and which path it was about.
 *
 * The workspace is `ctx.workspace` (the project folder): relative paths
 * resolve there, absolute paths are used as given, and results display a
 * workspace-relative path whenever the target is inside the workspace.
 *
 * Mutations are written atomically where the platform allows it: `write`,
 * `edit`, `apply_patch` and `todo.write` prepare a sibling temp file and rename
 * it into place, so a failure leaves the old bytes. `write` additionally
 * refuses to replace a file this process has not read and that has not changed
 * since; a hardlinked target is renamed like any other file, which breaks its
 * other links (they keep the old bytes) and is reported as `broke N hard
 * link(s)` — there is no in-place option. A file whose text contains a NUL or
 * U+FFFD anywhere is binary: `read`/`edit`/`write`/`apply_patch` refuse it and
 * never re-encode it. `edit` also accepts Claude Code's
 * `old_string`/`new_string` aliases.
 *
 * v1 asks for no approvals. The manifest's capability grant is the only
 * boundary: `fs /**`, `process ["*"]`, and optional `net`. Do not point this
 * module at a workspace you are not willing to let a model rewrite.
 *
 * @module com.z1.tools
 */

import { readArgs } from './lib/args.js'
import { editTool, mkdirTool, moveTool, readTool, statTool, writeTool } from './lib/fs.js'
import { gitDiff, gitLog, gitStatus } from './lib/git.js'
import { systemInfo, todoRead, todoWrite } from './lib/meta.js'
import { applyPatch } from './lib/patch.js'
import { globTool, grepTool, listTool, treeTool } from './lib/search.js'
import {
  killTool as processKillTool,
  listTool as processListTool,
  outputTool as processOutputTool,
  startTool as processStartTool,
} from './lib/process.js'
import { shellTool } from './lib/shell.js'

const PATH_DESCRIPTION =
  'Path inside the workspace: relative paths resolve there, absolute paths must land inside it.'

/** Every tool this service exposes, in a stable order. */
const TOOL_SCHEMAS = [
  {
    name: 'read',
    description:
      'Read a UTF-8 text file as numbered lines (`1| text`); `offset` is 1-based and `limit` defaults to 2000. An answer stops near 100k characters (one line is clipped at 2000) and a cut window names the next `offset`; files over 1 MiB are refused, and so is a binary file — one whose whole text contains a NUL or U+FFFD, scanned end to end and never re-encoded; reading the z1 session store (`z1/` carrying `.z1-sessions`) is allowed, changing it is not.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        offset: { type: 'integer', minimum: 1, description: 'First line to return (1-based).' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Lines to return; defaults to 2000.' },
      },
    },
  },
  {
    name: 'write',
    description:
      'Write a UTF-8 text file: the content goes to a sibling temp file that is renamed into place, parent directories are created and an existing file keeps its mode. Refuses to overwrite a file this process has not read, or that changed since that read, and refuses a binary target (a NUL or U+FFFD anywhere in the file) instead of re-encoding it; a hardlinked target is renamed too, which breaks its other links (they keep the old bytes) and is reported as `broke N hard link(s)` — there is no in-place option; the z1 session store is refused.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        content: { type: 'string', description: 'Full file content.' },
      },
    },
  },
  {
    name: 'edit',
    description:
      'Replace exact text in a file: `oldText` must occur once unless `replaceAll` is true. Matching accepts LF or the file\'s own line endings and untouched lines keep their bytes, so a mixed-EOL file is unchanged elsewhere; whitespace-only `oldText` and an identical replacement are handled explicitly (`no change`), a binary file (a NUL or U+FFFD anywhere in it) is refused and never re-encoded, a hardlinked target is renamed, which breaks its other links (reported as `broke N hard link(s)`), and Claude-style `old_string`/`new_string` are accepted aliases; the z1 session store is refused.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      // `oldText`/`newText` and `old_string`/`new_string` are alternatives; the
      // tool validates which pair was passed, so neither pair is `required`.
      required: ['path'],
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        oldText: { type: 'string', description: 'Exact text to replace; non-empty and not whitespace-only.' },
        newText: { type: 'string', description: 'Replacement text; may be empty.' },
        old_string: { type: 'string', description: 'Alias of `oldText`; pass one pair only.' },
        new_string: { type: 'string', description: 'Alias of `newText`; pass one pair only.' },
        replaceAll: {
          type: 'boolean',
          description: 'Replace every occurrence (default false: the match must be unique).',
        },
      },
    },
  },
  {
    name: 'apply_patch',
    description:
      'Apply SEARCH/REPLACE blocks to existing files. Markers start at column 0, every block is matched against the original file (not text an earlier block inserted) and must match once; all blocks are applied in memory and every changed file is written to a temp file first, so a parse or match failure changes nothing. Each file is then swapped in by one atomic rename; if a later rename fails, files already swapped are restored on a best-effort basis by rewriting their old bytes (that restore can itself fail and does not keep hard links), so an interrupted commit may leave a mix of old and new files. A binary target (a NUL or U+FFFD anywhere in the file) is refused and never re-encoded, a hardlinked target is swapped, which breaks its other links (they keep the old bytes) and is reported as `broke N hard link(s)`, and a target in the z1 session store is refused.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['patch'],
      properties: {
        patch: {
          type: 'string',
          description:
            'A path line, then `<<<<<<< SEARCH`, the exact text, `=======`, the replacement, `>>>>>>> REPLACE`; a following block without a path continues the same file. `*** Begin Patch`/`*** End Patch` and code fences are optional. Because they are recognised by prefix and not by context, a quoted line that starts with `*** Begin Patch`, `*** End Patch`, `<<<<<<<` or `>>>>>>>` is read as an envelope marker, so text containing one cannot be patched in (use `write`). `*** Add/Delete/Move File` and `@@` hunks are not supported (create files with `write`).',
        },
      },
    },
  },
  {
    name: 'list',
    description:
      'List a directory as `dir p`, `file p (size)`, `link p` or `other p (fifo)`, `(socket)`, `(device)`, `(special)`; a file path returns that one row. Names are relative to `path`, ignored entries are labelled `(ignored)`, the walk is bounded to 8 levels and 5000 entries with the cap reported, and the marked z1 session store shows once as `(z1 state, ignored)` without descending. `.gitignore` files from the repository root down to `path` apply, so a listing of `src/` still honours a root `dist/` or `*.log`; `includeIgnored: true` shows ignored entries and noise directories anyway.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        recursive: { type: 'boolean', description: 'Walk subdirectories (default false: one level).' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 8, description: 'Levels to walk; implies recursion.' },
        includeIgnored: {
          type: 'boolean',
          description:
            'Show ignored entries and noise directories too (default false). `.gitignore` is not consulted at all, so `node_modules`, `.git` and `.z1/out` are listed and descended; the marked z1 session store is still pruned and the caps still apply.',
        },
      },
    },
  },
  {
    name: 'glob',
    description:
      'Find files by glob under a root, which defaults to the workspace. `*` and `?` stop at `/` while `**` crosses it, a pattern without `/` matches the basename at any depth, and `{a,b}`/`[...]` work; `.gitignore` (from the repository root down to the search root) and noise directories are skipped (as is the marked z1 session store, counted ignored), results are sorted and capped at 1000 paths or 64 KiB, ignored paths are counted in the summary, and absolute patterns are rejected. `includeIgnored: true` searches ignored paths and noise directories as well.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob relative to `path`, e.g. `src/**/*.ts` or `*.md`.',
        },
        path: { type: 'string', description: 'Root directory or file; defaults to the workspace.' },
        includeIgnored: {
          type: 'boolean',
          description:
            'Match ignored paths and noise directories too (default false). The marked z1 session store is still skipped; the 1000-path and 64 KiB caps still apply.',
        },
      },
    },
  },
  {
    name: 'grep',
    description:
      'Search file contents with a JavaScript regular expression, case-sensitive by default (`caseSensitive: false` opts in); results are `path:line: text` and context lines `path-line- text`. `.gitignore` (from the repository root down to the search root), noise directories and the marked z1 session store are skipped, as are binary and >1 MiB files (all counted in the summary); `includeIgnored: true` searches ignored paths and noise directories too; a pattern over 512 characters or one whose shape can backtrack catastrophically (nested quantifiers such as `(a+)+`, ambiguous alternation, a large backreference) is rejected up front, lines over 16 000 characters are matched on the clipped head only, and matching stops after a 5 s budget with `grep: stopped after N ms; narrow the query`. Result lines are clipped near 400 characters and a result is capped at 64 KiB.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression source (compiled with `u`).' },
        path: { type: 'string', description: 'Directory or single file; defaults to the workspace.' },
        glob: { type: 'string', description: 'Only search files matching this glob (basename if it has no `/`).' },
        caseSensitive: { type: 'boolean', description: 'Default true; pass false to ignore case.' },
        context: { type: 'integer', minimum: 0, maximum: 20, description: 'Lines before and after a hit.' },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Maximum matching lines; defaults to 200.',
        },
        includeIgnored: {
          type: 'boolean',
          description:
            'Search ignored paths and noise directories too (default false). The marked z1 session store and the binary/oversize rules still apply.',
        },
      },
    },
  },
  {
    name: 'tree',
    description:
      'Render a compact directory tree with file sizes and symlink labels; ignored entries appear as `(ignored)` (the marked z1 session store as `(z1 state, ignored)`) and depth, entry and byte caps are reported. `.gitignore` applies from the repository root down to `path`; `includeIgnored: true` shows ignored and noise entries instead. Depth defaults to 3.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        path: { type: 'string', description: 'Root directory; defaults to the workspace.' },
        depth: { type: 'integer', minimum: 1, maximum: 7, description: 'Levels to show; defaults to 3.' },
        includeIgnored: {
          type: 'boolean',
          description:
            'Show ignored paths and noise directories without an `(ignored)` marker (default false). The marked z1 session store is still pruned; the depth and size caps still apply.',
        },
      },
    },
  },
  {
    name: 'stat',
    description:
      'Report one entry (`lstat`) as `type size mtime [mode] [nlink=N] path`. A symlink adds `-> target` (and `(dangling)`), a FIFO, socket or device is `other`; `mode` is four digits, `nlink` appears only above 1 and mtime is local ISO 8601 with its UTC offset.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', description: PATH_DESCRIPTION } },
    },
  },
  {
    name: 'mkdir',
    description:
      'Create a directory, with parents unless `recursive: false`. An existing directory reports `exists`; an existing file and the z1 session store are refused.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        recursive: {
          type: 'boolean',
          description: 'Create missing parents (default true); false requires the parent to exist.',
        },
        mode: {
          type: 'integer',
          minimum: 0,
          maximum: 4095,
          description: 'Permission bits for a new directory, e.g. 493 for 0755; default is 0777 minus umask.',
        },
      },
    },
  },
  {
    name: 'move',
    description:
      'Move or rename one entry inside the workspace, creating the destination parent; a symlink moves as the link itself and an existing destination needs `overwrite: true`. Same-device moves rename; across devices the entry is copied and the source removed, so an interruption can leave both. Either end in the z1 session store is refused.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', description: PATH_DESCRIPTION },
        to: { type: 'string', description: PATH_DESCRIPTION },
        overwrite: {
          type: 'boolean',
          description: 'Replace an existing destination (default false: it is an error).',
        },
      },
    },
  },
  {
    name: 'shell',
    description:
      'Run one command as argv (never a shell string) and block until it exits, so use `process.start` for a server or watcher; it returns `exit <code>` or `killed <signal> (timeout after <ms> ms)`, then stdout and stderr in the order they were written. Exceeding `maxOutputBytes` does not kill the child: the excess is read and discarded, the real exit status is kept, and the output ends with `… output capped at N bytes`. Timeout defaults to 30 s (max 300 s).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Executable, resolved on PATH.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argument vector.' },
        cwd: {
          type: 'string',
          description: 'Working directory inside the workspace; defaults to the workspace.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 300000,
          description: 'Defaults to 30000; the child is killed (process group) at the deadline.',
        },
        stdin: {
          type: 'string',
          description: 'Text written to the child stdin once, then closed; stdin is closed when omitted.',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Extra variables merged over the inherited allowlist; they do not replace it.',
        },
        maxOutputBytes: {
          type: 'integer',
          minimum: 1,
          maximum: 5242880,
          description:
            'Combined stdout+stderr bytes kept; defaults to 1048576 (1 MiB). Past the cap the rest is read and discarded, the process runs to completion, and the output ends with `… output capped at N bytes`; the exit status is the real one.',
        },
      },
    },
  },
  {
    name: 'process.start',
    description:
      'Start a long-running command (a dev server, a watcher) and return its task id immediately. Read it with `process.output`, stop it with `process.kill`, see everything with `process.list`; use `shell` for anything that exits.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Executable, resolved on PATH.' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Argument vector; every entry must be a string.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory inside the workspace; defaults to the workspace.',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Extra variables merged over the inherited environment (these win); values must be strings.',
        },
      },
    },
  },
  {
    name: 'process.output',
    description:
      'Read a task\'s output after `cursor` (a character offset, default 0), including after it exited. The reply carries the status, a `more` flag, the next cursor and the head of the range; output beyond the retained tail is reported as dropped, and non-text output as a binary marker.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Task id returned by process.start.' },
        cursor: {
          type: 'integer',
          minimum: 0,
          description: 'Character offset from the previous call; omit for the start.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 65536,
          description: 'Characters to return, keeping the head; defaults to 65536.',
        },
      },
    },
  },
  {
    name: 'process.kill',
    description:
      'Stop a task: the signal (default SIGTERM) is sent and SIGKILL follows automatically after 2 s if it is still running. A reply of `stopping` means it had not exited yet, so check with `process.output`.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Task id returned by process.start.' },
        signal: {
          type: 'string',
          enum: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT'],
          description: 'Defaults to SIGTERM.',
        },
      },
    },
  },
  {
    name: 'process.list',
    description:
      'List tasks with status, exit code or signal, cwd, age and output size: running ones plus the last 5 finished by default. `all: true` shows every finished task; `limit` bounds how many finished tasks are shown whether or not `all` is set (the newest are kept), and an omitted task count is printed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        all: { type: 'boolean', description: 'Include every finished task (default false: the last 5).' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description:
            'Finished tasks to show, newest kept; defaults to 5, and applies with `all: true` too (this many of every finished task).',
        },
      },
    },
  },
  {
    name: 'git.status',
    description:
      'Read-only status: a `branch <name> | staged N unstaged N untracked N conflicts N` header, then `XY path` rows with workspace-relative paths and renames as `a -> b`. Untracked directories are expanded and the answer is capped by `maxBytes`.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        maxBytes: {
          type: 'integer',
          minimum: 1024,
          maximum: 1048576,
          description: 'Output cap; defaults to 65536.',
        },
      },
    },
  },
  {
    name: 'git.diff',
    description:
      'Read-only diff; `mode` picks `stat` (default), `patch`, `numstat` or `name`. `staged` diffs the index and `ref` diffs against a commit (mutually exclusive); untracked files are listed in their own section since they never appear in a diff.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        path: { type: 'string', description: 'Limit the diff to this path.' },
        mode: {
          type: 'string',
          enum: ['stat', 'patch', 'numstat', 'name'],
          description: 'Defaults to `stat`.',
        },
        staged: { type: 'boolean', description: 'Diff the index (`--staged`).' },
        ref: {
          type: 'string',
          description: 'Commit, branch or tag to diff against; must not start with "-".',
        },
        untracked: {
          type: 'boolean',
          description: 'List untracked files below the diff (default true).',
        },
        maxBytes: {
          type: 'integer',
          minimum: 256,
          maximum: 1048576,
          description: 'Output cap; defaults to 65536.',
        },
      },
    },
  },
  {
    name: 'git.log',
    description:
      'Read-only history, newest first: `hash  ISO date  author  subject` with offset-bearing dates. Filters are `ref`, `author`, `since` and `path`; merges are hidden unless `merges: true`, and an empty repository says so instead of failing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        path: { type: 'string', description: 'Limit history to this path.' },
        maxCount: { type: 'integer', minimum: 1, maximum: 200, description: 'Commits to return; defaults to 20.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Alias of `maxCount`.' },
        ref: { type: 'string', description: 'Commit, branch or tag to start from; must not start with "-".' },
        author: { type: 'string', description: 'Only commits whose author matches.' },
        since: { type: 'string', description: 'Only commits newer than this date (git date syntax).' },
        merges: { type: 'boolean', description: 'Include merge commits (default false).' },
        maxBytes: {
          type: 'integer',
          minimum: 256,
          maximum: 1048576,
          description: 'Output cap; defaults to 65536.',
        },
      },
    },
  },
  {
    name: 'system.info',
    description:
      'Report six lines: os, node, shell base name and dialect (`zsh (POSIX)`), now with its time zone, workspace (with `(missing)` when absent) and the git root/branch. The shell name comes from `$SHELL`/`ComSpec`, but no path, user, host or other environment value is reported.',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'todo.write',
    description:
      'Replace the workspace todo list at `.z1/todos.json` atomically (mode 0600) and report the new count. Statuses: pending, in_progress, done; capped at 500 items and 2000 characters per item.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          maxItems: 500,
          description: 'The whole list, in order.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: {
              text: { type: 'string', maxLength: 2000, description: 'What to do.' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'done'],
                description: 'Defaults to pending.',
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'todo.read',
    description:
      'Read the todo list as one line per item (`[ ] 1. text`), with a count header and a note for every item that was skipped, clipped or had an unknown status. A missing or empty file reads as no todos; capped at 500 items or 64 KiB.',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
]

const HANDLERS = {
  read: readTool,
  write: writeTool,
  edit: editTool,
  apply_patch: applyPatch,
  list: listTool,
  glob: globTool,
  grep: grepTool,
  tree: treeTool,
  stat: statTool,
  mkdir: mkdirTool,
  move: moveTool,
  shell: shellTool,
  'process.start': processStartTool,
  'process.output': processOutputTool,
  'process.kill': processKillTool,
  'process.list': processListTool,
  'git.status': gitStatus,
  'git.diff': gitDiff,
  'git.log': gitLog,
  'system.info': (ctx) => systemInfo(ctx),
  'todo.write': todoWrite,
  'todo.read': (ctx) => todoRead(ctx),
}

export const services = {
  tools: (ctx) => ({
    /** Every tool this service exposes, with its JSON Schema. */
    list() {
      return TOOL_SCHEMAS
    },

    /** Run one tool by name. Unknown names and bad arguments throw. */
    async call(name, args) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('tool name must be a non-empty string')
      }
      const handler = HANDLERS[name]
      if (handler === undefined) throw new Error(`unknown tool "${name}"`)
      return await handler(ctx, readArgs(args, name))
    },
  }),
}
