# User guide

Remote Control Agent gives each coding-agent session one browser interface: its real terminal. The process runs in tmux on the host, so closing the browser, locking a phone or losing the network does not stop it.

## Start a session

Sign in and choose **New session**.

- **Agent** selects Claude Code or Codex. This only decides which CLI starts; the session interface is the same terminal for both.
- **Working directory** is resolved and confined to the allowed roots.
- **Title** is optional and defaults to the directory name.
- If the agent has not trusted the folder, the sheet can record that trust before starting. Declining leaves the agent's own prompt to answer in the terminal.

The browser opens directly into the live terminal.

## Use the terminal

Tap the terminal and type as you would on the host. Remote Control Agent sends terminal bytes through the session's attached PTY; it does not reinterpret prompts, commands or provider output.

The phone accessory bar provides:

- Escape and Tab
- Arrow keys
- Control-C
- **Pg↑** to move one screen into earlier terminal output
- **End** to jump back to the latest output

Use **Pg↑** repeatedly for deeper history. tmux keeps up to 100,000 lines and a browser attach replays the latest 5,000. Reloading the page re-derives the terminal from tmux rather than relying on browser memory.

Agent permission dialogs, slash-command pickers, login prompts and trust questions all appear here exactly as the agent draws them. Answer them in the terminal; Remote Control Agent does not place a second approval interface in front of the provider's own rules.

## Sessions

**Back** returns to the session list without stopping the process. Live rows can be killed; dead rows can be resumed when the provider has supplied a saved-session identity.

Resume starts the provider's exact saved session under the same Remote Control Agent row. A dead row with no provider identity cannot be resumed, because silently starting a fresh agent would misrepresent lost work as restored work.

**Remove** hides a dead row permanently from Remote Control Agent. It does not delete the provider transcript or attachment files already on disk.

At desktop widths the session list stays mounted as a rail beside the terminal. It can collapse without losing its poll, selection or scroll position.

## Providers

The terminal surface is provider-agnostic, but starting and resuming a process cannot be: each CLI has its own command, session identity and folder-trust file.

### Claude Code

Remote Control Agent installs its project-local hook when a session starts. With the terminal-only UI the hook never holds a tool call for browser approval; Claude Code's own permission mode and prompts remain authoritative.

### Codex

Codex runs without hook setup. The optional global hook improves live session-state reporting:

```sh
rcagent codex-hook install
rcagent codex-hook status
rcagent codex-hook remove
```

Codex asks you to trust that hook once. Declining is supported; the terminal continues to work.

## Remote access

A public installation prints a Funnel URL. A viewer needs only a browser and the Remote Control Agent password—no Tailscale account or app.

Check it from the host with:

```sh
rcagent access status
```

The command reports the Funnel mapping, protected local listener and public HTTPS result independently. See [Security and remote access](security.md) before publishing a terminal.
