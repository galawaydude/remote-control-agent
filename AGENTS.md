# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Design authority

The product spec, stack rationale and the ordered PR breakdown for Milestone 1 live outside
this repo at `/home/galawaydude/Documents/Projects/firstmate/data/tether-arch/report.md`.
It is the result of verified empirical work — do not re-litigate the stack choices from it.
The Codex provider has its own empirical study next to it at
`../tether-codex-spike/report.md`, with the binding hook-install decision in
`../tether-codex-spike/decision-codex-hook-trust-install.md`.
`README.md` is the landing page; `docs/` carries the user and security guides,
`CONTRIBUTING.md` carries development/release/API/test detail, and the reports carry the
reasoning.

## Commands and layout

See `CONTRIBUTING.md`. Every check is in root `package.json` scripts and CI runs those,
plus installer, workflow and secret checks that are not npm scripts; `.github/workflows/ci.yml` is the
authoritative list. CI has parallel Quality, Tests, End-to-end and Security jobs plus one
stable `CI` aggregate check. External actions are full-SHA pinned; CodeQL runs separately on
PRs, `main` and a weekly schedule. `release.yml` calls the same product CI workflow before it
creates an exact `vX.Y.Z` tag on `main`, so an unvalidated tag never reaches the installer.
Everything CONTRIBUTING lists is runnable locally.

## Sharp edges

- **The product is Remote Control Agent; `rcagent` is the command.** It was formerly
  tether, and the old identifiers are compatibility contracts rather than unfinished cleanup:
  the `tether` command alias, `TETHER_*` environment aliases, `@tether/*` private workspace
  scope, `tether` tmux socket/session prefix, `tether.conf`, `tether.sqlite`, hook header and
  filenames, browser storage/cookie keys, and `dev.tether.server` service label all remain.
  Existing installs keep `~/.local/share/tether` and `~/.local/state/tether`; new ones use
  `remote-control-agent`, selected only when the old directory is absent. Moving a hook path,
  state directory, tmux socket or service label loses live or durable work, so none is renamed
  without a separate migration. User-facing copy says Remote Control Agent and new settings use
  `RCAGENT_*`, with the old spelling as fallback.
- **`shared/` is types only.** It emits `.d.ts` and no JavaScript, and its `prepare` script
  builds it on `npm ci` so `tsc --noEmit` works on a fresh clone. Import from it with
  `import type`; `verbatimModuleSyntax` enforces that.
- **Each package has two tsconfigs**: `tsconfig.json` (noEmit) and a second one for the files
  it does not cover — `tsconfig.build.json` where the package emits, and `web/tsconfig.node.json`
  for web's Node-side files (`vite.config.ts` and the tests). Web's `tsconfig.json` is the
  browser program: `types: []` plus that split is what keeps Node globals out of it, since
  vite's own declarations pull `@types/node` into any program containing `vite.config.ts`.
  That Node-side program also sets `jsx`, because a web test reaching a type declared in a
  `.tsx` pulls the component file into it and `--jsx` unset is an error there, not a skip.
  `tsc --noEmit` at the repo root is not configured — use `npm run typecheck`.
- **TypeScript is pinned to 5.x.** TypeScript 7 is released but `typescript-eslint` still
  peers on `<6.1.0`; upgrading TS ahead of that breaks `npm install`.
- **Node 22.18 is the floor, not the newest development release.** `node:sqlite` needs 22.x
  and the test suite's unflagged TypeScript execution needs 22.18. `.nvmrc` and CI run that
  floor so a newer-only API cannot slip in; `install.sh` compares the complete version because
  accepting 22.17 as “Node 22” fails later instead of helping.
- **npm 12 blocks dependency install scripts by default.** A dependency that silently fails
  to build is usually this; approve it with `npm install-scripts approve <pkg>`, which writes
  a version-pinned entry into the root `package.json`'s `allowScripts` — so bumping such a
  dependency needs a fresh approval. `node-pty` is approved there and ships no Linux prebuild,
  so `npm ci` compiles it and a machine with no C++ toolchain gets no PTY at all.
  `machine/terminal.ts` imports it lazily and `tether serve` then refuses to start with an
  instruction instead of an import crash; CI proves it built before running anything else.
  **macOS has the opposite failure and it is silent.** There node-pty uses a prebuild, and
  that prebuild ships `spawn-helper` — which macOS starts _every_ process through — without
  its executable bit, so `posix_spawnp` refuses and every terminal attach dies while nothing
  else is wrong. The bit is _set_ in two places on purpose, not by accident: the root
  `postinstall` on every `npm ci`, and `install.sh` again for the tag it just built (see the
  installer entry below for why it cannot rely on the first). It is _proven_ in a third,
  which sets nothing: `npm run check:pty` — `machine/pty-smoke.ts` — asserts the bit and
  fails when a PTY cannot start, because a Linux CI runner carries the darwin prebuilds and
  is therefore the only place this can be proven without a Mac. It looks in every directory
  node-pty resolves from (`build/Release`, `build/Debug`, `prebuilds/<platform>-<arch>`) and
  names no architecture; anything that starts hardcoding one has gone wrong.
- **`npx tether` only works because `server`'s `prepare` builds during `npm ci`.** npm links
  workspace bins before install finishes and skips a bin whose target is missing, so
  `dist/cli.js` has to exist by then — and it has to carry the exec bit itself, which is why
  `build` ends in `chmod +x`. `prepare` builds `@tether/shared` first: npm runs the two
  workspace `prepare` scripts in the wrong order otherwise and `server`'s `tsc` cannot find
  the declarations.
