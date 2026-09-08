/**
 * The HTTP half of the server contract, in one module.
 *
 * Every failure the server can return is turned into an {@link ApiError} with a
 * sentence a person can act on. That is not decoration: a refused working
 * directory and a rate-limited login are ordinary states of this product, and a
 * UI that renders them as "something went wrong" has thrown away the one piece
 * of information the server went to the trouble of sending.
 */

import type { Session, SessionState, TrustReport } from '@tether/shared';

export type { Session, TrustReport };

/**
 * What each live session is doing, beside the rows rather than on them. No
 * detail: the registry file the list is built from has no such field, and the
 * one sentence that says *what* is wanted arrives on the session's own `state`
 * frame, from the `Notification` hook.
 */
export type SessionStates = Record<string, { state: SessionState }>;

/** The only machine there is in M1; the API is addressed by machine regardless. */
const MACHINE = 'local';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Seconds until a rate-limited login may be retried, when the server said. */
  readonly retryAfter: number | null;
  /**
   * The refusal's own body, unread. A rejection carries more than a code where
   * the server has more to say — a permission-mode cycle that stalled reports
   * the mode the pane actually landed in — and dropping it here is how a field
   * the server went to the trouble of sending becomes unreachable. Whoever
   * words the sentence reads what it needs and treats anything else as absent.
   */
  readonly body: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    retryAfter: number | null = null,
    body: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

/** Wording for the error codes the server actually returns. */
const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Wrong password.',
  too_many_attempts: 'Too many attempts. This device is locked out for a while.',
  unauthorized: 'Your session has expired — log in again.',
  no_such_session: 'That session no longer exists.',
  not_awaiting_answer: 'Already answered — the agent has moved on.',
  session_live: 'This session is still running. Kill it before removing it.',
  session_dead: 'This session has ended. It cannot receive an image.',
  invalid_image: 'That file is not a valid supported image.',
  forbidden_host: 'This hostname is not in the server’s allowed list.',
  forbidden_origin: 'The server refused this origin.',
};

/** For a status code with no wording of its own. See the call site. */
export function unhandled(status: number): string {
  return status >= 500
    ? `The server failed on this (${status}). The reason is in its log.`
    : `The server refused this (${status}).`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, 'offline', 'Cannot reach Remote Control Agent — check the connection.');
  }

  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  const fields = (body ?? {}) as { error?: string; message?: string };

  if (!response.ok) {
    const code = fields.error ?? `http_${response.status}`;
    const header = response.headers.get('retry-after');
    throw new ApiError(
      response.status,
      code,
      // The server's own message wins where it has one: `invalid_cwd` carries the
      // allowed roots, and that sentence is the whole answer to the refusal.
      //
      // The fallback says *refused* only where the server really refused. A 5xx
      // is the server failing at something it agreed to do, and calling that a
      // refusal points the user at their own request when the fault and its
      // stack are on the server — which since this PR is a log they can read.
      fields.message ?? MESSAGES[code] ?? unhandled(response.status),
      header === null ? null : Number(header),
      body,
    );
  }
  return body as T;
}

function json(method: string, value: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

export function login(password: string): Promise<void> {
  return request('/api/login', json('POST', { password }));
}

export function logout(): Promise<void> {
  return request('/api/logout', { method: 'POST' });
}

/** Resolves if the cookie is still good; rejects with 401 if it is not. */
export function checkSession(): Promise<{ authenticated: boolean }> {
  return request('/api/session');
}

export async function listSessions(): Promise<{ sessions: Session[]; states: SessionStates }> {
  const body = await request<{ sessions: Session[]; states?: SessionStates }>(
    `/api/machines/${MACHINE}/sessions`,
  );
  return { sessions: body.sessions, states: body.states ?? {} };
}

/** Restore the session named in the URL after a browser reload. */
export async function getSession(id: string): Promise<Session> {
  const body = await request<{ session: Session }>(`/api/machines/${MACHINE}/sessions/${id}`);
  return body.session;
}

/**
 * Whether the selected agent already trusts a directory, from that agent's own
 * configuration — asked while the New session sheet is open, before anything is
 * started. A 400 means the directory would be refused a session anyway, which is
 * ordinary while one is being typed and is Start's sentence to say, not this one's.
 */
export function folderTrust(cwd: string, provider: string): Promise<TrustReport> {
  const query = new URLSearchParams({ cwd, provider });
  return request(`/api/machines/${MACHINE}/folder-trust?${query.toString()}`);
}

export async function createSession(
  cwd: string,
  title?: string,
  provider?: string,
  trustFolder?: boolean,
): Promise<Session> {
  const body = {
    cwd,
    ...(title === undefined || title === '' ? {} : { title }),
    // Sent only when it is true, and true only from the user's own tap on the
    // sheet's trust box. This is the one field in the product that causes tether
    // to write into the agent's configuration, so it says nothing by default.
    ...(trustFolder === true ? { trustFolder: true } : {}),
    // The picker always has a provider selected, so in practice this always
    // sends one — the web's own id, not the server's default. That is the
    // design: the create route's `enum` is the enforcement, so an id that has
    // drifted from the server's is a 400 rather than a session quietly running
    // the wrong agent under the right name. Omitting it is left possible for a
    // caller that has no opinion, which then gets the server's default.
    ...(provider === undefined ? {} : { provider }),
  };
  const { session } = await request<{ session: Session }>(
    `/api/machines/${MACHINE}/sessions`,
    json('POST', body),
  );
  return session;
}

export function killSession(id: string): Promise<{ session: Session }> {
  return request(`/api/machines/${MACHINE}/sessions/${id}`, { method: 'DELETE' });
}

/** Remove a dead row from tether's list without touching the provider transcript. */
export function removeSession(id: string): Promise<void> {
  return request(`/api/machines/${MACHINE}/sessions/${id}/forget`, { method: 'POST' });
}

/** Restart a dead row through the provider's own saved session. */
export async function resumeSession(id: string): Promise<Session> {
  const body = await request<{ session: Session }>(
    `/api/machines/${MACHINE}/sessions/${id}/resume`,
    { method: 'POST' },
  );
  return body.session;
}

/** Follow the host and scheme that served the page; proxies change both together. */
export function termSocketUrl(tmuxName: string, clientId: string, output = true): string {
  return socketUrl(`api/sessions/${tmuxName}/term`, {
    client: clientId,
    output: output ? '1' : '0',
  });
}

function socketUrl(path: string, query: Record<string, string>): string {
  const url = new URL(path, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}
