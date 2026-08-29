/** Terminal channel states and the exact text shown in the session header. */
export type Status = 'connecting' | 'live' | 'retrying' | 'ended' | 'gone' | 'failed' | 'signedOut';

export const STATUS_TEXT: Record<Status, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  retrying: 'Reconnecting…',
  ended: 'Session ended',
  gone: 'Session not found',
  failed: 'Terminal unavailable',
  signedOut: 'Signed out',
};