- **Every tmux command goes through `server/src/machine/tmux.ts`.** It carries
  `-L <socket> -f tether.conf` on _every_ invocation, so whichever command starts the
  server starts it with tether's config. The attach in `terminal.ts` needs a PTY rather
  than a pipe, so it takes its argv from that module's `tmuxArgv` — build a tmux argv
  anywhere else and `-f tether.conf` goes missing. `tether.conf` is a non-TS asset, so
  `tsc` does not copy it — `server`'s `build` script does, and anything that moves the
  file must move that `cp` too. The reason for each rule is in the module's own comments;
  the traps they defend against are in report §2/§3/§7.
- **The terminal is re-derived, never remembered.** `machine/terminal.ts` holds no byte
  log, no ring buffer, no sequence numbers and no resume cursor: every attach replays
  `capture-pane` and lets tmux's own attach repaint resync the viewport, which is
  idempotent by construction (report §3). If a change here starts needing a cursor, the
  change is wrong. Two things it does need and that are easy to remove by accident: the
  path is **binary from PTY to `term.write(Uint8Array)`** — any decode splits a UTF-8
  glyph on a chunk boundary — and `machine/escape.ts` strips alt-screen and mouse-tracking
  sequences while deliberately leaving `ESC[2J`/`ESC[J` alone, because the repaint is built
  on them. `terminal.test.ts` is the guard: real tmux, non-ASCII glyphs at full pane width,
  byte-exact against `capture-pane` ground truth. A mostly-ASCII pane passes on a broken build.
- **The terminal is the only browser session interface.** `app.tsx` mounts one active
  `TerminalView`; it does not mount, fetch or subscribe to the provider transcript, and
  there is no Conversation/Terminal toggle, composer, tool card or browser approval
  surface. Provider-specific code still starts, resumes and reads status for each CLI,
  but bytes in the terminal are universal and never mapped. With no `conv` watcher,
  permission hooks report no browser hold and the provider's own dialog is authoritative.
  Do not restore a hidden conversation pane: it still spends bandwidth, parses private
  formats and can pre-empt provider policy even if CSS keeps it out of sight. Terminal
  history comes from tmux (100k retained, 5k replayed). A live tmux attach can
  coalesce a burst into one repaint, leaving xterm with no local history although
  tmux has it; the first **Pg↑** therefore toggles output off/on to invoke the
  existing `Terminals.refresh`, waits for capture plus repaint, then calls
  `term.scrollPages(-1)`. Later pages are local; **End** calls
  `term.scrollToBottom()`. xterm 6 uses an internal scroll model, not a native
  scrolling element, so DOM `scrollTop` is not a valid implementation or test.
- **tmux 3.7 is a hard floor.** `tether.conf` sets `window-size manual`, and tmux
  before 3.7 sizes a not-yet-created window through a NULL pointer, so every detached
  `new-session` dies with `server exited unexpectedly`. Ubuntu 24.04 ships 3.4, hence
  the source build in `.github/actions/setup-tmux/action.yml`. That message from any tmux command
  means the tmux on `PATH` is too old, not that the argv was wrong. `install.sh` builds
  the **same pinned release and checksum** for a user's machine, so those two constants
  now live in two files and must be bumped together. It is the repo's only shell script
  and is held to `shellcheck` and to its own `bash install.sh --self-test`, both of
  which the Quality job runs before its Node checks, because nothing else in the
  repo's checks looks at shell at all. What that self-test covers is every branch in
  the file that can be silently wrong: the version parsing (a `tmux 3.4` read as new
  enough is a session that dies at birth), the PATH message, every supported Linux
  package-manager plan, launchd/systemd escaping, the two Funnel questions below,
  and the `TETHER_VERSION` checkout moves. Its consent rule is
  the Codex hook's, generalised: nothing outside tether's own directory changes without
  the exact commands on screen and a yes, declining prints them and stops, and no shell
  startup file is ever edited. Keep the surrounding installer copy short: one risk, the
  exact commands or service bytes, and the next action; longer rationale belongs in the
  README. A sentence it cannot back with something it actually checked is deleted rather
  than softened, because a caveat is itself new length and new claims. Two things about it that the script alone does not
  show. **It installs the highest `vX.Y.Z` tag, so merging to `main` ships nothing** —
  a change reaches the public install line only when a release tag passes `release.yml`
  (`CONTRIBUTING.md` → _Cutting a release_), and `install.sh` itself is the one exception,
  being fetched from `main` so that it is what knows how to find the current release.
  That exception is also a **constraint on the script**: it runs from `main` against a
  checkout at an older tag, so it may never call anything that exists only in newer code.
  The `spawn-helper` chmod and the terminal check are therefore written out inside it,
  duplicating what the repo does for itself — a released tag has neither, and on a Mac
  that gap is the whole bug. `TETHER_VERSION` moves an **existing** install, not only a
  fresh one, and to a branch as well as a tag: the clone is shallow and holds exactly one
  ref, so `update_checkout` fetches the ref by name — tag refspec first, which is what
  keeps `git describe` in the install directory naming the release — and checks out
  `FETCH_HEAD`. `git checkout <some other tag>` there fails with "did not match any
  file(s) known to git" no matter how new the ref is; `--self-test` covers both moves
  against a throwaway local repository, so it needs no network.
  And the `tether` command is a **symlink into `~/.local/bin`**, not `npm link`: npm's
  global prefix is root-owned wherever Node came from a distro package or a tarball,
  which made the last step of the script the one that failed after every expensive
  consented thing had already been spent. Anything that moves `server/dist/cli.js`
  moves that symlink's target. A public install can additionally write exactly one
  consented user service — `~/Library/LaunchAgents/dev.tether.server.plist` or
  `~/.config/systemd/user/tether.service` — after printing its complete bytes and
  commands. PATH is captured because neither manager reads shell startup files; Linux
  enables linger so a headless user service starts before login. An already-correct
  unmanaged server is never killed for migration: the service is enabled for the next
  login/boot. With no reachable manager or a decline, `nohup` remains the current-boot
  fallback. The main-vs-release constraint above applies here too: the service may
  invoke only the long-existing `tether serve --funnel`, never a new helper command.
