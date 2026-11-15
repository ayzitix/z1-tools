# z1 tools module

A worker-mode `tools` service for `z1`: a small, well-behaved tool stack an
agent graph can drive — read, write, patch, search, shell, background tasks,
read-only git and a workspace todo list. It is a self-contained module, not host code:
the entry is plain ESM with `node:` builtins only, and the manifest's grant
decides how far it can reach.

> **v1 has no approvals.** No tool calls `ctx.approval`. `write`, `edit`,
> `apply_patch`, `move`, `mkdir` and `shell` run as soon as the model asks, so
> only point this module at a workspace you are willing to let a model rewrite.
> The capability grant is the only boundary.

## Repository and install

Current version: **0.1.6** (`manifest.json`, id `com.z1.tools`).

```sh
git clone https://github.com/ayzitix/z1-tools ~/Projects/z1-tools
```

The module is plain ESM with `node:` builtins only — there is nothing to build
and no runtime dependency to install. Point `z1` at the clone:

```sh
z1 module propose ~/Projects/z1-tools --modules-dir /tmp/z1-modules
z1 module approve com.z1.tools --modules-dir /tmp/z1-modules
z1 module list --modules-dir /tmp/z1-modules
z1 run graph.json --modules-dir /tmp/z1-modules --approve ask
```

Proposing copies the directory into the module store, so the installed copy
(under `~/.local/share/z1/modules` by default) is separate from the clone:
editing the clone does not change a module that was already proposed — propose
it again to pick up the changes. The `--modules-dir /tmp/z1-modules` above is
just an example; pass your own store if you use one.

