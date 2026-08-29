/**
 * The whole shell: log in, list sessions, open one. No router — there are three
 * screens and one of them is a modal. The one URL state that earns its keep is
 * `?session=<id>`: a browser refresh restores the open session instead of
 * dropping a captain back at the list while their agent keeps running.
 *
 * There are two shapes, not one with a media query bolted on. On a phone the
 * list and the open session are the same screen at different times. Past
 * `WIDE`, they are side by side — the list is a rail you switch sessions from
 * without going back — and a media query cannot do that, because it cannot
 * mount a component. Everything else about the two shapes is CSS.
 */

import type { Session, SessionState, TrustReport } from '@tether/shared';
import { Fragment } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import * as api from './api.ts';
import { ApiError } from './api.ts';

import {
  CODEX,
  DEFAULT_PROVIDER,
  PROVIDERS,
  providerLabel,
  trustAsk,
  unresumableNote,
} from './providers.ts';
import { crumbs, groupSessions } from './sessions.ts';
import { TerminalView } from './terminal.tsx';
import { STATUS_TEXT, type Status } from './status.ts';

/** How often the list refreshes. tmux reconciliation happens server-side per read. */
const POLL_MS = 5000;

/**
 * Where a rail beside the session starts paying: below this, 340px of list plus
 * a terminal is two cramped columns rather than one good one. It matches the
 * last block of `style.css`, which is where the rest of the desktop shape lives.
 */
const WIDE = '(min-width: 900px)';
const SESSION_QUERY = 'session';
const RAIL_PREFERENCE = 'tether.sessions-collapsed';

function savedRailPreference(): boolean {
  try {
    return localStorage.getItem(RAIL_PREFERENCE) === '1';
  } catch {
    return false;
  }
}

function saveRailPreference(collapsed: boolean): void {
  try {
    localStorage.setItem(RAIL_PREFERENCE, collapsed ? '1' : '0');
  } catch {
    // Private browsing policies can refuse storage. Collapse still works for
    // this mount; persistence is convenience, never a requirement.
  }
}

/** One stable address for the open session, without introducing a router. */
function rememberSession(id: string | null): void {
  const url = new URL(location.href);
  if (id === null) url.searchParams.delete(SESSION_QUERY);
  else url.searchParams.set(SESSION_QUERY, id);
  history.replaceState(null, '', url);
}

async function restoreSession(): Promise<Session | null> {
  const id = new URL(location.href).searchParams.get(SESSION_QUERY);
  if (id === null) return null;
  try {
    return await api.getSession(id);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    // A stale bookmark is the session list, not a reload loop against a 404.
    rememberSession(null);
    return null;
  }
}

/**
 * `matchMedia`, not a resize listener: it fires only on the crossing, and it
 * carries no secure-context gate — which the browser app may not use, since
 * every device but the one running tether loads it over plain HTTP.
 */
function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return wide;
}

/** Provider state shown on live rows in the session list. */
export const STATE_TEXT: Record<SessionState, string> = {
  busy: 'Working',
  idle: 'Idle',
  waiting: 'Waiting for you',
};

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
}

