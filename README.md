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

Current version: **0.1.9** (`manifest.json`, id `com.z1.tools`).

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
| `write` | `{ path, content }` | `wrote <path> (<n> bytes[, replaced a file the tools read as binary][, broke N hard links][, kept mode M])` |
| `edit` | `{ path, oldText, newText, replaceAll? }` | `edited <path> (<n> replacements[, broke N hard links][, kept mode M])` or `no change: <path> (…)` |
| `apply_patch` | `{ patch }` | `patched <n> blocks in <m> files[ (k blocks made no change)]`, then `<path> (+a -r block lines[, broke N hard links])` or `<path> (no change)` |
| `list` | `{ path, recursive?, maxDepth?, includeIgnored? }` | `dir p`, `file p (size)`, `link p`, `other p (fifo)`, each optionally `(ignored)`; a marked session store or a symlink alias of it is `(z1 state, ignored)` |
| `glob` | `{ pattern, path?, includeIgnored? }` | sorted matching paths, one per line, then `… (N files walked[; M ignored paths skipped])` |
| `grep` | `{ pattern, path?, glob?, caseSensitive?, context?, maxResults?, includeIgnored? }` | `path:line: text`, context as `path-line- text`, then a summary with the same walk counters |
| `tree` | `{ path?, depth?, includeIgnored? }` | `├──`/`└──` tree with sizes and symlink labels |
| `stat` | `{ path }` | `type size mtime [mode] [nlink=N] path [-> target] [(dangling\|loop\|unresolvable: CODE)]` |
| `mkdir` | `{ path, mode?, recursive? }` | `created <path>[ with mode 0755]` (the real mode after umask) or `exists <path> (directory)` |
| `move` | `{ from, to, overwrite? }` | `moved <from> -> <to>[ (copied across devices)][, replaced the previous entry]` |
| `shell` | `{ command, args?, cwd?, timeoutMs?, stdin?, env?, maxOutputBytes? }` | `exit <code>` / `killed <signal> (…)`, then stdout/stderr |
| `process.start` | `{ command, args?, cwd?, env? }` | `started <id> — running (pid N)` and the next call to make |
| `process.output` | `{ id, cursor?, limit? }` | status, cursor range, `---`, output text |
| `process.kill` | `{ id, signal? }` | `killed (SIGTERM)` or `stopping (SIGTERM sent, pid N)` |
| `process.list` | `{ all?, limit? }` | one row per task: status, age, output size, cwd, argv; `limit` bounds finished rows with or without `all` |
| `git.status` | `{ maxBytes? }` | `branch … \| staged N unstaged N untracked N conflicts N`, then `XY path` |
| `git.diff` | `{ path?, mode?, staged?, ref?, untracked?, maxBytes? }` | stat (the default), patch, numstat or name-status, plus an untracked section |
| `git.log` | `{ path?, maxCount?, ref?, author?, since?, merges?, maxBytes? }` | `hash  ISO date  author  subject`, newest first (`limit` is an alias of `maxCount`) |
| `system.info` | `{}` | six lines: os, node, shell (base name and dialect, e.g. `zsh (POSIX)`), now, workspace, git |
| `todo.write` | `{ items: [{ text, status? }] }` | `wrote .z1/todos.json (<n> items, <previous state>)` |
| `todo.read` | `{}` | a count header and `[ ] 1. text` lines |

Every failure throws an `Error` that names the path or argument at fault. Tools
that discover positions use `path:line` (`grep`), so a line from one result can
be fed to `read`'s `offset`.

`edit` also accepts Claude Code's `old_string`/`new_string` instead of
`oldText`/`newText`, so a prompt written for another harness works unchanged.
The schema does not mark either pair `required` (they are alternatives); the
tool rejects a call with neither pair, and one that passes both pairs with
different values.

### Paths

`ctx.workspace` is the project folder and the only place these tools may touch.
Relative paths resolve there; an absolute path is accepted only when its real
path — symlinks followed — is the workspace or below it. The workspace itself
is resolved to its real path once, at first use; if that cannot be resolved the
tool fails instead of comparing against the lexical string (a workspace that is
itself a symlink would otherwise reject every valid path or trust an invalid
one). A target that does not exist yet is judged by the real path of its nearest
existing parent, so `..` escapes, absolute paths outside and symlinks pointing
outside all fail with `path escapes workspace: <path>`. A **dangling** symlink
is resolved component by component, so a target such as `hop/../target` is
judged the way the kernel would resolve it (enter `hop`, then `..`) rather than
by a lexical `path.resolve` that cancels `hop` away; a dangling link is inside
only when the path its target would have is inside. Every walk asserts its base
is below the real root, so a caller cannot bypass the check with a raw path.
The check applies to `read`, `write`, `edit`, `apply_patch`, `list`, `glob`,
`grep`, `tree`, `stat`, `mkdir`, `move` (both ends), `shell.cwd`,
`process.start.cwd` and the git pathspec; only `system.info` reports the
workspace path itself.