> **The approved grant is broad.** As shipped the manifest asks for
> `fs.read`/`fs.write` on `/**` and `process.spawn` on `*`: every absolute path
> and every executable. Narrow it in `manifest.json` if you only need a corner
> of the disk (see [Approve](#2-approve)).

Every tool takes a JSON object and returns **text**. There is no binary
transfer: no blob upload, no base64 payloads, no file attachments. Binary and
non-UTF-8 files are refused or skipped rather than smuggled through a text
channel, and a command whose output is not text is reported as
`(binary output, N bytes)`.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `read` | `{ path, offset?, limit? }` | numbered lines `1\| text`; a cut window ends with `… (truncated: lines a-b of n; call read with offset=n+1)` |
| `write` | `{ path, content, preserveLinks? }` | `wrote <path> (<n> bytes[, broke N hard links][, kept mode 0644][, in place: kept N hard links])` |
| `edit` | `{ path, oldText, newText, replaceAll?, preserveLinks? }` | `edited <path> (<n> replacements[, broke N hard links][, kept mode 0644][, in place: kept N hard links])` or `no change: <path> (…)` |
| `apply_patch` | `{ patch, preserveLinks? }` | `patched <n> blocks in <m> files`, then `<path> (+a -r block lines[, broke N hard links][, in place: kept N hard links])` or `<path> (no change)` |
| `list` | `{ path, recursive?, maxDepth? }` | `dir p`, `file p (size)`, `link p`, each optionally `(ignored)` |
| `glob` | `{ pattern, path? }` | sorted matching paths, one per line |
| `grep` | `{ pattern, path?, glob?, caseSensitive?, context?, maxResults? }` | `path:line: text`, context as `path-line- text`, then a summary |
| `tree` | `{ path?, depth? }` | `├──`/`└──` tree with sizes and symlink labels |
| `stat` | `{ path }` | `type size mtime [mode] [nlink=N] path [-> target]` |
| `mkdir` | `{ path, mode?, recursive? }` | `created <path>[ with mode 0755]` or `exists <path> (directory)` |
| `move` | `{ from, to, overwrite? }` | `moved <from> -> <to>[ (copied across devices)][, replaced the previous entry]` |
| `shell` | `{ command, args?, cwd?, timeoutMs?, stdin?, env?, maxOutputBytes? }` | `exit <code>` / `killed <signal> (…)`, then stdout/stderr |
| `process.start` | `{ command, args?, cwd?, env? }` | `started <id> — running (pid N)` and the next call to make |
| `process.output` | `{ id, cursor?, limit? }` | status, cursor range, `---`, output text |
| `process.kill` | `{ id, signal? }` | `killed (SIGTERM)` or `stopping (SIGTERM sent, pid N)` |
| `process.list` | `{ all?, limit? }` | one row per task: status, age, output size, cwd, argv |
| `git.status` | `{ maxBytes? }` | `branch … \| staged N unstaged N untracked N conflicts N`, then `XY path` |
| `git.diff` | `{ path?, mode?, staged?, ref?, untracked?, maxBytes? }` | stat (the default), patch, numstat or name-status, plus an untracked section |
| `git.log` | `{ path?, maxCount?, ref?, author?, since?, merges?, maxBytes? }` | `hash  ISO date  author  subject`, newest first (`limit` is an alias of `maxCount`) |
| `system.info` | `{}` | six lines: os, node, shell, now, workspace, git |
| `todo.write` | `{ items: [{ text, status? }] }` | `wrote .z1/todos.json (<n> items, <previous state>)` |
| `todo.read` | `{}` | a count header and `[ ] 1. text` lines |

Every failure throws an `Error` that names the path or argument at fault. Tools
that discover positions use `path:line` (`grep`), so a line from one result can
be fed to `read`'s `offset`.

`edit` also accepts Claude Code's `old_string`/`new_string` in place of
`oldText`/`newText`, so a prompt written for another harness works unchanged.
The schema does not mark either pair `required` (they are alternatives); the
tool rejects a call with neither pair, and one that passes both pairs with
different values.

### Paths

`ctx.workspace` is the project folder and the only place these tools may touch.
Relative paths resolve there; an absolute path is accepted only when its real
path — symlinks followed — is the workspace or below it. A target that does not
exist yet is judged by the real path of its nearest existing parent, so `..`
escapes, absolute paths outside and symlinks pointing outside all fail with
`path escapes workspace: <path>`. The check applies to `read`, `write`, `edit`,
`apply_patch`, `list`, `glob`, `grep`, `tree`, `stat`, `mkdir`, `move` (both
ends), `shell.cwd`, `process.start.cwd` and the git pathspec; only
`system.info` reports the workspace path itself.

Results display a workspace-relative path when the target is inside the
workspace (`notes/a.txt`, `.` for the root) and an absolute path otherwise.
`write` creates parent directories.

`stat`, `mkdir` and `move` use a lexical resolution instead: the parent is
resolved and contained, the last component is kept as written, so they act on
the entry the model named (a link is a link) rather than on its target.

### z1's own state

A project's transcripts live in `<workspace>/z1`, and the marker file
`.z1-sessions` in it says the folder is z1's, not the project's (the session
package's default is `<repo>/z1`; see `@z1/session/paths`). These tools treat
that folder as z1's own state: `list` and `tree` show it once as
`z1 (z1 state, ignored)` and never descend, `glob` and `grep` skip it and count
it as one ignored path, and a base rooted inside it answers
`(z1 state: not project content; transcripts use /sessions)`.

Reading it is allowed: `read` returns its files (so a session's own `meta.json`
or transcript can be inspected) and `stat` still reports its metadata, so size
and mtime remain visible. `write`, `edit`, `apply_patch`, `mkdir` and either end
of `move` refuse it with `… is z1's own session store; transcripts are managed
with /sessions, not file tools`. `shell` is **not** filtered: it can still
modify the store (and anything else the grant reaches), so there the prompt, not
the guard, is the only protection.

The verdict is re-read on every call: `<workspace>/z1/.z1-sessions` is
re-`stat`ed by each guard and never memoised, so a store created or removed
mid-process is refused or released immediately. The extra `stat` costs about
60 µs per check. Only a `z1/` carrying the marker is affected: a repository
that genuinely has a `z1/` source directory (the SDK itself) keeps it fully
visible and writable. Detection only covers the default `<workspace>/z1`. A
store moved elsewhere by `Z1_SESSIONS_DIR` (or by the session package's
fallback root outside the workspace), a renamed store, and one reached through
the real path behind a symlinked `z1/` are not recognised and stay reachable by
file tools, so the manifest grant is the only bound there.

### Line endings and encoding

Files are read and written as UTF-8. `read` does not rewrite anything;
`write` replaces the whole file. `edit` and `apply_patch` match LF or the file's
own CRLF style, normalise only the replacement to the style in force at the
match, and leave every other line byte-for-byte identical — so a mixed-ending
file keeps both.

A NUL byte, or U+FFFD (what invalid UTF-8 becomes once the broker decoded it)
in the first 8 KiB, marks a file as binary. `read` refuses it, `edit` and
`apply_patch` refuse to re-encode it, `grep` skips it, and `write` will not
verify-and-replace it. A file that genuinely contains U+FFFD is treated the same
way: rewrite it with `write` instead of editing it.

### Write safety

`write`, `edit`, `apply_patch` and `todo.write` never truncate the target: the
content goes to a sibling temp file (`<name>.z1-tmp-<pid>-<rand>`) and is
renamed into place, so a failure leaves the old bytes. An existing file keeps
its mode; `todo.write` forces `0600` and creates `.z1` as `0700`. The one
exception is the opt-in `preserveLinks: true` on a hardlinked target, which
rewrites the inode in place (that is what was asked for) and is therefore not
atomic.

`write` additionally refuses to overwrite a file this process never read, or one
whose bytes changed since that read (`write: read "<path>" before overwriting
it`, `write: "<path>" changed since read`). `read` records a sha256 of what it
returned; `write` and `edit` refresh it. The map is per process and keyed by
workspace and resolved path, so a restart simply asks for a fresh read. This
catches the stale-context mistake, not a concurrent writer: the hash and the
rename are separate syscalls (see the TOCTOU note below).

A target with more than one hardlink takes that same rename path by default:
the target gets a new inode and the other names keep the old bytes, so the write
stays atomic but the link is gone — the result says `broke N hard links`. That
default is deliberate: a link made outside the workspace would otherwise be a
way to rewrite a file the guard protects through a writable name.
`preserveLinks: true` opts back into the in-place rewrite, which updates every
name on the inode, gives up rename atomicity for that one file, and says
`in place: kept N hard links`. The policy is shared by `write`, `edit` and
`apply_patch`; `apply_patch` reports the count per file, after its
`+a -r block lines`.

`apply_patch` prepares every changed file first and renames them all in one
helper child; a failure restores the previous bytes, mode and mtime of every
file already swapped.

### Todo list

`todo.write` replaces `.z1/todos.json` with `{ "items": [{ "text", "status" }] }`.
Statuses are `pending`, `in_progress` and `done`; `pending` is the default. Caps
are 500 items and 2000 characters of text per item, and the write is atomic with
mode `0600`.

`todo.read` returns one line per item (`[ ] 1. text`, `[~]` for in_progress,
`[x]` for done) under a `todos <n> items: …` header, rather than pretty JSON,
because the JSON cost about twice the tokens for the same list. A missing, empty
or whitespace-only file reads as `no todos`; a bad item is reported by index and
normalised (`status` unknown -> pending, empty text skipped, long text clipped).
Unknown top-level and item keys are not preserved by a read/write round trip, so
the on-disk shape stays exactly `{ items: [{ text, status }] }`.

`todo.write` refuses if this process read the list and the file then changed
(`todo.write: ".z1/todos.json" changed since todo.read`), without adding a
schema field.

## Background tasks

`process.start` runs a dev server or watcher without blocking, `process.output`
reads what it printed, `process.kill` stops it and `process.list` shows what is
running. The host owns the child, so a task survives a run but not the runtime:
closing z1 kills it.

- `cursor` is a **character** offset in the retained output, not a byte offset,
  and `limit` is characters (1–65536, default 65536); the call returns the head
  of the range, so a large backlog arrives in several pieces with `more: true`.
- Output is readable after the process exits, which is the only way to see why a
  task died; the reply always carries the exit code or signal.
- Output beyond the retained tail is reported as dropped, never silently
  skipped, and a non-text stream appears as `(binary output, N bytes)`.
- `process.kill` accepts `SIGTERM` (default), `SIGKILL`, `SIGINT`, `SIGHUP` and
  `SIGQUIT`; SIGKILL follows automatically after 2 s if the child ignores the
  signal. A reply of `stopping` means the exit has not been observed yet — read
  it again with `process.output`.
- `process.list` shows running tasks plus the last 5 finished ones; `all: true`
  includes every finished task and `limit` (1–200) bounds them.
- `process.start` merges `env` over the inherited allowlist and rejects a
  non-string argument or variable instead of dropping it silently. A command
  that fails instantly (port taken, missing binary) is reported as exited,
  together with its output, instead of as "running".

## Search and ignore rules

`glob` and `grep` share one dialect: `*` and `?` do not cross `/`, `**` does,
`{a,b}` alternates and `[...]` is a character class. A pattern **without a `/`**
is matched against the basename at any depth (`*.md` finds `docs/a/b.md`); a
pattern containing `/` is matched against the path relative to the root.
Absolute patterns are rejected — pass a relative `pattern` plus a `path` root.

`.gitignore` is honoured from the search root and from every directory visited
(directory patterns, `!` negation and `**` included), and `.git`, `node_modules`
and `.z1/out` are always pruned, as is a marked `z1/` session store. `glob` and
`grep` skip those silently and say
how many paths they skipped; `list` and `tree` show the entry once as
`(ignored)` and never descend. Caps are counted in files, not directories.

`grep` compiles the pattern with the `u` flag, is **case-sensitive by default**
(like ripgrep; `caseSensitive: false` opts in), returns `(no matches; …)` rather
than an empty string, ends every result with `(N matches in M files; …)`, and
reports skipped binary, oversized and unreadable files in that summary. A
result line (path included) is clipped near 400 characters and the whole answer
is capped at 64 KiB.

## Limits

- `read`: 1 MiB per file, 2000 lines per call, 1-based `offset`. The size and a
  NUL in the first 8 KiB are checked with `ctx.fs.stat`/a head sniff before the
  file is loaded, so a 4 GiB file is never read; both fail with a clear error
  (`file is <n> bytes; use shell sed -n`, `binary file: <path>`).
- `read` output: about 100 000 characters per answer and 2000 characters per
  line. A clipped line says `… +N chars` and a cut window names the next
  `offset`, so the answer has a bounded size whatever the file looks like.
- `list`, `glob`, `grep`: depth 8, 5000 files. `glob` returns at most 1000
  paths and 64 KiB; `grep` at most 200 matches, `context` 0–20, 1 MiB per file.
  Truncation, depth limits and ignored paths are printed, never implied.
- `tree`: depth 7 (default 3), 3000 entries, 64 KiB.
- `stat`: one line; `mode` is the four-digit `lstat` mode with setuid/sticky
  bits (`0755`, `4755`), `nlink=N` appears only above 1, and `mtime` is local
  ISO 8601 with its UTC offset (`2026-11-15T16:09:54.553+02:00`).
- `mkdir`: `mode` is an integer 0–4095, `recursive` defaults to true. An
  existing directory is success (`exists … (directory)`); an existing file,
  FIFO or device is refused; with `recursive: false` the parent must exist.
- `move`: an existing destination needs `overwrite: true` — a replacement is
  never implied. A directory is never merged into an existing one.
- `shell`: 30 s by default, 300 s maximum; argv only, never a shell string.
  `maxOutputBytes` is 1–5 242 880 and defaults to 1 MiB. `stdin` is written once
  and then closed (stdin is closed when omitted, so a prompt sees EOF instead of
  hanging), and `env` merges over the inherited allowlist rather than replacing
  it. Output keeps the order the process wrote it in, with `--- stdout ---` /
  `--- stderr ---` headings when both streams appear. Exceeding
  `maxOutputBytes` does not kill the child: the host keeps the first N bytes,
  reads and discards the rest while the process keeps running, and the answer
  ends with `… output capped at N bytes`; the reported status is the real one.
  Only the tool's own deadline kills, and that says
  `killed <signal> (timeout after <ms> ms)`. A host result may still carry
  `outputLimit: true` to mean "the cap was hit" — it does not mean the child
  was signalled.
- `git.status`: `maxBytes` 1024–1 048 576, default 64 KiB.
- `git.diff`: `mode` is `stat` (default), `patch`, `numstat` or `name`;
  `maxBytes` 256–1 048 576, default 64 KiB. `staged` and `ref` are mutually
  exclusive, because `--staged <ref>` means something else. Untracked files
  never appear in a diff, so they are listed in their own section unless
  `untracked: false`.
- `git.log`: `maxCount` 1–200 (default 20; `limit` is an accepted alias),
  `maxBytes` 256–1 048 576. `ref`, `author` and `since` are filters, merges are
  hidden unless `merges: true`, a `ref` starting with `-` is rejected and the
  ref is passed after `--end-of-options`. An empty repository answers
  `(no commits yet)` instead of failing.
- `git.*` paths are always workspace-relative, so they can be pasted straight
  into `read`/`edit`. Pathspecs go after `--`, so no argument can become an
  option (`--output=…` cannot redirect a diff into a file).

## Symlinks

The broker reports a symlink as its own entry (`type: "symlink"`). Walks never
follow one: `list` shows `link <path>`, `tree` shows `name -> target` or
`name (symlink)`, and only real directories are entered, so `glob`, `grep` and
`tree` cannot be steered out of the workspace by a link. `stat` uses `lstat`, so
it reports the link itself plus `-> target`, marked `(dangling)` when the target
is gone. `move` moves the link, not its target. A path that resolves through a
symlink to the outside is refused by the containment check before use.

## stat, move and the helpers

The broker exposes `fs.read`/`fs.write`/`fs.list`/`fs.stat`, and the worker runs
under Node's permission model, which denies `realpath`, `rename` and `readFile`
even on write-granted paths. `stat` therefore uses a small `lstat` helper (the
broker's `stat` knows no mode, link count or special file), while path
containment (`realpath`), `move` (`rename`, with an `EXDEV` copy-then-delete
fallback) and the atomic temp-file renames run minimal `node -e` helpers through
`ctx.process.run`: argv array, no shell string, no dependency. `mkdir`, `write`
and `unlink` use `node:fs`/the broker, which the write grant allows. Reads and
writes still go through the broker, so grants and denials stay auditable.

Known limitations, stated rather than hidden:

- **TOCTOU.** Containment, the read-before-overwrite hash and the rename are
  separate syscalls. A parent directory swapped for a symlink, or a writer
  racing between the hash check and the rename, can still surprise the tool; no
  Node API closes that window. The tools fail loudly rather than assuming the
  check was atomic.
- **Hardlinks.** By default a hardlinked target is renamed like any other file,
  so after a `write`, `edit` or `apply_patch` its other names still hold the old
  bytes and the result reports `broke N hard links`. `preserveLinks: true`
  rewrites the inode instead: every name sees the new bytes and that write is
  no longer atomic.
- **`move` across devices.** `rename` is atomic within one filesystem; an
  `EXDEV` move copies to a unique temp name and then deletes, so an interruption
  can leave both copies. A source that cannot be removed after a successful copy
  is reported, never hidden.
- **Windows.** `rename` onto an existing file is refused there, so the atomic
  writers fall back to remove-then-rename (`EEXIST`/`EPERM`): the file is still
  never truncated in place by the default path, but the swap is briefly
  non-atomic. An `overwrite` move fails cleanly instead of replacing.
- **Special files.** A FIFO, socket or device is reported as `other` with its
  kind in parentheses; nothing here reads or writes one.

## 1. Propose

```sh
z1 module propose ~/Projects/z1-tools --modules-dir /tmp/z1-modules
```

Proposing copies the directory into the store, hashes it, and prints the id, the
`tools` service and the requested capabilities. Nothing executes yet.

## 2. Approve

```sh
z1 module approve com.z1.tools --modules-dir /tmp/z1-modules
```

The printed grant is broad on purpose:

```json
{
  "fs": { "read": ["/**"], "write": ["/**"] },
  "process": { "spawn": ["*"] }
}
```

`/**` covers every absolute path and `spawn: ["*"]` every executable. Narrow the
manifest (for example `"fs": { "write": ["${moduleDir}/**"] }`) if the module
only needs a corner of the disk; the host re-checks every path and command and
records denials in `z1 module audit`.

## 3. Run

```sh
z1 module list --modules-dir /tmp/z1-modules
z1 run graph.json --modules-dir /tmp/z1-modules --approve ask
```

Any graph node that calls the run's tool service (for example `z1.agent.loop`)
now sees the table above.

## License

MIT — see [LICENSE](LICENSE). The module declares `"license": "MIT"` in
`manifest.json`; the copyright holder is `ayzitix` (2026).

No test suite is included in this repository, and the module is a tools service
only: it ships no host code and no dependencies.