/** The login lockout is a quarter of an hour; "900 seconds" is not how anyone reads that. */
function waitText(seconds: number): string {
  return seconds >= 90 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`;
}

export function App() {
  // `null` while the cookie is being checked: rendering the login form first and
  // replacing it a moment later is a flash of the wrong screen on every load.
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [open, setOpen] = useState<Session | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(savedRailPreference);
  const wide = useWide();
  const railClosed = wide && open !== null && railCollapsed;
  const setRail = useCallback((collapsed: boolean) => {
    setRailCollapsed(collapsed);
    saveRailPreference(collapsed);
  }, []);
  const openSession = useCallback((session: Session) => {
    setOpen(session);
    rememberSession(session.id);
  }, []);
  const closeSession = useCallback(() => {
    setOpen(null);
    rememberSession(null);
  }, []);
  const signedOut = useCallback(() => {
    closeSession();
    setAuthenticated(false);
  }, [closeSession]);
  const removedSession = useCallback(
    (id: string) => {
      if (open?.id === id) closeSession();
    },
    [closeSession, open?.id],
  );
  const loadSelected = useCallback(async () => {
    try {
      setOpen(await restoreSession());
      setRestoreError(null);
      setAuthenticated(true);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) setAuthenticated(false);
      else {
        setRestoreError(messageOf(failure));
        setAuthenticated(true);
      }
    }
  }, []);

  useEffect(() => {
    let live = true;
    api.checkSession().then(
      () => {
        if (live) void loadSelected();
      },
      () => {
        if (live) setAuthenticated(false);
      },
    );
    return () => {
      live = false;
    };
  }, [loadSelected]);

  if (authenticated === null) return <p class="centre muted">Loading Remote Control Agent…</p>;
  if (!authenticated) {
    return <Login onDone={() => void loadSelected()} />;
  }
  if (restoreError !== null) {
    return (
      <main class="centre">
        <div class="card">
          <p class="error" role="alert">
            {restoreError}
          </p>
          <button class="primary" onClick={() => void loadSelected()}>
            Retry
          </button>
        </div>
      </main>
    );
  }
  const list = (
    <Sessions
      onOpen={openSession}
      onRemoved={removedSession}
      onSignedOut={signedOut}
      rail={wide}
      collapsed={railClosed}
      {...(open === null ? {} : { onCollapse: () => setRail(true) })}
      openId={wide ? (open?.id ?? null) : null}
    />
  );
  const session =
    open === null ? null : (
      <SessionScreen
        // A dead row resumed under the same id needs fresh sockets just as much
        // as switching rows does. The provider process is new even though the
        // saved provider identity deliberately is not.
        key={`${open.id}:${open.deadAt ?? 'live'}`}
        session={open}
        onBack={closeSession}
        onSignedOut={signedOut}
        onResumed={openSession}
        sessionsCollapsed={railClosed}
        onShowSessions={() => setRail(false)}
      />
    );

  if (!wide) return session ?? list;
  return (
    <div class={`workspace${railClosed ? ' workspace-rail-closed' : ''}`}>
      {list}
      {session ?? (
        // The `<main>` of this shape when nothing is open: the right-hand pane is
        // the primary content either way, and the rail beside it is complementary.
        <main class="blank">
          <p class="wordmark">Remote Control Agent</p>
          <p class="muted">Pick a session on the left, or start a new one.</p>
        </main>
      )}
    </div>
  );
}

/** A session is one persistent terminal. Provider-specific transcripts stay out
 * of the working surface; tmux is the universal source of truth. */
function SessionScreen({
  session,
  onBack,
  onSignedOut,
  onResumed,
  sessionsCollapsed,
  onShowSessions,
}: {
  session: Session;
  onBack: () => void;
  onSignedOut: () => void;
  onResumed: (session: Session) => void;
  sessionsCollapsed: boolean;
  onShowSessions: () => void;
}) {
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(session.deadAt === null ? 'connecting' : 'ended');
  const resumable = session.deadAt !== null && session.providerSessionId !== null;

  const resume = async () => {
    if (!resumable || resuming) return;
    setResuming(true);
    setResumeError(null);
    try {
      onResumed(await api.resumeSession(session.id));
    } catch (failure) {
      setResumeError(messageOf(failure));
      setResuming(false);
    }
  };

  return (
    <main class="screen">
      <header class="bar">
        <button class="ghost bar-back" onClick={onBack} aria-label="Back to sessions">
          <span aria-hidden="true">‹</span>
          <span class="bar-back-word">Sessions</span>
        </button>
        {sessionsCollapsed && (
          <button
            type="button"
            class="ghost bar-show-rail"
            aria-label="Show session sidebar"
            title="Show sessions"
            onClick={onShowSessions}
          >
            <span class="rail-icon" aria-hidden="true" />
          </button>
        )}
        <div class="bar-title">
          <strong>{session.title}</strong>
        </div>
        {resumable && (
          <button
            type="button"
            class="primary bar-resume"
            aria-label="Resume session"
            disabled={resuming}
            onClick={() => void resume()}
          >
            {resuming ? 'Resuming…' : 'Resume'}
          </button>
        )}
        <div class="bar-chips">
          <span class={`chip chip-${status}`} role="status">
            {STATUS_TEXT[status]}
          </span>
        </div>
      </header>

      <div class="crumbs">
        <span class="sr-only">Working directory: {session.cwd}</span>
        <span class="crumb-path" aria-hidden="true" title={session.cwd}>
          {crumbs(session.cwd).map((segment, at, all) => {
            const earlier = at < all.length - 2 ? ' crumb-earlier' : '';
            return (
              <Fragment key={at}>
                <span class={`crumb-sep${earlier}`}>/</span>
                <span class={`${at === all.length - 1 ? 'crumb-last' : 'crumb-segment'}${earlier}`}>
                  {segment}
                </span>
              </Fragment>
            );
          })}
        </span>
      </div>

      {resumeError !== null && (
        <p class="error resume-error" role="alert">
          {resumeError}
        </p>
      )}

      <div class="panes">
        <section class="pane termsheet" aria-label="Terminal">
          {session.deadAt === null ? (
            <TerminalView session={session} onStatus={setStatus} onSignedOut={onSignedOut} />
          ) : (
            <div class="terminal-ended">
              <strong>Session ended</strong>
              <p class="muted">
                {resumable
                  ? 'Resume it to open the terminal again.'
                  : (unresumableNote(session) ?? 'This terminal cannot be resumed.')}
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onDone();
    } catch (failure) {
      // A wrong password and a lockout are ordinary states of this screen. The
      // lockout says how long, because "try again later" is not actionable.
      const wait = failure instanceof ApiError ? failure.retryAfter : null;
      setError(
        wait === null
          ? messageOf(failure)
          : `${messageOf(failure)} Try again in ${waitText(wait)}.`,
      );
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="centre login">
      <form class="card login-card" onSubmit={submit}>
        <div class="login-head">
          <p class="login-kicker">
            <span aria-hidden="true" /> Private access
          </p>
          <h1 class="wordmark">Remote Control Agent</h1>
          <p class="tagline">Your coding agents, on your machine, from anywhere.</p>
        </div>
        <div class="login-field">
          <label for="password">Password</label>
          <input
            id="password"
            type="password"
            autocomplete="current-password"
            // The only field on the only screen; not focusing it costs a tap.
            autofocus
            value={password}
            onInput={(event) => setPassword((event.target as HTMLInputElement).value)}
          />
        </div>
        {error !== null && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" class="primary login-submit" disabled={busy || password === ''}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

function Sessions({
  onOpen,
  onRemoved,
  onSignedOut,
  rail,
  collapsed,
  onCollapse,
  openId,
}: {
  onOpen: (session: Session) => void;
  onRemoved: (id: string) => void;
  onSignedOut: () => void;
  /**
   * Whether this list is the rail beside an open session rather than the whole
   * screen. It decides the landmark and the class the rail's border keys off, and
   * nothing else: a document may have exactly one `<main>`, and in the rail shape
   * that is the session on the right, so here the list is a named complementary
   * landmark instead.
   */
  rail: boolean;
  /** Hidden desktop rail state. It stays mounted so its live poll and scroll
   * position survive; CSS and `inert` remove it from sight and interaction. */
  collapsed: boolean;
  onCollapse?: () => void;
  /**
   * Which row is the session on screen beside this list, or `null` on a phone,
   * where the list is never on screen at the same time as a session and a
   * highlighted row would be marking something the user cannot see.
   */
  openId: string | null;
}) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [states, setStates] = useState<api.SessionStates>({});
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  /**
   * What is typed in the search box. Client-side over the list already fetched
   * — a machine has a handful of sessions, so a server round trip per keystroke
   * would be latency bought with nothing.
   */
  const [query, setQuery] = useState('');

  const refresh = useCallback(async () => {
    try {
      const listed = await api.listSessions();
      setSessions(listed.sessions);
      setStates(listed.states);
      setError(null);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) return onSignedOut();
      setError(messageOf(failure));
    }
  }, [onSignedOut]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const kill = async (session: Session) => {
    if (!confirm(`Kill “${session.title}”? The agent process stops.`)) return;
    try {
      await api.killSession(session.id);
    } catch (failure) {
      setError(messageOf(failure));
    }
    await refresh();
  };

  const remove = async (session: Session) => {
    if (
      !confirm(
        `Remove “${session.title}” from Remote Control Agent?\n\n` +
          `Its ${providerLabel(session.provider)} transcript stays on disk, but Remote Control Agent will no longer list or resume it.`,
      )
    )
      return;
    setRemoving(session.id);
    try {
      await api.removeSession(session.id);
      onRemoved(session.id);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setRemoving(null);
    }
    await refresh();
  };

  const groups = groupSessions(sessions ?? [], query, Date.now());

  // `.rail` is also what the desktop border keys off, so the class carries the
  // shape rather than the element name doing it.
  const Frame = rail ? 'aside' : 'main';
  return (
    <Frame
      class={rail ? 'screen rail' : 'screen'}
      aria-label={rail ? 'Sessions' : undefined}
      aria-hidden={collapsed || undefined}
      inert={collapsed}
    >
      <header class="bar">
        <h1 class="wordmark">RC Agent</h1>
        <div class="rail-actions">
          {rail && onCollapse !== undefined && (
            <button
              type="button"
              class="ghost rail-collapse"
              aria-label="Hide session sidebar"
              title="Hide sessions"
              onClick={onCollapse}
            >
              <span class="rail-icon" aria-hidden="true" />
            </button>
          )}
          <button
            class="ghost"
            onClick={async () => {
              await api.logout().catch(() => {});
              onSignedOut();
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Over the list rather than inside its scroller, so it is still there
          after scrolling. `type="search"` for the platform's own clear control
          and its keyboard; a placeholder is not an accessible name, so it also
          carries one. */}
      <div class="search">
        <input
          type="search"
          aria-label="Search sessions"
          placeholder="Search sessions…"
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
          value={query}
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
        />
      </div>

      <div class="scroll">
        {error !== null && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        {sessions === null && <p class="muted">Loading…</p>}
        {sessions?.length === 0 && (
          <p class="muted">No sessions yet. Start one below and it keeps running here.</p>
        )}
        {/* Grouped under the day each was last worked on, which is how anyone
            with more than a handful of these looks for one. `Date.now()` at
            render: the list already re-renders every `POLL_MS`, so "Today"
            becomes "Yesterday" on its own without a second timer. */}
        {groups.length === 0 && sessions !== null && sessions.length > 0 && (
          <p class="muted">Nothing matches “{query.trim()}”.</p>
        )}
        {groups.map((group) => (
          <Fragment key={group.day}>
            <h2 class="day">{group.day}</h2>
            {group.sessions.map((session) => {
              const note = unresumableNote(session);
              const on = session.id === openId;
              return (
                // The provider class is on the row as well as the tag: it is what
                // colours the spine down the left edge, which is the thing a scan of
                // the list reaches before it reaches a word.
                <div class={`row row-${session.provider}${on ? ' row-on' : ''}`} key={session.id}>
                  <button
                    class="row-open"
                    aria-current={on ? 'true' : undefined}
                    onClick={() => onOpen(session)}
                  >
                    {/* The provider first and colour-coded, because the question a
                        mixed list has to answer at a glance on a phone is which agent
                        this is — the title and the directory are often the same for
                        two sessions of different providers in the same project. */}
                    <span class="row-head">
                      <span class={`tag tag-${session.provider}`}>
                        {providerLabel(session.provider)}
                      </span>
                      <span class="row-title">{session.title}</span>
                    </span>
                    {/* Clipped at the right on a narrow row, so the full path is on
                        the element for a pointer that can hover one. */}
                    <span class="row-cwd" title={session.cwd}>
                      {session.cwd}
                    </span>
                    {note !== null && <span class="row-note">{note}</span>}
                  </button>
                  {/* Together, because they wrap together: a "Waiting for you" chip
                      and Kill are 200px of a 340px rail, and the row drops the pair
                      onto its own line rather than clipping the title to nothing. */}
                  <div class="row-side">
                    {/* The agent's own state where there is one, and only the
                        live/dead fact where there is not: a session whose provider is
                        not reporting must not be badged "idle", which is a claim. */}
                    {session.deadAt !== null ? (
                      <span class="chip chip-ended">dead</span>
                    ) : states[session.id] === undefined ? (
                      <span class="chip chip-live">live</span>
                    ) : (
                      <span class={`chip chip-agent-${states[session.id]!.state}`}>
                        {STATE_TEXT[states[session.id]!.state]}
                      </span>
                    )}
                    {session.deadAt === null ? (
                      <button
                        class="ghost danger"
                        onClick={() => void kill(session)}
                        aria-label="Kill session"
                      >
                        Kill
                      </button>
                    ) : (
                      <button
                        class="ghost danger"
                        disabled={removing === session.id}
                        onClick={() => void remove(session)}
                        aria-label="Remove session"
                      >
                        {removing === session.id ? 'Removing…' : 'Remove'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>

      <div class="foot">
        <button class="primary" onClick={() => setCreating(true)}>
          New session
        </button>
      </div>

      {creating && (
        <NewSession
          suggestions={sessions?.map((s) => s.cwd) ?? []}
          onClose={() => setCreating(false)}
          onCreated={(session) => {
            setCreating(false);
            onOpen(session);
          }}
        />
      )}
    </Frame>
  );
}

/**
 * What Codex's live “waiting for you” badge costs, said before it is bought.
 *
 * Codex trust-gates each entry in its own hooks file, so tether's hook means a
 * security prompt on the user's own machine. The captain's decision is to ask
 * once and explain first (`decision-codex-hook-trust-install.md`), which is a UI
 * obligation as much as a CLI one: a user who accepts because a tool told them
 * to has not made a decision.
 *
 * It appears here, next to the choice it is about, and nowhere else — no banner
 * on the list, no warning beside a Codex session that is running without it.
 * Declining is a supported configuration and everything but that one badge keeps
 * working, so a UI that kept mentioning it would be nagging about a working
 * setup. The install itself stays a CLI command on purpose: it writes to a file
 * tether does not own, and that should have to be asked for by name.
 */
function CodexHookNote() {
  return (
    <p class="note">
      Codex works here with no setup: the terminal and working/idle list state come from files Codex
      already writes. Only the live “waiting for you” list badge needs more — a small script Remote
      Control Agent adds to your Codex hooks file, which Codex then asks you to trust once. It
      appends one line under the app’s private state directory and does nothing else. Run{' '}
      <code>rcagent codex-hook install</code> on the machine to add it (it explains everything first
      and backs the file up), or <code>rcagent codex-hook remove</code> to remove it. Skip it and
      you lose that badge and nothing else.
    </p>
  );
}

function NewSession({
  suggestions,
  onClose,
  onCreated,
}: {
  suggestions: readonly string[];
  onClose: () => void;
  onCreated: (session: Session) => void;
}) {
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');
  const [provider, setProvider] = useState<string>(DEFAULT_PROVIDER);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [trust, setTrust] = useState<TrustReport | null>(null);
  const [accepted, setAccepted] = useState(false);

  /**
   * Ask whether the agent already trusts this directory, so the question can be
   * answered here instead of in the agent's own prompt in the terminal.
   *
   * Both the answer and the tick are cleared the moment either input changes, and
   * that reset is the load-bearing line: a box ticked for one directory must
   * never still be ticked for the next one typed, or tether would trust a folder
   * nobody agreed to. Debounced because this runs per keystroke, and every
   * failure — an offline server, a directory that does not exist yet, one outside
   * the allowed roots — leaves the sheet saying nothing at all. Start still
   * reports a refused directory in the server's own words.
   */
  useEffect(() => {
    setTrust(null);
    setAccepted(false);
    const dir = cwd.trim();
    if (dir === '') return;
    let live = true;
    const timer = setTimeout(() => {
      api
        .folderTrust(dir, provider)
        .then((report) => {
          if (live) setTrust(report);
        })
        .catch(() => {});
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [cwd, provider]);

  const ask = trust === null ? null : trustAsk(provider, trust.trust, trust.path, cwd.trim());

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // `accepted` alone is not enough: it survives no input change, but a tick
      // on an ask that has since become `unknown` (or trusted) must not travel.
      const trustFolder = accepted && ask?.accept !== undefined;
      onCreated(await api.createSession(cwd.trim(), title.trim(), provider, trustFolder));
    } catch (failure) {
      // `invalid_cwd` arrives with the server's own sentence, which names the
      // allowed roots. Showing it verbatim is the point: the server enforces the
      // confinement, so only the server can explain what would be accepted.
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true" aria-label="New session">
      <form class="card" onSubmit={submit}>
        <h2>New session</h2>

        {/* A native `<select>`: two options, correct keyboard and screen-reader
            behaviour for free, and on a phone the platform's own picker. */}
        <label for="provider">Agent</label>
        <select
          id="provider"
          value={provider}
          onChange={(event) => setProvider((event.target as HTMLSelectElement).value)}
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {provider === CODEX && <CodexHookNote />}

        <label for="cwd">Working directory</label>
        <input
          id="cwd"
          list="known-dirs"
          placeholder="/home/you/code/project"
          inputMode="url"
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
          value={cwd}
          onInput={(event) => setCwd((event.target as HTMLInputElement).value)}
        />
        {/* Directories already in use, so the common case is one tap. */}
        <datalist id="known-dirs">
          {[...new Set(suggestions)].map((dir) => (
            <option key={dir} value={dir} />
          ))}
        </datalist>

        {/* Beside the directory it is about, and nowhere else in the product: a
            folder tether asked about once is not something to keep mentioning.
            Every word of it comes from `trustAsk`. */}
        {ask !== null && (
          <div class="note trust">
            {ask.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
            {ask.accept !== undefined && (
              <label class="trust-accept">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(event) => setAccepted((event.target as HTMLInputElement).checked)}
                />
                {ask.accept}
              </label>
            )}
          </div>
        )}

        <label for="title">Title (optional)</label>
        <input
          id="title"
          placeholder="defaults to the directory name"
          value={title}
          onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
        />

        {error !== null && (
          <p class="error" role="alert">
            {error}
          </p>
        )}

        <div class="actions">
          <button type="button" class="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" class="primary" disabled={busy || cwd.trim() === ''}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </div>
  );
}
