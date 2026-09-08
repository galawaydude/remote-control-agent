import assert from 'node:assert/strict';
import test from 'node:test';

import { STATUS_TEXT, type Status } from './status.ts';

test('only a genuinely missing session says it was not found', () => {
  const statuses = Object.keys(STATUS_TEXT) as Status[];
  for (const status of statuses) {
    assert.equal(/not found/i.test(STATUS_TEXT[status]), status === 'gone', status);
  }
});

test('terminal failures do not claim the session ended', () => {
  assert.equal(STATUS_TEXT.failed, 'Terminal unavailable');
  assert.equal(STATUS_TEXT.ended, 'Session ended');
});