- **Tailscale Funnel is the clientless default, and `--funnel` is composition
  rather than control.** Tailscale is installed only on the host; everyone opening
  the link uses an ordinary browser and needs no Tailscale account or app.
  `machine/tailscale.ts` only ever _reads_ the structured `status --json
--peers=false` and `serve status --json` documents; `install.sh` is what installs
  Tailscale on the host, turns Funnel on and installs the optional user service,
  because those are machine/user-wide changes that outlive the server. On macOS it
  offers Tailscale's signed, recommended Standalone package through the OS package
  installer, never guesses between app variants silently. The server remains no
  network manager: `--funnel` never installs, enables or repairs Tailscale. Three facts established
  by putting a header echo behind a real Funnel (tailscale 1.98.10, captured in
  the PR): it forwards `Host: <name>.ts.net` with **no port**, sets
  `X-Forwarded-Proto: https` and a real client `X-Forwarded-For`, and marks
  itself with `Tailscale-Funnel-Request: ?1`. That is why the composition is
  bind `127.0.0.1` + allow the derived name + trust `127.0.0.1`, and the three
  are one decision: the loopback bind is what makes trusting that proxy's
  `X-Forwarded-*` safe, and the trust is what gets the session cookie its
  `Secure` flag. **The password rule is extended, never excepted** — the check
  is no longer "off-loopback", because `--funnel` binds loopback and is the most
  exposed tether can be. A `--funnel` that could start without a password is the
  one regression here that publishes a shell. `Self.DNSName` carries a trailing
  dot and the capability set appears in both `Self.CapMap` and the deprecated
  `Self.Capabilities`; the precondition order is fixed, because a logged-out
  node reports **no** capabilities and asking about Funnel first tells someone
  to edit their ACLs when they need to sign in. `install.sh` reads that same
  JSON for the same reason, through the one `ts_status` helper — spawned
  **once** per run and handed to the readers as an argument, so no reader can
  forget **`--peers=false`** and no second spawn can come back empty where the
  first came back with a document — every question it asks is about
  Self, and a full status carries a `DNSName` and a capability set per peer, so
  a match found anywhere in it is not an answer. It derives the published
  address from `Self.DNSName` there, and asks `tailscale serve status --json`
  (`AllowFunnel["<name>:443"]` **and** the `/` handler's `Proxy`, two questions
  and two different ports) whether Funnel is already armed. **Permitted and
  armed are different questions and each has exactly one source.** `AllowFunnel`
  is absent on every machine that has not armed Funnel yet, so it can never
  answer the first; permitted-but-unarmed is what a fresh machine _is_, and it
  has to go on and arm. And the permitted answer is **tri-state**: a capability
  set without `funnel` in it is a real no, but a status carrying no capability
  set at all is `unknown`, which is not a no. In the server, `no` remains a precise
  precondition. In the installer both answers are now advisory: current Tailscale's
  own `funnel` command can open the one-time account approval that enables HTTPS
  and adds the policy, so blocking before that command strands exactly a fresh
  install. The installer runs the consented command and lets it refuse in its own
  words when this user cannot approve it. Both probes remain pure string functions
  taking the document as an argument, which is what lets `--self-test` drive
  them; the fresh-machine pair (`{}` serve status, a status with no `CapMap`) is
  the case that had no coverage and is now the point of that block. **The same
  tri-state is in `machine/tailscale.ts` and had to be**, since the installer
  ends by running `tether serve --funnel`: an `unknown` the script carried on
  past would otherwise die there under the very sentence it declined to print.
  An **empty** capability set is not the unknown case in either — it is a node
  granted nothing, which is a real refusal. Neither is scraped
  out of `tailscale funnel status` — human-readable output another tool owns
  must never gate a flow, and here that is not tidiness: `funnel status` _is_
  `serve status`, so a tailnet-only `tailscale serve` prints the same proxy line.
  Public means **both** `AllowFunnel["<name>:443"]` and the root handler's Proxy;
  `machine/access.ts` uses the same rule, refuses to follow a non-loopback target
  (status must not become SSRF), probes loopback with the derived Host, then probes
  real public HTTPS. `tether access status` prints those facts independently and
  changes nothing. Before the installer arms Funnel it proves the target port is
  closed or identifies an existing tether through the exact default-deny 401/body
  from its protected sessions endpoint — a catch-all 200 is not identity — and
  sets/confirms the tether password. Reversing that order can temporarily publish
  an unrelated loopback service or a passwordless shell. The installer writes these
  checks in shell because main's installer can target an older release without the
  status command.
  And `tailscale funnel` **prompts**: without a terminal it waits rather than
  failing, so the installer passes `--yes` only after putting the machine-wide
  command on screen and taking a yes; account approval remains Tailscale's own
  browser flow. Anything else there would hang `curl | bash`.
