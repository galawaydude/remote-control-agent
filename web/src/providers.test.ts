import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODEX,
  DEFAULT_PROVIDER,
  PROVIDERS,
  providerLabel,
  trustAsk,
  unresumableNote,
} from './providers.ts';

test('every provider the server accepts is offered, default first', () => {
  assert.deepEqual(
    PROVIDERS.map((provider) => provider.id),
    [DEFAULT_PROVIDER, CODEX],
  );
  assert.equal(PROVIDERS[0]?.id, DEFAULT_PROVIDER);
});

test('an unknown provider is named rather than blanked', () => {
  assert.equal(providerLabel(DEFAULT_PROVIDER), 'Claude Code');
  assert.equal(providerLabel(CODEX), 'Codex');
  assert.equal(providerLabel('some-future-agent'), 'some-future-agent');
});

test('only a dead row with no provider identity is unresumable', () => {
  assert.match(unresumableNote({ deadAt: 1, providerSessionId: null }) ?? '', /no saved session/);
  assert.equal(unresumableNote({ deadAt: null, providerSessionId: null }), null);
  assert.equal(unresumableNote({ deadAt: 1, providerSessionId: 'abc' }), null);
});

test('a trusted folder asks nothing', () => {
  for (const provider of [DEFAULT_PROVIDER, CODEX]) {
    assert.equal(trustAsk(provider, 'trusted', '/w/p', '/w/p'), null);
  }
});

test('an untrusted folder explains the scope and terminal fallback', () => {
  const ask = trustAsk(DEFAULT_PROVIDER, 'untrusted', '/w/p', '/w/p');
  const text = (ask?.lines ?? []).join(' ');
  assert.match(text, /Claude Code/);
  assert.match(text, /read, change and run files/);
  assert.match(text, /will ask you in the terminal instead/);
  assert.equal(ask?.accept, 'I trust this folder');
});

test('repository-scoped trust names the repository', () => {
  const ask = trustAsk(CODEX, 'untrusted', '/w/repo', '/w/repo/sub');
  const text = (ask?.lines ?? []).join(' ');
  assert.match(text, /\/w\/repo, the repository \/w\/repo\/sub is in/);
  assert.match(text, /every directory inside it/);
});

test('an unreadable trust file is never guessed or offered a write', () => {
  const ask = trustAsk(CODEX, 'unknown', '/w/p', '/w/p');
  const text = (ask?.lines ?? []).join(' ');
  assert.match(text, /cannot tell whether Codex/);
  assert.match(text, /will not guess/);
  assert.equal(ask?.accept, undefined);
});
