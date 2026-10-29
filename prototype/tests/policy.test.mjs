import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decide } = require('../shared/policy.js');

test('small refund within the limit runs on Auto with an undo window', () => {
  const r = decide({ type: 'refund', amount: 18 }, { paid: 240, refunded: 0 }, {});
  assert.equal(r.mode, 'auto');
  assert.match(r.policy, /60-second undo/);
  assert.ok(r.checks.every((c) => c.ok));
});

test('refund over the limit needs the user', () => {
  const r = decide({ type: 'refund', amount: 40 }, { paid: 240 }, { refundAutoLimit: 25 });
  assert.equal(r.mode, 'ask');
});

test('refund larger than what was paid is blocked, even under the limit', () => {
  const r = decide({ type: 'refund', amount: 20 }, { paid: 10 }, {});
  assert.equal(r.mode, 'blocked');
});

test('refund counts earlier refunds', () => {
  const r = decide({ type: 'refund', amount: 15 }, { paid: 100, refunded: 90 }, {});
  assert.equal(r.mode, 'blocked');
});

test('reminders follow the "Ask me" setting by default', () => {
  const r = decide({ type: 'reminder', onMenu: true }, { status: 'UNPAID', remindersSentToday: 0 }, {});
  assert.equal(r.mode, 'ask');
});

test('reminder is blocked when the invoice was paid in the meantime', () => {
  const r = decide({ type: 'reminder', onMenu: true }, { status: 'PAID' }, { reminders: 'auto' });
  assert.equal(r.mode, 'blocked');
});

test('reminder is blocked after the daily cap', () => {
  const r = decide({ type: 'reminder', onMenu: true }, { status: 'UNPAID', remindersSentToday: 2 }, { remindersPerDay: 2 });
  assert.equal(r.mode, 'blocked');
});

test('dispute evidence is never Auto', () => {
  const r = decide({ type: 'evidence' }, { disputeOpen: true }, { reminders: 'auto', refundAutoLimit: 1e9 });
  assert.equal(r.mode, 'ask');
});

test('anything not on the menu is blocked', () => {
  const r = decide({ type: 'send_money', amount: 5 }, {}, {});
  assert.equal(r.mode, 'blocked');
});