- **`cwd` is a trust boundary and `resolveCwd` in `machine/tmux.ts` is the only
  gate.** It resolves the path (symlinks included) _before_ checking it, and confines
  the result to `allowedRoots()` — the user's home unless `TETHER_ALLOWED_ROOTS` (a
  `:`-separated list) widens it. Containment is `path.relative`, never a string
  prefix: `/home/user2` is not inside `/home/user`. Everything that starts a session
  goes through it; do not add a second path check anywhere. Tests that start sessions
  in a temp directory set `TETHER_ALLOWED_ROOTS` rather than bypassing it.
  `machine/sessions.ts` holds the one create/delete sequence — tmux plus registry,
  rollback on a failed insert — that both the CLI and the HTTP routes call.
- **Terminal input is `text` frames plus `key` frames, and the split is
  load-bearing.** Every printable character a user types goes in a `text` frame
  (`web/src/keys.ts` → `Terminals.text`), never as a tmux key name, because tmux's
  lexer eats some arguments before the command sees them. What it eats is
  `mangledByLexer` in `server/src/machine/tmux.ts`: a standalone `;`, `{` or `}`,
  **or any argument ending in `;`**. An exact-match check is not enough and the
  failure is silent — tmux 3.7b strips a trailing `;`, eats the backslash of a
  trailing `\;`, and exits 0 either way, so `git status;` loses its `;` with
  nothing to catch. The rule has exactly one home, behind `checkArgs` and the
  exported `isSeparatorArgument`, and every argument-bearing tmux command remains
  under it. Ordinary `text` no longer builds such a command at all: it writes to
  the already-attached PTY, which both bypasses the lexer and removes one process
  spawn per character. Text with a line break still goes through the paste buffer
  so bracketed paste is not submitted line by line. Unambiguous controls (Enter,
  Tab, Backspace, Escape and `C-a`–`C-z`) take the same PTY fast path; cursor and
  navigation keys remain tmux key names because application-key mode decides
  their bytes. The guard is not relaxed for those. Its other half is blast radius:
  a frame the guard refuses is an undeliverable
  **frame**, not a dead attach, so `web/term-socket.ts` logs, ACKs and drops it and
  keeps the socket open — only a genuinely gone attach closes at all, and it
  closes with **no code**, so the client reconnects: `CLOSE_ATTACH_FAILED` is the
  one the client now settles on, and settling here would cost a live session a
  reload where re-attaching would have fixed it. That is why a stray Alt+`;` costs one keystroke instead of
  a reconnect and a full replay, and it is the easiest thing here to undo by
  accident. On the browser side, `xterm.onData` is **not only the keyboard** — it
  also carries xterm's replies to terminal queries (OSC colour reports, DA, cursor
  position, focus in/out). `keys.ts` maps the sequences a keyboard really produces,
  modifier-encoded cursor keys included, and drops every other escape sequence,
  because typing one of those into a pane puts `;rgb:0000/0000/0000` in the agent's
  prompt. It also keeps a bracketed paste whole — markers consumed, newlines kept,
  one `text` frame — so the paste lands as a paste; splitting it submits a pasted
  prompt line by line. All of it is covered by `keys.test.ts`, `server.test.ts` and
  `terminal.test.ts` against real tmux.
- **The browser app may not use a secure-context-only web API.** Remote phones
  can load plain HTTP behind a private proxy, where `crypto.randomUUID` and
  `crypto.subtle` are absent. `TerminalView` once called `randomUUID`, threw
  before `connect()` and stayed on Connecting forever. `keys.ts`'s `newClientId`
  uses `getRandomValues`, which has no secure-context gate; its unit test is the
  guard.
- **The `term` socket's handshake completes before its route handler runs.**
  `@fastify/websocket` upgrades and _then_ calls the handler, so the browser's
  `onopen` has already fired — and its first act is to enable output and send its
  size — while `term-socket.ts` is still several tmux spawns from having an attach. A `ws` message with no listener is discarded, so the
  listener goes on **before** that `await` and queues into `handle`: a frame
  dropped in that window is never applied. The window is widest for a second viewer,
  whose attach is a `capture-pane` plus a `refresh-client` rather than a plain
  `attach-session` — which is why `server.test.ts`'s two-viewer test is the one
  test in that file that drives a real tmux.
- **The browser app is served by two named routes, not a wildcard**
  (`server/src/web/static.ts`). `@fastify/static` is registered with
  `serve: false` purely for `reply.sendFile`; `/` and `/assets/:file` are the only
  routes marked `public` besides `/api/login` and `/internal/hook`, which is not
  unauthenticated but authenticated differently (loopback plus the `0600` secret,
  see the hook entry below). A wildcard would answer every
  unmatched path publicly and hand an unauthenticated caller a 404-vs-401 oracle
  for which API routes exist. Hashed assets are immutable for a year and ordinary
  HTTP responses are compressed by `@fastify/compress`; its `onRoute` hook only
  reaches routes declared after the plugin loads, so `server.ts` registers **all**
  routes inside the one `app.after()` that already made WebSockets work. Moving a
  route back out silently sends the full browser bundle over Funnel. `web`'s
  `prepare` builds `web/dist` on `npm ci` for the same reason `server`'s does —
  `tether serve` reads it at startup and only warns if it is absent.
