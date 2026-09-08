# Contributing

## Development

Requires the Node version in [`.nvmrc`](.nvmrc) (`nvm use`), **tmux 3.7 or
newer**, and a **C++ toolchain** (`build-essential` and `python3` on Debian or
Ubuntu). tmux, because the driver's tests drive a real server on a private
socket, not a mock, and older tmux crashes on the `window-size manual` that
`tether.conf` sets (so does Remote Control Agent; 3.7 is a hard floor, not just a test
one). A toolchain, because `node-pty` ships no Linux prebuild and is compiled
during install. [`install.sh`](install.sh) sets up tmux and the toolchain and
checks Node — it does not install Node — and `./install.sh` inside a checkout
installs that checkout rather than cloning another.

```sh
npm ci        # installs all workspaces; builds shared/, server/ (the CLI), web/ and node-pty
npm test      # node:test across every package
npm run build # server (tsc) and web (vite) — rerun after editing either
```

`npm run rcagent -- <args>` runs the CLI from the working tree without installing
it.

`rcagent serve` serves the built app out of `web/dist`, so after editing `web/`
either rebuild it or run Vite's dev server alongside, which proxies `/api` and
the terminal WebSocket to an `rcagent serve` on the default port:

```sh
npm run dev -w @tether/web   # http://localhost:5173, hot reload, real server behind it
```

`node-pty`'s install script is approved in the root `package.json` under
`allowScripts`, because npm 12 blocks dependency install scripts by default. If
`rcagent serve` reports that the native module is missing, install the toolchain
and re-run `npm ci`; the message says so too. The root `postinstall` then makes
`node-pty`'s `spawn-helper` executable, which its macOS prebuild ships without —
macOS starts every process through that helper, so without the bit every
terminal attach fails with `posix_spawnp failed` and nothing else does.

Other checks, all of which CI runs on every pull request:

```sh
npm run typecheck    # tsc --noEmit, per package
npm run lint         # eslint
npm run format:check # prettier --check   (npm run format to fix)
npm run check:pty    # a terminal really starts here: the helper bit, and a live PTY
npm audit --omit=dev --audit-level=high

shellcheck install.sh        # the installer is the only shell in the repo
bash install.sh --self-test  # versions, PATH, package plans, services, Funnel probes, checkout moves

npx playwright install chromium   # once; npm 12 blocks playwright's own postinstall
npm run test:e2e                  # the end-to-end specs
```

### Cutting a release

The install line installs the latest release tag, so **merging to `main` does not
ship anything.** Dispatch the release workflow from `main` with the next
`vX.Y.Z` version:

```sh
gh workflow run release.yml --ref main -f version=v0.4.0
gh run watch
```

The [Release workflow](.github/workflows/release.yml) reruns the complete CI
suite first. It then verifies the version is newer, creates an annotated tag on
the exact commit that passed, and publishes the GitHub release with generated
notes. A failed validation creates no tag, so the installer cannot see an
unvalidated release.

`install.sh` picks the highest `vX.Y.Z` tag out of `git ls-remote --tags`, so the
**tag** decides what gets installed. Prerelease tags and branches are ignored by
that query and reachable only as `RCAGENT_VERSION` (`TETHER_VERSION` remains an
alias). This also works for an
existing installation:

```sh
url=https://raw.githubusercontent.com/galawaydude/remote-control-agent/main/install.sh
curl -fsSL $url | RCAGENT_VERSION=v0.3.0 bash   # an older release
curl -fsSL $url | RCAGENT_VERSION=main   bash   # an unreleased change, to test it
```

The checkout stays shallow either way, so moving between refs stays as fast as
the first clone.

`install.sh` itself is fetched from `main` rather than from the tag, as
Homebrew's is: it is the thing that has to know how to find the current release,
so pinning it would mean editing the README's install line every time. Which
means a change to `install.sh` is live at merge, while everything it installs is
live at tag.

### The HTTP and WebSocket API

Sessions are addressed as `(machineId, sessionId)` from day one, and `machineId`
is always `local`. That one path segment is what makes a second machine a later
split rather than a rewrite.

