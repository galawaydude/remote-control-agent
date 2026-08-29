# Security

## Access and security

**Treat Remote Control Agent access as shell access.** One shared password authorizes every
session and file under the allowed roots. Set it locally before serving:

```sh
rcagent set-password
rcagent serve
```

Security defaults:

- The server binds `127.0.0.1` unless `--host` is supplied.
- An off-loopback `--host` and every `--funnel` refuse to start without a password.
- `--allowed-host` controls accepted `Host` headers.
- `--trusted-proxy` controls which proxies may supply `X-Forwarded-*` headers.
- Session directories must resolve inside your home directory. Widen this with a
  colon-separated list:

  ```sh
  RCAGENT_ALLOWED_ROOTS=/srv/code:/mnt/work rcagent serve
  ```

Remote Control Agent does not terminate TLS. Use Funnel, SSH, a private tailnet
or a reverse proxy. New installations store private state under
`~/.local/state/remote-control-agent`; upgrades keep using the former
`~/.local/state/tether` directory so sessions and provider hooks survive. Use
`$XDG_STATE_HOME` or `$RCAGENT_STATE_DIR` to choose another location.

Logs go to stderr at `warn`. Use `RCAGENT_LOG_LEVEL=info rcagent serve` for
request logs.

## Reaching it from your phone

### Tailscale Funnel

Funnel is the default because the **host alone** installs Tailscale. Every viewer
uses a normal browser and the Remote Control Agent password—no Tailscale app, account, VPN or
extension.

**Funnel makes Remote Control Agent's login page public.** The URL is not a secret; anyone with
the password has shell-level access. The installer checks the password and port,
shows the exact Funnel command, and asks before publishing.

The installer configures Funnel. Once it is enabled, the server command is:

```sh
rcagent serve --funnel
```

`--funnel` derives the Tailscale hostname, keeps Remote Control Agent on loopback, allows that
hostname, and trusts only the loopback Funnel proxy. Disable and diagnose it with:

```sh
sudo tailscale funnel --bg off
rcagent access status
```

The installer can also add a launchd/systemd user service. Funnel itself remains
configured until you turn it off. A new Funnel hostname can take several minutes
to become reachable.

#### Why Funnel is the default

| Option                                                                                                                                                 | Why it is not the default                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) | Cloudflare labels them development/testing only; hostnames are temporary. |
| [Cloudflare Tunnel + Access](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/)                      | Requires a Cloudflare account, managed DNS and `cloudflared`.             |
| [ngrok](https://ngrok.com/docs/gateway/agent-cli-quickstart/)                                                                                          | Requires a host account, agent and token.                                 |
| Caddy or another proxy                                                                                                                                 | Best when you already manage a domain, TLS and ingress.                   |

All remain supported through `--allowed-host` and `--trusted-proxy`.

### Private tailnet

Safer when every viewer is one of your devices, but each viewer must install and
join Tailscale:

```sh
tailscale ip -4
tailscale status --json | grep '"DNSName"'
rcagent serve --host <tailscale-ip> --allowed-host <tailscale-name>
```

Open `http://<tailscale-name>:8787` from a device in the tailnet. Bind the
Tailscale IP, not `0.0.0.0`.

### SSH tunnel

```sh
ssh -N -L 8787:127.0.0.1:8787 you@box
```

Open `http://localhost:8787`. Remote Control Agent stays on loopback.

### Reverse proxy

Example Caddy configuration:

```
rcagent.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

```sh
rcagent serve --allowed-host rcagent.example.com --trusted-proxy 127.0.0.1
```

Keep Remote Control Agent on loopback and add authentication at the proxy when possible.

## Known risks

**Provider metadata is built on file formats that are not public APIs.** Claude
Code and Codex ship frequently and can change their session, status and transcript
records. Remote Control Agent uses those files only to label state and resume the exact saved
provider session; the working interface is the tmux terminal and does not parse
provider output. Unknown records are warned about and ignored rather than taking
the terminal down.

**Folder trust is the same bet, and the one place Remote Control Agent takes it while
_writing_.** Where each agent records a trusted directory is its own business, and
`~/.claude.json` and `~/.codex/config.toml` can change shape in any release. Both
were established against Claude Code 2.1.220 and codex-cli 0.145.0. The
consequences are bounded on purpose: a file Remote Control Agent cannot make sense of gets no
checkbox and no write, a write it will not make refuses the session outright
rather than starting one on a promise it did not keep, and an existing file is
copied into Remote Control Agent's state directory before it is touched. What a stale reader
costs you is the trust question appearing in the terminal, where it remains
answerable.

**The terminal is the interface.** It is the provider's real TUI over tmux and
requires no provider-output mapper. Provider permission rules and dialogs remain
authoritative; Remote Control Agent does not render a second approval surface.