- **All persistent state lives outside the repo, and nearly all of it is one SQLite
  file**, opened by `server/src/db.ts` — `~/.local/state/tether/tether.sqlite`, file
  `0600` in a `0700` directory (`$XDG_STATE_HOME`, or `$TETHER_STATE_DIR`, which tests
  and any manual run must set rather than touch the real one). The rest is the Codex
  hook's shim and its per-session logs in that same directory, owned by
  `providers/codex/hooks.ts`, and the backups tether takes before it writes a
  folder-trust entry into an agent's own config — in there too, never beside the
  original. Never write runtime state into the repo; a
  path that is not in the repo cannot be committed by accident. `db.ts` owns the path
  and the mode bits — `machine/registry.ts` only adds its schema on top, applied on
  every open (`CREATE TABLE IF NOT EXISTS`). There is no migration framework, so a
  column added later must be added compatibly. `provider_session_id` is deliberately
  nullable: Codex has no session identity until the first user message, so the row is
  provisional from spawn and back-filled. It is also **not stable for the life of a
  session** — `/resume` and `--continue` move Claude Code to a different session id and
  a different transcript, verified live on 2.1.220 — so it is what the pane is running
  _now_, re-read from `~/.claude/sessions/<pane_pid>.json` rather than settled once.
  `Conversations` is the only writer: `#bind` records it and, for a session anyone is
  watching, restarts the tailer and sends `{c:'refetch'}` so the view follows. It has
  two callers, because the row has to follow the pane whether or not anybody is
  watching: the status poller, and the **session list**, which reads its badge
  through `Conversations.paneState` and holds no reader of its own. A badge may
  never again ask about the id the row _used_ to carry — that is what emptied it,
  `waiting` included, until somebody opened the conversation. Widening it costs no
  guard: the pid is a tether pane's, so a hand-run agent is in no pane and is never
  reached, and `status.ts`'s liveness and `procStart` checks are what say the file
  under that pid is really that pane's.
  Rows are marked dead, never physically deleted: a dead row
  is what `resumeSession` (`machine/sessions.ts`) restarts through the provider's own
  resume, and `revive` is the only thing that clears `dead_at`. **Remove** on a dead
  list row sets nullable `removed_at`, which hides it from every ordinary registry
  read and makes it unresumable while retaining its tombstone and provider session id;
  the provider owns the transcript and tether never deletes it, and retaining the id
  keeps discovery from assigning that conversation elsewhere. Existing databases gain
  the column in `applyRegistrySchema`'s one compatible `ALTER`; two processes racing the
  ALTER re-check its postcondition. A live row cannot be removed, and `resumeSession`
  checks that `revive` changed a row after its awaited spawn, rolling the pane back if a
  concurrent Remove won. A row whose `provider_session_id` is still null has no exact
  provider session to restore, and resume refuses it rather than starting fresh. The
  dead terminal screen exposes Resume because the row already identifies what to start.
  A successful resume updates the open `Session` and remounts its terminal socket; while
  dead, `SessionScreen` starts no attach.
- **Tests run straight from TypeScript** via `node --test` and Node's built-in type
  stripping. There is no test build step; relative imports carry the `.ts` extension.
- **HTTP routes are default-deny.** A `preParsing` hook in `server/src/web/server.ts` rejects
  every request without a valid session unless the route sets `config: { public: true }`.
  It runs before body parsing, so an unauthenticated caller reaches neither the body parser
  nor a 404 that would tell it which paths exist.
  Adding a route therefore protects it automatically — and marking one public is a security
  decision, not a convenience. Reaching any route is equivalent to a shell on the machine.
  The `term` WebSocket is covered too — `@fastify/websocket` dispatches the upgrade through
  the normal router — but only because its route is registered inside `app.after()`, after
  that plugin's `onRoute` hook exists; register it earlier and it silently stays a plain
  HTTP route. The Origin guard needed extending by hand, since an upgrade is a `GET` and so
  is not state-changing, and a cross-origin page's upgrade carries the victim's cookie.
- **The conversation is read from the provider's own transcript, and parsed
  tolerantly on purpose.** Both providers append NDJSON, so `providers/tail.ts`
  is shared and only the paths and record vocabularies differ:
  `claude-code/transcript.ts` finds `~/.claude/projects/<sanitised cwd>/<id>.jsonl`,
  `codex/rollout.ts` finds `$CODEX_HOME/sessions/<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl`,
  and each directory's `events.ts` maps records to `ConversationEvent`. Which `<id>`
  comes from the pane, not from a scan — see `provider_session_id` above; the
  timestamp-and-mtime search in `findTranscript` is only what runs where the pane
  cannot say, and it is documented there as unable to settle either of the two cases
  that produced this bug. These
  formats are internal to tools that ship weekly, so **an unknown record type,
  block or shape is warned about and ignored, never thrown** — a mapper that
  throws loses the user's session, and the terminal is a complete fallback for
  anything dropped. Two things the tailer must keep: it reads forward from a byte
  offset (never re-reads the file) and its carry is **bytes**, because a flush
  lands mid-line and mid-glyph routinely. `fs.watch` is only the fast path; the 1s
  stat poll is what makes it work on filesystems where the watcher silently
  delivers nothing. Its reads are serialised through one promise chain rather than
  dropped while another is in flight, which is what lets `catchUp` promise "read to
  the end" rather than "a read happened" — see the Codex `PermissionRequest` entry
  for its one caller. Fixtures in each `fixtures/` directory are captured from a
  real session with the version recorded — **CI must never run a live agent**
  (real credentials, money per run). Verified while capturing them: Claude Code's
  `thinking` blocks reach disk with an **empty** `thinking` string and Codex's
  `reasoning` carries only `encrypted_content`, so the event is presence-only for
  both.

