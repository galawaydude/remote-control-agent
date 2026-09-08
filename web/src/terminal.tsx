/**
 * The terminal pane: xterm.js on one end, the `term` WebSocket on the other.
 * It fills the session screen (`app.tsx`), which owns the header and the status
 * chip reported through `onStatus`.
 *
 * Two properties this file exists to keep:
 *
 *  1. **Binary end to end.** Frames arrive as `ArrayBuffer` and go into
 *     `term.write(Uint8Array)` untouched. Nothing here decodes terminal output —
 *     a multi-byte glyph split across a chunk boundary corrupts silently if
 *     anything does.
 *  2. **Nothing is remembered.** The server replays the whole terminal on every
 *     attach and keeps no cursor (report §3), so the client resets xterm before
 *     every connect. A client that kept its screen would duplicate the history
 *     on each reconnect, which is exactly the bug the design avoids by
 *     re-deriving instead of resuming.
 */

import type { FitAddon as XtermFitAddon } from '@xterm/addon-fit';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import type { ClientFrame, Session } from '@tether/shared';
import { useEffect, useRef } from 'preact/hooks';

import { ApiError, checkSession, termSocketUrl } from './api.ts';
import { encodeInput, newClientId, withSeq } from './keys.ts';
import type { InputFrame } from './keys.ts';
import type { Status } from './status.ts';

/**
 * From `server/src/web/term-socket.ts`; the wire contract, not a guess.
 *
 * Three, not two. The server used to close *every* failed attach as
 * `CLOSE_NO_SESSION`, so a native module that would not spawn arrived here as
 * "Session not found" — see `attachClose` there, and `STATUS_TEXT` for what each
 * one is now allowed to say.
 */
const CLOSE_NO_SESSION = 4404;
const CLOSE_SESSION_ENDED = 4410;
const CLOSE_ATTACH_FAILED = 4500;

const CLOSE_STATUS: Record<number, Status> = {
  [CLOSE_NO_SESSION]: 'gone',
  [CLOSE_SESSION_ENDED]: 'ended',
  [CLOSE_ATTACH_FAILED]: 'failed',
};

/**
 * Backoff, not a fixed interval: this runs on a phone, and a server that is
 * unreachable for an hour must not be asked every 1.5 seconds for that hour.
 * The floor keeps the common case — a screen lock, a tunnel blip — instant.
 */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/** Long enough to coalesce an orientation change, short enough not to be felt. */
const RESIZE_DEBOUNCE_MS = 120;
/** A failed capture reconnects; it never masquerades as usable history. */
const HISTORY_REFRESH_TIMEOUT_MS = 10_000;

/**
 * The keys a phone keyboard does not have and the agent's TUI cannot be driven
 * without. Real `<button>`s with real labels: an icon-only bar is unusable with a
 * screen reader and ambiguous without one.
 */
const ACCESSORY: readonly { label: string; name: string; keys: string[] }[] = [
  { label: 'Esc', name: 'Escape', keys: ['Escape'] },
  { label: 'Tab', name: 'Tab', keys: ['Tab'] },
  { label: '↑', name: 'Up arrow', keys: ['Up'] },
  { label: '↓', name: 'Down arrow', keys: ['Down'] },
  { label: '←', name: 'Left arrow', keys: ['Left'] },
  { label: '→', name: 'Right arrow', keys: ['Right'] },
  { label: '⌃C', name: 'Control C', keys: ['C-c'] },
];