```
GET    /api/machines/local/sessions            every listed session, live and dead, with each live one's state
GET    /api/machines/local/folder-trust?cwd=…&provider=…
                                               whether that agent already trusts that directory,
                                               and which directory the answer is about
POST   /api/machines/local/sessions            {"cwd": "…", "title"?: "…", "provider"?: "…",
                                                "trustFolder"?: true} — the last one is the only
                                                thing that ever records a folder as trusted
GET    /api/machines/local/sessions/:id
POST   /api/machines/local/sessions/:id/resume restarts the exact saved provider session
POST   /api/machines/local/sessions/:id/forget removes a dead row from the app; transcript untouched
DELETE /api/machines/local/sessions/:id        kills the tmux session and marks the row dead
POST   /api/machines/local/sessions/:id/permission-mode
                                               {"mode": "default"|"acceptEdits"|"plan"|"auto"} — Claude
                                               Code only; answers with the mode read back off the pane
GET    /api/sessions/:id/conversation?before=… one bounded history page, with absolute sequence numbers
POST   /api/sessions/:id/images                stores one private pasted image (raw supported image bytes)
GET    /api/sessions/:id/images/:file          serves it inline to an authenticated viewer
POST   /api/sessions/:id/permission            {"callId": "…", "decision": "allow" | "deny"}
WS     /api/sessions/:id/conv?since=<seq>      conversation events after `seq`, the last one you hold
WS     /api/sessions/:name/term                terminal bytes, both ways
```

The browser does not consume the conversation, image or permission routes; its
session interface is only the terminal WebSocket. Those endpoints and transcript mappers remain as a compatibility API. Separate
bounded provider metadata reads identify and resume saved sessions without opening
a transcript tail. New first-party UI must not subscribe to `conv`: doing so
would reintroduce provider-format coupling and make hooks eligible to hold a tool
call ahead of the provider's own terminal prompt.

### The end-to-end specs

`e2e/` has two Playwright specs and nine scenarios. Eight run at a phone
viewport; the desktop rail gets the laptop project.

- **`session.spec.ts`** signs in, starts a real tmux-backed stub session and
  proves the session opens directly as a terminal with no transcript pane or
  view toggle. It produces more than a screen of output, drives **Pg↑** and
  **End**, reloads and proves tmux reconstructs the terminal. It also covers a
  transient restore failure, terminal-first resume, an agent ending while its
  phone terminal is open, terminal controls at keyboard-up height, and the New
  session sheet at four small viewports including 360×340.
- **`desktop.spec.ts`** measures the mounted session rail beside the terminal,
  collapses and reloads it, restores it with the selected row intact, and checks
  the mobile shape after crossing back below 900px.

Both run against `e2e/stub-agent.ts`, put on `PATH` as `claude` and `codex`.
The stub prints and accepts terminal input, emits a long output burst for the
scrollback check, and writes enough provider metadata to exercise status and
resume. Sessions still start through the production CLI, HTTP routes, WebSocket,
PTY and tmux code.

**CI never runs a real agent**: that would need credentials and cost money.
Everything the specs touch (`HOME`, state, tmux socket and session root) is in a
scratch directory selected by `playwright.config.ts`. Retries stay disabled.

### Layout

| Package   | What it is                                                                    |
| --------- | ----------------------------------------------------------------------------- |
| `shared/` | Types both sides import: `Session`, `ConversationEvent`, the WebSocket frames |
| `server/` | The single Node process: HTTP, WebSockets, tmux, provider adapters            |
| `web/`    | The browser app                                                               |

Inside `server/src/`, `web/` is the HTTP and WebSocket layer and `machine/`
drives tmux. `machine/` and `providers/` never import from `web/` — that one rule
is what makes the eventual remote-agent split a split rather than a rewrite.

`providers/` holds one directory per provider — `claude-code/` and `codex/` —
plus the four files they genuinely share (`tail.ts`, which follows an
append-only file, `cap.ts`, which bounds what a card may carry, `permission.ts`,
which is the one place the permission timeouts, the hook secret and the signals
both hooks speak are decided, and `trust.ts`, which holds the folder-trust
tri-state and nothing about either agent's own file). There is no `Provider`
interface, registry or plugin loader: adding the second provider cost two
directories and one `switch`, which is smaller than the abstraction that would
have been designed to avoid it and cannot be wrong about a provider nobody has
built yet.

Neither provider's tests ever run a real agent — that would need real credentials
and cost money per CI run. Both are driven from captured fixtures, with the
provider version recorded next to them.

`shared/` is types only and emits declarations, no JavaScript. Import from it
with `import type` — `verbatimModuleSyntax` enforces this.