- **Two providers, one `switch`, and no `Provider` interface.** `providers/` has
  one directory each (`claude-code/`, `codex/`) plus what they genuinely share —
  `tail.ts`, `cap.ts`, `permission.ts` (the permission policy entry below) and
  `trust.ts` (the folder-trust entry below). `machine/sessions.ts` holds the argv,
  the resume and the trust locations per provider and `machine/conversations.ts`
  picks the mapper; that is the whole seam, and report
  §4 chose it over an abstraction on purpose. Adding a third provider is a third
  directory, not a refactor. Codex specifics worth not rediscovering: it writes
  **nothing at all** until the first user message (hence the nullable
  `provider_session_id`), `event_msg/*` records win over the `response_item/*`
  they duplicate, `agent_message.phase` distinguishes commentary from the final
  answer in the compatibility mapper, and there is no `isError` — success has
  to be _stated_ (`Process exited with code 0` / `Exit code: 0`). The browser's
  provider seam is `web/src/providers.ts`: the New session picker and list-row
  tag read it, so nothing else in the web app spells a provider id or name. Its ids are literals mirroring `DEFAULT_PROVIDER` and `CODEX`,
  because `@tether/shared` emits types and no JavaScript; the create route's
  `enum` is the enforcement, so drift is a 400 rather than a session running the
  wrong agent under the right name.

- **`hooks.json` is a file tether does not own, and the trust gate is not
  tether's to bypass.** `providers/codex/hooks.ts` writes one entry, **appended**
  (Codex keys its trust hashes by group index, so inserting re-prompts the user
  for hooks they already trusted), after backing the file up, and refuses outright
  rather than rewriting a `hooks.json` whose shape it does not recognise.
  `--dangerously-bypass-hook-trust` must appear nowhere — not in code, not in
  docs, not as a fallback; that is a captain's decision, not a preference. The
  hook buys the live `waiting` badge in the session list; the prompt itself is
  always answered in the terminal. `busy` and `idle` come from the rollout, so
  **declining is a supported configuration** and nothing may
  warn, retry or nag about it. Explaining the prompt before it appears binds the
  UI as much as the CLI: `cli.ts`'s `codexHookExplanation` and `app.tsx`'s
  `CodexHookNote` are the only two places that say it, and the second says it
  only while Codex is the selected provider in the New session sheet. Neither may
  grow into a banner on the session list or a warning beside a Codex session
  running happily without the hook. Installing stays a CLI command on purpose —
  it writes to a file tether does not own.
  **The hooks.json `timeout` tether writes is a constant, and must stay one.**
  Claude Code's settings entry is _reconciled_ to the current hold; doing that here
  would re-hash a trusted entry and put a security prompt in front of the user
  every time an operator changed `TETHER_PERMISSION_TIMEOUT`. So
  `PERMISSION_TIMEOUT_SECONDS` and the shim's abort are fixed, the hold is clamped
  under them by `MAX_HOLD_MS` in `#holdFor`, and `reconcileProviderHooks` does not
  touch `hooks.json` at all. Verified: moving the hold from 20s to 180s leaves the
  file byte-identical. The price is that a Codex installation can go stale — no
  upgrade path rewrites it — so the invariant both providers are held to is stated
  once in `providers/permission.ts`: **tether may hold a turn only while the
  provider's own on-disk hook configuration carries the timeout that hold is sized
  against.** Claude Code satisfies it by reconciling the file; Codex satisfies it
  by reading it (`installedPermissionTimeout`, gated in `#codexCeiling` — a gate
  and not a clamp, because an older entry says `timeout: 3` and 3s minus
  `KILL_MARGIN_MS` is negative). A provider that can do neither may not hold. The
  only place a stale installation is ever mentioned to the user is
  `tether codex-hook status`, which the user typed; `not installed` stays neutral.
- **Folder trust is read from each agent's own config, and the two schemes
  differ in ways an exact-path check gets wrong.** `providers/trust.ts` holds the
  tri-state, one `writeAtomically`, and the git resolution; each provider's
  `trust.ts` holds its own file; the switch is `PROVIDER_TRUST` beside the other
  two in `machine/sessions.ts`. Every rule was established by running the
  installed CLIs under a scratch `HOME` and reading the pane, and the surprising
  ones are why the code is not two `readFile`s: Claude Code
  (`$CLAUDE_CONFIG_DIR/.claude.json` else `~/.claude.json`,
  `projects["<dir>"].hasTrustDialogAccepted`) accepts a directory, **any path
  ancestor**, or the main repo root — but _not_ the repo root's ancestors — while
  Codex (`$CODEX_HOME/config.toml`, `[projects."<dir>"] trust_level`) matches
  **only the main repository root, exactly**, with no ancestor walk at all. Both
  resolve a linked worktree back to the repository it belongs to, so the git
  helper is `dirname(--git-common-dir)` and **never `--show-toplevel`**, which
  would key an entry the agent then ignores — in the shape this product is
  actually used in. `unknown` is a real answer and never a guess: an absent file
  is `untrusted` (nothing is trusted, which is determinable), a file that exists
  and cannot be understood is `unknown`, and the sheet then says tether cannot
  tell and offers nothing — because the file it would write is the one it just
  failed to read. Declining writes **nothing at all**, and a write happens only
  for a create request carrying `trustFolder: true`. Unlike the hook it is not
  best-effort: a refused config fails the create with `trust_not_recorded`,
  having started nothing, because a silent failure would drop the user into the
  prompt they had just answered to avoid. Codex's is the one place tether writes
  `config.toml` — the file holding its hook trust hashes — so the line scanner
  there **refuses rather than guesses** on any TOML it cannot reason about
  (multi-line strings, a bare `[projects]` table, a top-level `projects.…` dotted
  key): appending a second table for a key the reader missed is a duplicate-key
  error, i.e. tether breaking Codex while recording consent. One `scan` serves
  the read and the write so the two can never disagree. The wording lives in
  `web/src/providers.ts` (`trustAsk`) with the rest of the sentences that name an
  agent, and the ticked box is cleared whenever the directory or the provider
  changes — a tick must never outlive the question it was given for.
