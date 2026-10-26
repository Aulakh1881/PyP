import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../shared/policy.js');
require('../shared/demo-data.js');
const { createTransport } = globalThis.PypDemo;

test('inbox starts with the three cards and 3 need a look', async () => {
  const t = createTransport();
  const box = await t.inbox();
  assert.equal(box.items.length, 3);
  assert.equal(box.needLook, 3);
  assert.deepEqual(box.items.map((i) => i.kind), ['invoice', 'dispute', 'refund']);
  assert.equal(box.items[2].state, 'auto');
});

test('approving the invoice sends the reminder and logs it', async () => {
  const t = createTransport();
  const seen = [];
  t.subscribe((items) => seen.push(items.find((i) => i.id === 'inv-0042').buttons[0].label));
  const done = await t.act('inv-0042', 'approve');
  assert.equal(done.state, 'done');
  assert.equal(done.box.title, 'Reminder sent through PayPal');
  assert.equal(done.run.steps.at(-1).tag, 'Action');
  assert.deepEqual(seen, ['Sending…', 'Sent ✓']);
});

test('dispute review sends the edited draft', async () => {
  const t = createTransport();
  const reviewing = await t.act('dsp-1188', 'review');
  assert.equal(reviewing.reviewing, true);
  const sent = await t.act('dsp-1188', 'send', { draft: 'Edited text' });
  assert.equal(sent.state, 'done');
  assert.equal(sent.draft, 'Edited text');
});

test('undo cancels the Auto refund and the timer no longer runs it', async () => {
  const t = createTransport();
  const undone = await t.act('ref-beta', 'undo');
  assert.equal(undone.state, 'closed');
  const after = await t.act('ref-beta', 'timer-done');
  assert.equal(after.state, 'closed');
});

test('dismiss and restore round-trip', async () => {
  const t = createTransport();
  const d = await t.act('inv-0042', 'dismiss');
  assert.equal(d.badge.text, 'Dismissed');
  const r = await t.act('inv-0042', 'restore');
  assert.equal(r.state, 'open');
});

test('chat answers known topics and falls back politely', async () => {
  const t = createTransport();
  assert.match((await t.chat({ text: 'any late invoices?' })).text, /Acme Studio/);
  assert.match((await t.chat({ text: 'Refund status' })).text, /\$18\.00/);
  assert.match((await t.chat({ text: 'qwerty' })).text, /demo data/);
  assert.match((await t.chat({ text: '', attachment: { kind: 'screenshot' } })).text, /screenshot/);
});

test('activity log starts with 4 overnight entries plus the 3 cards, newest first', async () => {
  const t = createTransport();
  const a = await t.activity();
  assert.equal(a.length, 7);
  assert.ok(a.every((x, i) => i === 0 || a[i - 1].when >= x.when));
  assert.equal(a.filter((x) => x.status === 'Done').length, 4);
});

test('acting on a card updates its activity entry', async () => {
  const t = createTransport();
  await t.act('inv-0042', 'approve');
  const row = (await t.activity()).find((x) => x.itemId === 'inv-0042');
  assert.equal(row.status, 'Done');
  assert.equal(row.who, 'You approved');
});

test('pause blocks writes and freezes the undo timer; resume restarts it', async () => {
  const t = createTransport();
  t.setPaused(true);
  const blocked = await t.act('inv-0042', 'approve');
  assert.equal(blocked.state, 'open');
  const frozen = (await t.inbox()).items.find((i) => i.id === 'ref-beta');
  assert.equal(frozen.undoEndsAt, null);
  assert.ok(frozen.pausedLeft > 0);
  t.setPaused(false);
  const running = (await t.inbox()).items.find((i) => i.id === 'ref-beta');
  assert.ok(running.undoEndsAt > Date.now());
});

test('state persists through the persist adapter and reset restores it', async () => {
  let saved = null;
  const persist = { load: async () => saved, save: (s) => { saved = s; } };
  const a = createTransport({ persist });
  await a.ready;
  await a.act('inv-0042', 'dismiss');
  const b = createTransport({ persist });
  await b.ready;
  assert.equal((await b.inbox()).items[0].badge.text, 'Dismissed');
  b.reset();
  assert.equal(saved.items[0].state, 'open');
});

test('settings update and survive', async () => {
  const t = createTransport();
  t.updateSettings({ refundAutoLimit: 40, skills: { disputes: 'off' } });
  const s = t.getSettings();
  assert.equal(s.refundAutoLimit, 40);
  assert.equal(s.skills.disputes, 'off');
  assert.equal(s.skills.collections, 'ask');
});
