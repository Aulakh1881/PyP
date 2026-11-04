import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const grid = require('../website/app/activity-grid.js');

const NOW = Date.parse('2026-11-04T12:00:00Z');

test('parseAmount handles PayPal strings, Pyp strings and blanks', () => {
  assert.equal(grid.parseAmount('1200.00'), 1200);
  assert.equal(grid.parseAmount('$1,200.00'), 1200);
  assert.equal(grid.parseAmount('-18.00'), -18);
  assert.equal(grid.parseAmount('—'), null);
  assert.equal(grid.parseAmount(null), null);
  assert.equal(grid.parseAmount(42.5), 42.5);
});

test('an unpaid invoice past its due date is overdue; paid or not yet due is not', () => {
  assert.equal(grid.isOverdue({ status: 'SENT', dueDate: '2026-10-16', dueAmount: '1200.00' }, NOW), true);
  assert.equal(grid.isOverdue({ status: 'PAID', dueDate: '2026-10-16', dueAmount: '0.00' }, NOW), false);
  assert.equal(grid.isOverdue({ status: 'SENT', dueDate: '2026-12-01', dueAmount: '50.00' }, NOW), false);
  assert.equal(grid.isOverdue({ status: 'SENT', dueDate: '2026-10-16', dueAmount: '0.00' }, NOW), false);
  assert.equal(grid.isOverdue({ status: 'DRAFT', dueDate: '2026-10-16' }, NOW), false);
});

test('toRows merges all four sources, newest first, with the right kinds', () => {
  const rows = grid.toRows({
    transactions: [{ id: 'T1', date: '2026-11-02T10:00:00Z', typeLabel: 'Payment received', statusLabel: 'Success', amount: '240.00', currency: 'USD', subject: 'Beta LLC', orderId: 'O1' }],
    invoices: [{ id: 'INV2-1', number: '0042', status: 'SENT', statusLabel: 'Sent', date: '2026-10-01', dueDate: '2026-10-16', recipient: 'Acme Studio', amount: '1200.00', dueAmount: '1200.00', currency: 'USD' }],
    disputes: [{ id: 'PP-D-1', status: 'OPEN', statusLabel: 'Open', reasonLabel: 'Item not received', createdAt: '2026-10-25T11:30:00Z', amount: '86.00', currency: 'USD' }],
    pyp: [{ id: 'a1', when: '2026-11-03T09:00:00', skill: 'Collections', action: 'Reminder sent', target: 'Invoice #0039', amount: '$450.00', status: 'Done', run: { id: '51c8', steps: [] } }]
  }, NOW);

  assert.deepEqual(rows.map((r) => r.kind), ['pyp', 'payment', 'dispute', 'invoice']);
  const inv = rows.find((r) => r.kind === 'invoice');
  assert.equal(inv.status, 'Overdue');
  assert.equal(inv.tone, 'warn');
  assert.equal(inv.what, 'Invoice 0042');
  assert.equal(rows.find((r) => r.kind === 'payment').tone, 'good');
  assert.equal(rows.find((r) => r.kind === 'pyp').amount, 450);
  assert.equal(rows.find((r) => r.kind === 'pyp').source, 'Pyp');
});

test('rows survive missing fields without throwing', () => {
  const rows = grid.toRows({ transactions: [{ id: 'T2' }], invoices: [{ id: 'I3', status: 'DRAFT' }], disputes: [{ id: 'D4' }] }, NOW);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.id && r.kind && r.amount === null));
});

test('countByKind counts each kind and the total', () => {
  const c = grid.countByKind([{ kind: 'payment' }, { kind: 'payment' }, { kind: 'pyp' }]);
  assert.deepEqual(c, { all: 3, payment: 2, invoice: 0, dispute: 0, pyp: 1 });
});

test('formatMoney shows currency and handles blanks', () => {
  assert.equal(grid.formatMoney(1200, 'USD'), '$1,200.00');
  assert.equal(grid.formatMoney(-18, 'USD'), '-$18.00');
  assert.equal(grid.formatMoney(null, 'USD'), '—');
});