- **The permission _policy_ is shared and the _plumbing_ is not.**
  `providers/permission.ts` holds what both providers must be held to identically:
  the three nested timeouts, `permissionTimeoutMs`, the `0600` secret and the
  endpoint file both shims read (still named `claude-hook.*` on disk, historically),
  and `HookSignal`. It is not a `Provider` interface — there is no behaviour in it
  either provider implements — it is the place a second hold length or a second
  fallback rule cannot be invented. Installing, where the hook goes, and what it
  may say when it runs stay in each provider's own `hooks.ts`.

- **The two providers' hooks share a purpose and almost no code, deliberately.**
  `providers/claude-code/hooks.ts` installs into `<cwd>/.claude/settings.local.json`
  — a file in the **user's own repo** — per project at spawn, with no trust gate.
  Codex's is one global trust-gated entry, installed once by a CLI command.
  Report §4 chose the seam; do not abstract over two examples beyond the policy
  that is genuinely one thing (`providers/permission.ts`, above). Both shims POST
  to `/internal/hook`, because a hook answers a permission prompt on **stdout** and
  answering needs request/response, which a log file could never become — but only
  Claude Code's POSTs on _every_ tool call; Codex's log carries the other four
  events and the POST is reserved for `PermissionRequest`.
- **The `PreToolUse` shim's stdout is a security boundary, and the first-party
  browser now deliberately says nothing on it.** The terminal-only UI opens no
  `conv` watcher, so `Conversations.#holdFor` returns 0 and `/internal/hook`
  answers without a decision; Claude Code or Codex then applies its own policy
  and draws any prompt in the terminal. This is not a degraded fallback — it is
  the product path. The compatibility conversation API retains the hold machinery,
  so its old safety rules stay: `auto`, `dontAsk` and `bypassPermissions` are
  never held; read-only burst tools are skipped; the server/shim/provider timeouts
  remain nested; caller close settles once; and every failure says neither allow
  nor deny. Do not add a terminal viewer to `live.watching` or synthesize a
  browser approval from terminal bytes: either would put Remote Control Agent in front of the
  provider's permission engine again.
- **The hook secret is a `0600` file read at hook execution time, and the
  settings file gets only a path.** `settings.local.json` lives in the user's
  repository, so a token in it is one `git add` from being published (report
  §7); the same goes for the endpoint URL, which is rewritten after every
  `listen` so a session spawned under one `tether serve` reaches the next one
  on a new port. The secret is per installation — Claude Code names its own
  session and tether cannot know it at install time — and **per-session
  authorisation lives at the endpoint instead**: loopback checked against the
  real peer address (never `request.ip`, which `trustProxy` lets a header
  forge), **and not proxied**, constant-time secret compare, then a payload
  accepted only for a live registry row. The second half of that first gate is
  what keeps it a gate at all under Funnel, which proxies from `127.0.0.1` and
  so gives every internet request a loopback peer: `isProxied` refuses anything
  carrying `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` or
  `Tailscale-Funnel-Request`, which a real Funnel always sets and the shim —
  POSTing to `127.0.0.1` — never does. A presence test can only over-refuse,
  never over-admit, which is the direction this boundary must fail in. A hook whose `session_id` no row holds is bound by
  `Conversations.bindProviderSession` — which is how the _first_ tool call of a
  session is not lost, and how the first after a `/resume` is not either. The
  payload's `cwd` is **not** consulted: a `cwd` can only ever say "one of
  these", since an agent run by hand in that directory posts the same one and
  two tether sessions in one directory post it identically. The join is the
  pane, whose `readSessionId` states which session it is running; no pane
  naming it means nothing is bound, which is what keeps a foreign transcript —
  a `resume` that hands back somebody else's conversation — out of a row.
- **`~/.claude/sessions/<pid>.json` outlives its process, so both guards in
  `providers/claude-code/status.ts` are mandatory.** It is deleted on a graceful
  exit and left behind by a `SIGKILL` or a reboot, and pids are reused — so
  `kill(pid, 0)` is not enough on its own. `procStart` is the identity check:
  Linux records `/proc/<pid>/stat` **field 22** (`starttime`), found from the
  **last** `") "` because field 2 is a comm that can contain spaces and `)`;
  macOS records the UTC, C-locale output of `ps -o lstart=`. Both are verified
  against Claude Code 2.1.220, and `processStart` is the one reader. Anything
  unreadable or unverifiable is `undefined` — "tether cannot say"
  — never a guess: a session wrongly reported `waiting` is a phone notification
  that should not have fired. The file also carries `waitingFor`, which nothing
  reads yet. `undefined` is the _only_ thing the poller may not announce: a
  status it really read stands even over a `waiting` a `Notification` hook just
  set, because the file publishes `waiting` itself while a dialog is up (report
  §4e) and a `busy` after one is the user having answered — teach the poller to
  protect `waiting` from `busy` and the badge sticks forever instead. That makes
  a readable status file a _live announcer_, which is the trap in the poller's
  own test: it is the one test that runs with the poller on (every other passes
  `statusPollMs: 0`), and any moment where the file is readable before a
  "nothing was announced" count is a race with the tick timer that the truthful
  announcement wins. Write no status file until after the count.