Results display a workspace-relative path when the target is inside the
workspace (`notes/a.txt`, `.` for the root) and an absolute path otherwise.
`write` creates parent directories.

`stat`, `mkdir` and `move` use a lexical resolution instead: the parent is
resolved and contained, the last component is kept as written, so they act on
the entry the model named (a link is a link) rather than on its target. `stat`
therefore reports a symlink as itself. `mkdir` still follows the final link to
decide: a link to an inside directory is `exists`, a link to an inside file is
refused as not a directory, a dangling link is refused with a message that does
not suggest `recursive: true` (which cannot fix it), and a link whose target is
outside is `path escapes workspace`. `move` re-resolves the destination parent
immediately before renaming and the helper verifies the parent's `dev:ino`, so a
parent swapped for a symlink after the first check is refused instead of
redirecting the entry.

### z1's own state

A project's transcripts live in `<workspace>/z1`, and the marker file
`.z1-sessions` in it says the folder is z1's, not the project's (the session
package's default is `<repo>/z1`; see `@z1/session/paths`). These tools treat
that folder as z1's own state: `list` and `tree` show each name of it once as
`(z1 state, ignored)` and never descend, `glob` and `grep` skip it and count each
name as one ignored path, and a base rooted inside it answers
`(z1 state: not project content; transcripts use /sessions)`.

A symlink alias of the store is the store. The walk resolves a link entry's
target (once, from the target the broker already supplied) and marks it too, so
both a `z1 -> realz1` link and an `alias -> z1` link are hidden by `list`,
`tree`, `glob` and `grep`; the row keeps its real kind (`link alias`, not
`dir alias`). The real folder and each alias are separate names, so a walk shows
one row per name, all marked ignored.

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
visible and writable. Detection covers the default `<workspace>/z1`, and
`sessionRoot` resolves it, so a `z1 -> realz1` symlink is covered too: writes
through the symlink or through its real target are both refused (reads remain
allowed). A store moved elsewhere by `Z1_SESSIONS_DIR` (or by the session
package's fallback root outside the workspace) and a store with another name
are not recognised and stay reachable by file tools, so the manifest grant is
the only bound there.

### Line endings and encoding

Files are read and written as UTF-8. `read` does not rewrite anything;
`write` replaces the whole file. `edit` and `apply_patch` match LF or the file's
own CRLF style, normalise only the replacement to the style in force at the
match, and leave every other line byte-for-byte identical — so a mixed-ending
file keeps both.

A NUL byte anywhere in the text, or U+FFFD (what invalid UTF-8 becomes once the
broker decoded it), marks a file as binary. The scan covers the whole file —
still at most 1 MiB — and not a head: one bad byte at 12 KiB stops a rewrite as
firmly as one at byte 10. `read` refuses it, `edit` and `apply_patch` refuse to
re-encode it, `grep` skips a file containing a NUL, and `write` will not
verify-and-replace it unless this process's `read` was refused on exactly those
bytes.

A file that genuinely contains U+FFFD, as valid UTF-8 text the author meant, is
indistinguishable from one decoded from invalid bytes, and is therefore
**uneditable** here: no `edit` or `apply_patch` can reproduce its bytes. Replace
the whole file with `write` — a `read` that refused it as binary is the
permission `write` accepts, and the result says so — or change it with an
external tool (or `shell`, which is not filtered). The refusal is recorded with
a sha256: if the bytes change after that refused read, `write` asks for a fresh
read first.

### Write safety

`write`, `edit`, `apply_patch` and `todo.write` never truncate the target: the
content goes to a sibling temp file (`<name>.z1-tmp-<pid>-<rand>`) and is
renamed into place, so a failure leaves the old bytes. An existing file keeps
its mode; `todo.write` forces `0600` and creates `.z1` as `0700`. A kept mode is
reported only when it is not an ordinary `0644` file or `0755` executable, and a
result the owner cannot read (no owner read bit, e.g. `0000`) always adds a
`warning: the resulting file is not readable` note.

`write` additionally refuses to overwrite a file this process never read, or one
whose bytes changed since that read (`write: read "<path>" before overwriting
it`, `write: "<path>" changed since read`). `read` records a sha256 of what it
returned; `write` and `edit` refresh it. The one exception is a file the same
process's `read` refused as binary: that refusal is recorded with its hash and
`write` may replace exactly those bytes (`…, replaced a file the tools read as
binary`), because otherwise the README's own recovery — rewrite it with
`write` — would be impossible; `edit` and `apply_patch` still refuse it. The map
is per process and keyed by workspace and resolved path, so a restart simply
asks for a fresh read. This catches the stale-context mistake, not a concurrent
writer: the hash and the rename are separate syscalls (see the TOCTOU note
below).

A target with more than one hardlink takes that same rename path: the target
gets a new inode and the other names keep the old bytes, so the write stays
atomic but the link is gone — the result says `broke N hard link(s)`. That is
the deliberate default and the only built-in path: a link made outside the
workspace would otherwise be a way to rewrite a file the guard protects through
a writable name, and rewriting the shared inode is the one write that could
truncate it on a short write. `shell` remains the residual bypass, because it
is not filtered and can still rewrite the shared inode directly. The policy is
shared by `write`, `edit` and `apply_patch`; `apply_patch` reports the count per
file, after its `+a -r block lines`.

`apply_patch` parses the whole patch and applies every block in memory before
touching a file, so a parse or match failure changes nothing. Each changed file
is then written to a sibling temp file and swapped in by its own atomic rename.
If a later rename fails, files already swapped are restored on a **best-effort**
basis — old bytes, mode and mtime are rewritten, the helper swallows a restore
failure, and a restored file is a new inode, so hard links are not reattached.
An interrupted commit can therefore leave a mix of old and new files; it is not
a whole-patch rollback. The reported `+a -r block lines` are a line diff of the
applied region (common prefix and suffix trimmed), not the size of the quoted
halves, so a block that quotes text it does not change reports `0` and the
header counts only changed blocks and changed files, adding
`(k blocks made no change)` for the rest. Patch markers are recognised by
prefix, not by context: a quoted line that begins with `*** Begin Patch`,
`*** End Patch`, `<<<<<<<` or `>>>>>>>` is read as an envelope marker, so text
containing such a line cannot be patched in — rewrite the whole file with
`write` instead.

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
  includes every finished task, and `limit` (1–200) bounds the finished rows
  whether or not `all` is set (the newest are kept), with the omitted count
  printed.
- `process.start` merges `env` over the inherited allowlist and rejects a
  non-string argument or variable instead of dropping it silently. A command
  that fails instantly (port taken, missing binary) is reported as exited,
  together with its output, instead of as "running".

## Search and ignore rules

`glob` and `grep` share one dialect: `*` and `?` do not cross `/`, `**` does,
`{a,b}` alternates and `[...]` is a character class. A pattern **without a `/`**
is matched against the basename at any depth (`*.md` finds `docs/a/b.md`); a
pattern containing `/` is matched against the path relative to the root.
Absolute patterns are rejected — pass a relative `pattern` plus a `path` root —
and a pattern with an unterminated `[` is a clear `not a valid glob` rather than
a silent literal (`glob("/")` is invalid, not "absolute").

A glob is compiled to a regex, so shapes whose backtracking can blow up are
refused before the walk with `glob.pattern is too expensive; simplify the
alternations or wildcards` (`grep.glob is too expensive` for the file filter).
Every glob is priced as `alternatives × C(200 + stars, stars)`: the ways its
brace branches and its star split points can divide a 200-character name. A
price above 8 million is refused, which keeps three stars with a few brace
groups (the busiest shape a model writes) and refuses the four-star cliff,
measured at 1.3 s on such a name. A pattern longer than 1024 characters is
refused before it is priced or compiled (`glob.pattern is too long (N chars,
limit 1024)`): the price scan and the translation both look ahead for a closing
`}`/`]`, so a pattern made of openers is quadratic in its own length. A
`.gitignore` line of either shape is skipped instead of compiled, and the answer
says `… (ignored N unsafe .gitignore rules)`: the rest of the file still
applies, and the paths the line would have pruned are visibly not pruned.

`.gitignore` is honoured from the repository root (the nearest ancestor with a
`.git` entry) down to the search root, and from every directory visited
(directory patterns, `!` negation and `**` included), so a search of `src/`
still skips a root `dist/` or `*.log`. `.git`, `node_modules` and `.z1/out` are
always pruned, as is a marked `z1/` session store and each symlink alias of it.
`glob` and `grep` skip those silently and report the shared walk counters;
`list` and `tree` show the entry once as `(ignored)` (the session store as
`(z1 state, ignored)`) and never descend. `includeIgnored: true` on any of the
four tools disables both the ignore rules and the noise-directory prune (the
marked session store and its aliases are still hidden; the caps still apply).
Caps are counted in files, not directories.

`grep` compiles the pattern with the `u` flag, is **case-sensitive by default**
(like ripgrep; `caseSensitive: false` opts in), returns `(no matches; …)` rather
than an empty string, ends every result with a summary of matches, files and the
walk counters, and reports skipped binary, oversized and unreadable files there.

`glob` and `grep` share one walk-counter shape, in the same words: `N files
walked` (entries the walk collected), `M ignored paths skipped` (pruned by
`.gitignore`, a noise directory or the session store), and for `grep` also `K
files searched` (files actually read after the pattern/glob filter). `glob`
prints them after its matches; `grep` puts them in its summary, so the same tree
yields the same walked and ignored numbers from either tool.

A pattern may be at most 512 characters, and shapes whose backtracking can blow
up are rejected before the walk with `grep: pattern is too expensive; simplify
it`: nested repetition such as `(a+)+`, `(a?){25}a{25}` or `(\w+\s+)*`,
ambiguous alternation such as `(a|ab)+`, `(a|a)+`, `(\w|\w\w)+` or `(.|a)+`
(non-capturing groups are compared by their own body, and `\w`/`\d`/`\s`,
negated classes and `\p{…}` count as first characters), and a backreference to a
long or repeating group. Matching is bounded too: a line over 16 000 characters
is matched on that clipped head only (its tail is not searched, and the summary
counts the lines), the call stops after a 5 s budget with `grep: stopped after N
ms; narrow the query`, and each match slice has a 1 s watchdog. The match runs
in a `node:vm` context under `runInContext`'s timeout (allowed by the worker's
permission model, unlike `worker_threads`), so one line that slips past the
heuristic and backtracks for minutes is terminated at the slice deadline and
reported with the same stopped message instead of pinning the worker.

The rejection is a heuristic, not a proof: a novel pattern can still be slow up
to one slice, and a hit beyond the 16 000-character head is not searched. Two
display clips apply to a hit, on separate budgets: a result path is clipped near
200 characters and its content near 400, so a long path cannot leave only 120
characters of content. The whole answer is capped at 64 KiB.

## Limits

- `read`: 1 MiB per file, 2000 lines per call, 1-based `offset`. The size is
  checked with `ctx.fs.stat` before the file is loaded, so a 4 GiB file is never
  read; the NUL/U+FFFD scan then covers the whole text (still at most 1 MiB), not
  a head. Both fail with a clear error (`file is <n> bytes; use shell sed -n`,
  `binary file: <path>`).
- `read` output: about 100 000 characters per answer and 2000 characters per
  line. A clipped line says `… +N chars` and a cut window names the next
  `offset`, so the answer has a bounded size whatever the file looks like.
- `list`, `glob`, `grep`: depth 8, 5000 files. `glob` returns at most 1000
  paths and 64 KiB; `grep` at most 200 matches, `context` 0–20, 1 MiB per file,
  a 512-character pattern, a 5 s matching budget with a 1 s per-slice watchdog,
  and separate display clips — a line is matched on its first 16 000
  characters, a result path is clipped near 200 and its content near 400, so a
  line can match on text that is never printed. Truncation, depth limits,
  walked/searched files and ignored paths are printed, never implied.
- `tree`: depth 7 (default 3), 3000 entries, 64 KiB.
- `stat`: one line; `mode` is the four-digit `lstat` mode with setuid/sticky
  bits (`0755`, `4755`), `nlink=N` appears only above 1, and `mtime` is local
  ISO 8601 with its UTC offset (`2026-11-15T16:09:54.553+02:00`). A symlink adds
  `-> target` and one of `(dangling)` (target missing), `(loop)` (the link
  chain does not terminate) or `(unresolvable: CODE)`; a loop is not reported as
  dangling.
- `mkdir`: `mode` is an integer 0–4095, `recursive` defaults to true. The result
  reports the mode the directory really got, so a requested `0777` under umask
  `022` says `with mode 0755`; the process umask is not visible to the worker.
  An existing directory is success (`exists … (directory)`); an existing file,
  FIFO or device is refused; with `recursive: false` the parent must exist. A
  final symlink is decided by its target: inside directory -> `exists`, inside
  file -> refused, dangling -> explicit "target does not exist" (never the
  misleading "pass recursive: true"), outside -> `path escapes workspace`.
- `move`: an existing destination needs `overwrite: true` — a replacement is
  never implied. A directory is never merged into an existing one. The parent is
  re-resolved and its `dev:ino` verified by the helper immediately before the
  rename, so a parent swapped for a symlink after the first check is refused.
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
`tree` cannot be steered out of the workspace by a link. A link that resolves to
a directory is still counted as a directory rather than as a file of unknown
size, so the walk counters of `glob` and `grep` agree, and `tree` marks a target
outside the workspace: `name -> target (outside workspace)`. `stat` uses
`lstat`, so it reports the link itself plus `-> target`, marked `(dangling)`
when the target is gone, `(loop)` when the chain does not terminate, or
`(unresolvable: CODE)` for another `stat` failure. `move` moves the link, not
its target. `mkdir` is the exception: it must follow the final link to decide
whether a directory already exists, so it contains the target first and refuses
an outside one. A path that resolves through a symlink to the outside is
refused by the containment check before use; a dangling link is judged by the
path its target would have, resolved component by component rather than by a
lexical `..` shortcut.

## stat, move and the helpers

The broker exposes `fs.read`/`fs.write`/`fs.list`/`fs.stat`, and the worker runs
under Node's permission model, which denies `realpath`, `rename` and `readFile`
even on write-granted paths. `stat` therefore uses a small `lstat` helper (the
broker's `stat` knows no mode, link count or special file), while path
containment (`realpath`-style component resolution), `move` (`rename`, with an
`EXDEV` copy-then-delete fallback) and the atomic temp-file renames run minimal
`node -e` helpers through `ctx.process.run`: argv array, no shell string, no
dependency. The `lstat` helper also returns `loop`/`unresolvable` for a
symlink and a `dev:ino` identity, which `move` hands to its rename helper to
verify the destination parent has not been swapped. A helper's stderr is
clipped to its error line before it is wrapped in a tool error, so a failure
names the path and the reason, not a 15-line `[eval]` stack. When the `lstat`
helper cannot run at all, `stat` asks the broker's `list` for the entry type
(which does not follow links); if even that is unavailable it reports `unknown`
rather than the target type the broker's link-following `stat` would report.
`mkdir`, `write` and `unlink` use `node:fs`/the broker, which the write grant
allows. Reads and writes still go through the broker, so grants and denials
stay auditable.

Known limitations, stated rather than hidden:

- **TOCTOU.** Containment, the read-before-overwrite hash and the rename are
  separate syscalls. A writer racing between the hash check and the rename can
  still surprise the tool; no Node API closes that window. `move` narrows its
  own window — the parent is re-resolved just before the helper and the helper
  checks `dev:ino` — but the final check and `rename` are still two syscalls.
  The tools fail loudly rather than assuming the check was atomic.
- **Hardlinks.** A hardlinked target is renamed like any other file, so after a
  `write`, `edit` or `apply_patch` its other names still hold the old bytes and
  the result reports `broke N hard link(s)`. The write stays atomic; nothing
  updates every name on the inode, because that would also be the one
  non-atomic write. `shell` is not filtered and can still do it.
- **`move` across devices.** `rename` is atomic within one filesystem; an
  `EXDEV` move copies to a unique temp name and then deletes, so an interruption
  can leave both copies. A source that cannot be removed after a successful copy
  is reported, never hidden.
- **Windows.** `rename` onto an existing file is refused there, so the atomic
  writers fall back to remove-then-rename (`EEXIST`/`EPERM`): the file is still
  never truncated by the default path, but the swap is briefly non-atomic. An
  `overwrite` move fails cleanly instead of replacing.
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

## Tests

There is no `package.json` and no dependency to install: the suite is plain
`node:test` files under `tests/`, driving the real `lib/*` tools through a fake
worker context (`ctx.workspace`, a broker-shaped `ctx.fs` over real `node:fs`
in a fresh `mkdtemp`, and `ctx.process.run` spawning the real helpers). Every
test builds its own temp workspace and removes it, so nothing touches the clone
or the home directory. Run all of it with:

```sh
node --test tests/
```

The suite is the regression net for the containment, dangling-symlink, `move`
parent, binary-write, `stat` loop, `mkdir` symlink and reporting fixes described
above; each file names the behaviour it pins.

## License

MIT — see [LICENSE](LICENSE). The module declares `"license": "MIT"` in
`manifest.json`; the copyright holder is `ayzitix` (2026).

The module is a tools service only: it ships no host code and no runtime
dependencies.