export function TerminalView({
  session,
  onStatus,
  onSignedOut,
}: {
  session: Session;
  onStatus: (status: Status) => void;
  onSignedOut: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const send = useRef<(frame: InputFrame) => void>(() => {});
  const focus = useRef<() => void>(() => {});
  const historyUp = useRef<() => void>(() => {});
  const historyEnd = useRef<() => void>(() => {});

  const signOut = useRef(onSignedOut);
  signOut.current = onSignedOut;
  const setStatus = useRef(onStatus);
  setStatus.current = onStatus;

  useEffect(() => {
    let term: XtermTerminal | undefined;
    let fit: XtermFitAddon | undefined;
    const clientId = newClientId();
    let seq = 0;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let resizing: ReturnType<typeof setTimeout> | undefined;
    let historyTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshingHistory = false;
    let historyFresh = false;
    let pendingHistoryPages = 0;
    let endAfterHistory = false;
    let writes = Promise.resolve();
    let closed = false;
    let backoff = RECONNECT_MIN_MS;

    const post = (frame: ClientFrame) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };

    // xterm parses writes asynchronously. Serialising resets and writes makes a
    // history `ready` frame a real barrier rather than a network-timing guess.
    const resetTerminal = () => {
      writes = writes.then(() => term?.reset());
    };
    const writeTerminal = (bytes: Uint8Array) => {
      writes = writes.then(
        () =>
          new Promise<void>((resolve) => {
            if (term === undefined) resolve();
            else term.write(bytes, resolve);
          }),
      );
    };

    send.current = (frame) => {
      seq += 1;
      post(withSeq(frame, seq));
    };

    const sendSize = () => {
      if (term === undefined || fit === undefined) return;
      const proposed = fit.proposeDimensions();
      if (proposed === undefined || proposed.cols < 1 || proposed.rows < 1) return;
      fit.fit();
      post({ c: 'resize', cols: term.cols, rows: term.rows });
    };

    const retry = async () => {
      const expired = await checkSession().then(
        () => false,
        (error: unknown) => error instanceof ApiError && error.status === 401,
      );
      if (closed) return;
      if (expired) {
        setStatus.current('signedOut');
        signOut.current();
        return;
      }
      reconnect = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    };

    const connect = () => {
      clearTimeout(historyTimer);
      refreshingHistory = false;
      historyFresh = false;
      pendingHistoryPages = 0;
      endAfterHistory = false;
      resetTerminal();
      const ws = new WebSocket(termSocketUrl(session.tmuxName, clientId, true));
      ws.binaryType = 'arraybuffer';
      socket = ws;

      ws.onopen = () => {
        backoff = RECONNECT_MIN_MS;
        setStatus.current('live');
        post({ c: 'output', enabled: true });
        sendSize();
      };
      ws.onmessage = (event: MessageEvent) => {
        // Binary end to end: xterm owns decoding across chunk boundaries.
        if (event.data instanceof ArrayBuffer) {
          const atBottom = term?.buffer.active.viewportY === term?.buffer.active.baseY;
          writeTerminal(new Uint8Array(event.data));
          if (!refreshingHistory && atBottom) historyFresh = false;
          return;
        }
        if (typeof event.data !== 'string') return;
        try {
          const frame = JSON.parse(event.data) as { c?: unknown; phase?: unknown };
          if (frame.c !== 'history' || !refreshingHistory) return;
          if (frame.phase === 'start') resetTerminal();
          else if (frame.phase === 'ready') {
            // WebSocket ordering guarantees every captured byte is already in
            // this chain. The callback guarantees xterm parsed it before moving.
            const ready = writes;
            void ready.then(() => {
              if (!refreshingHistory || closed) return;
              clearTimeout(historyTimer);
              refreshingHistory = false;
              historyFresh = true;
              const pages = pendingHistoryPages;
              pendingHistoryPages = 0;
              if (endAfterHistory) term?.scrollToBottom();
              else if (pages > 0) term?.scrollPages(-pages);
              endAfterHistory = false;
            });
          }
        } catch {
          /* Unknown control frames do not take down the terminal. */
        }
      };
      ws.onclose = (event: CloseEvent) => {
        socket = null;
        clearTimeout(historyTimer);
        refreshingHistory = false;
        pendingHistoryPages = 0;
        endAfterHistory = false;
        if (closed) return;
        const settled = CLOSE_STATUS[event.code];
        if (settled !== undefined) {
          setStatus.current(settled);
          return;
        }
        setStatus.current('retrying');
        void retry();
      };
    };

    const scheduleResize = () => {
      clearTimeout(resizing);
      resizing = setTimeout(sendSize, RESIZE_DEBOUNCE_MS);
    };
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(host.current as HTMLDivElement);
    window.visualViewport?.addEventListener('resize', scheduleResize);

    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(
      ([xterm, addon]) => {
        if (closed) return;
        term = new xterm.Terminal({
          fontSize: window.innerWidth < 480 ? 12 : 14,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          cursorBlink: true,
          scrollback: 5000,
          theme: { background: '#16181d', foreground: '#eceef2', cursor: '#ffb454' },
        });
        fit = new addon.FitAddon();
        term.loadAddon(fit);
        term.open(host.current as HTMLDivElement);
        focus.current = () => term?.focus();
        historyUp.current = () => {
          if (term === undefined || socket?.readyState !== WebSocket.OPEN) return;
          // A tmux attach repaints its current viewport and may coalesce all the
          // output that scrolled past, so xterm can have one line of history
          // while tmux has thousands. Refresh once; later pages are local.
          if (historyFresh && !refreshingHistory) {
            term.scrollPages(-1);
            return;
          }
          pendingHistoryPages += 1;
          endAfterHistory = false;
          if (refreshingHistory) return;
          refreshingHistory = true;
          historyTimer = setTimeout(() => socket?.close(), HISTORY_REFRESH_TIMEOUT_MS);
          post({ c: 'output', enabled: false });
          post({ c: 'output', enabled: true });
        };
        historyEnd.current = () => {
          pendingHistoryPages = 0;
          endAfterHistory = refreshingHistory;
          term?.scrollToBottom();
        };
        term.onData((data) => {
          for (const frame of encodeInput(data)) send.current(frame);
        });
        sendSize();
        connect();
        focus.current();
      },
      () => setStatus.current('failed'),
    );

    return () => {
      closed = true;
      clearTimeout(reconnect);
      clearTimeout(resizing);
      clearTimeout(historyTimer);
      observer.disconnect();
      window.visualViewport?.removeEventListener('resize', scheduleResize);
      socket?.close();
      focus.current = () => {};
      historyUp.current = () => {};
      historyEnd.current = () => {};
      term?.dispose();
    };
  }, [session.tmuxName]);

  return (
    <>
      <div class="term" ref={host} />
      <nav class="keys" aria-label="Terminal keys">
        {ACCESSORY.map((key) => (
          <button
            key={key.label}
            type="button"
            aria-label={key.name}
            onClick={() => {
              send.current({ c: 'key', keys: key.keys });
              focus.current();
            }}
          >
            {key.label}
          </button>
        ))}
        <button
          type="button"
          aria-label="Scroll terminal history up"
          onClick={() => historyUp.current()}
        >
          Pg↑
        </button>
        <button
          type="button"
          aria-label="Jump to latest terminal output"
          onClick={() => historyEnd.current()}
        >
          End
        </button>
      </nav>
    </>
  );
}