- **There are two layouts and `app.tsx` picks between them.** Past `WIDE`
  (900px) it renders `.workspace`: the session list as a rail beside the open
  session. A media query cannot do that, because it cannot mount a component,
  which is why `useWide` exists — and it uses `matchMedia`, which carries no
  secure-context gate. There is still no router, but the open row writes
  `?session=<id>` with `replaceState`; authentication restores that row before it
  reveals the app, so reload neither flashes the list nor makes the user find a
  running agent again. Back and sign-out remove it, and a stale id degrades to the
  list. Crossing the breakpoint remounts the session screen, so
  it costs one tmux replay; that is acceptable
  because a phone never crosses it (390×844 rotated is still 844) and nothing
  is lost, only re-derived. Which element is the `<main>` follows the shape, so
  neither layout has two or none: on a phone the list is the `<main>` and the
  open session replaces it, while in the rail shape the **right** pane is the
  `<main>` — the open session, or `.blank` when nothing is open — and the list
  becomes a complementary landmark named "Sessions" (`rail` is the only thing
  that prop decides). The rail's border keys off `.rail`, never off `main`: a
  border that follows the landmark moves the day the landmark does. The desktop
  rail may collapse, but it remains mounted in a zero-width grid track with
  `visibility: hidden`/`inert`: its poll, state and scroll position survive while
  its whole subtree leaves hit testing and the accessibility tree. The session
  header owns the restore control because it is the one surface still visible;
  localStorage persistence is feature-detected and failure is harmless. No open
  session means no collapse control, so the blank workspace can never hide the
  only way to choose one.
- **The desktop rail keeps the session list mounted beside the open session, so
  its 5s poll no longer stops when a session is opened.** On a phone `Sessions`
  unmounts and `clearInterval` runs; past `WIDE` it does not, so every tick is a
  `GET /api/sessions` for as long as a session is watched — `tmux list-sessions`
  via `reconcileWithTmux`, `tmux list-panes` via `statesFor`, and a
  `/proc/<pid>/stat` plus a status-file read per live session. That is the
  deliberate price of a **live** rail: on the hardware tether runs on it is
  negligible, and a stale list beside a running session is worse than the cost.
  It is desktop-only — the narrow branch is unchanged. Do not add
  visibility-pause machinery, tab-focus gating or a longer interval while a
  session is open; no pause mechanism is wanted here.
- **The session bar's height may not follow its own text.** Connecting, retrying
  and failure words share one `nowrap` row; mobile Back is a chevron and the title
  ellipsizes. A wrapping status resizes xterm, which resizes the tmux pane and
  redraws the provider TUI into every viewer's scrollback.
- **The server logs at `warn`, and a failure string may only say what its own
  condition proves.** Two halves of one fault, and the second is the family to
  watch for. `buildServer` was built with `logger: false`, so every `app.log.warn`
  in the server — a terminal attach that threw most of all — was written to
  nothing: the user got a badge and the operator got silence. It is now
  `{ level: warn, stream: process.stderr }`, which is neither `false` nor `true`:
  Fastify logs every request and reply at `info` and the browser polls the session
  list every 5s, so `true` is chatter that gets switched off again, taking the
  failures with it. `TETHER_LOG_LEVEL` widens it and is validated against a list
  rather than passed through, since pino throws on a level it does not know — and
  a value that fails that list says so on stderr, because a knob whose fallback
  is silent reads as a knob that does nothing, which is the fault this half
  exists to end. It is documented where an operator will look for it:
  `docs/security.md` and `tether serve --help`.
  The other half: `term-socket.ts` closed **every** failed attach as
  `CLOSE_NO_SESSION`, which the browser renders as "Session not found" — so a
  node-pty that would not spawn told a captain his work was gone, beside an
  agent badge reading _Idle_. `attachClose` there is now the one place that
  decides, off the registry row (`getSessionByTmuxName`, after one
  `reconcileWithTmux` so a session that ended a moment ago is already marked):
  no row is `CLOSE_NO_SESSION`, `deadAt` is `CLOSE_SESSION_ENDED`, and a live
  row whose terminal went is `CLOSE_ATTACH_FAILED` — which says a terminal could
  not be opened and **nothing about why**, because the why is in the log the
  first half turned on. **Both ways a terminal is lost ask it**: the attach that
  never opened, and the attach that exits mid-life. The second used to send
  `CLOSE_SESSION_ENDED` outright, and a PTY exits for things that are not the
  session ending — `Ctrl-B d` in the web terminal (`tether.conf` unbinds no
  prefix and `keys.ts` maps `\x02` to `C-b`) and any `tmux detach-client` — so a
  live session told every viewer it had ended and left the terminal settled on a dead attach. A mid-life _frame_ failure is still the one close with no code at all,
  which is what makes the client reconnect instead of settling.
  `web/src/status.ts` owns the browser's `Status` union and `STATUS_TEXT`;
  the terminal-only header prints that one channel's fact. Only `gone` may say
  “not found”; `failed` says only that the terminal could not be opened.
- **Fastify's schema defaults silently repair a bad body** (`removeAdditional` and
  `coerceTypes` are on): `additionalProperties: false` strips instead of rejecting, and
  `{"password": 123}` arrives as `"123"`. `buildServer` turns both off. Do not remove that
  `ajv.customOptions` block, and do not assume stock Fastify behaviour when reading the tests.
- **`e2e/` is the terminal product path, not a transcript simulation.** The
  phone spec opens one production tmux/PTy/WebSocket terminal, creates 120 lines,
  proves **Pg↑** changes the rendered xterm screen and **End** returns to line 120,
  then reloads to prove tmux reconstruction. It also covers terminal-first resume,
  restore retry and New session reachability at 360×340. The desktop spec measures
  the rail beside that same terminal. Both use `e2e/stub-agent.ts` under a scratch
  `HOME`, state directory and tmux socket; CI never runs a paid agent. There are no
  retries. Build `web/dist` before running Playwright, because `tether serve` reads
  the built app. `e2e/ui.ts` owns the 44px/no-document-scroll definition of
  `reachable`, and screenshots are namespaced by spec.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
