/*
 * Pyp policy: "The AI proposes. Code decides."
 *
 * The AI only ever produces a proposal ({ type, amount, ... }). This plain,
 * testable code decides whether it may run on its own ("auto"), needs the
 * user's OK ("ask"), or is blocked. Nothing here calls an AI.
 */
(function (root) {
  'use strict';

  var DEFAULT_SETTINGS = {
    reminders: 'ask',        // 'ask' | 'auto'
    refundAutoLimit: 25,     // refunds at or under this amount run on Auto
    undoSeconds: 60,         // how long an Auto action can be undone
    remindersPerDay: 2       // daily cap on reminders
  };

  function money(n) {
    return '$' + Number(n).toFixed(2);
  }

  /**
   * @param {object} proposal  what the AI suggested
   * @param {object} facts     fresh data re-read from PayPal just before deciding
   * @param {object} settings  the user's settings
   * @returns {{ mode: 'auto'|'ask'|'blocked', checks: Array<{ok:boolean,text:string}>, policy: string }}
   */
  function decide(proposal, facts, settings) {
    var s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    var f = facts || {};
    var checks = [];
    var mode = 'ask';
    var policy = '';

    switch (proposal.type) {
      case 'reminder': {
        checks.push({ ok: !!proposal.onMenu, text: 'On the menu' });
        checks.push({ ok: f.status === 'UNPAID', text: f.status === 'UNPAID' ? 'Live re-check: still unpaid' : 'Live re-check: already paid' });
        var sentToday = f.remindersSentToday || 0;
        checks.push({ ok: sentToday < s.remindersPerDay, text: 'Reminders today: ' + sentToday + ' of ' + s.remindersPerDay });
        mode = s.reminders === 'auto' ? 'auto' : 'ask';
        policy = s.reminders === 'auto' ? 'Reminders are set to "Auto"' : 'Reminders are set to "Ask me", so this card';
        break;
      }
      case 'refund': {
        var amount = Number(proposal.amount);
        var paid = Number(f.paid);
        var refunded = Number(f.refunded || 0);
        checks.push({ ok: amount > 0 && amount + refunded <= paid, text: money(amount) + ' ≤ ' + money(paid - refunded) + ' paid' });
        if (amount <= s.refundAutoLimit) {
          mode = 'auto';
          policy = 'Refunds on Auto up to ' + money(s.refundAutoLimit).replace('.00', '') + ' → ' + s.undoSeconds + '-second undo window';
        } else {
          mode = 'ask';
          policy = 'Over your ' + money(s.refundAutoLimit).replace('.00', '') + ' Auto limit, so you decide';
        }
        break;
      }
      case 'evidence': {
        checks.push({ ok: f.disputeOpen === true, text: f.disputeOpen ? 'Dispute still open' : 'Dispute already closed' });
        mode = 'ask';
        policy = 'Evidence is never Auto, so you decide';
        break;
      }
      default:
        mode = 'blocked';
        policy = 'Pyp has no permission for "' + proposal.type + '"';
    }

    // Any failed check blocks the action, whatever the mode.
    if (checks.some(function (c) { return !c.ok; })) {
      mode = 'blocked';
      policy = 'A check failed, so nothing will run';
    }

    return { mode: mode, checks: checks, policy: policy };
  }

  root.PypPolicy = { decide: decide, DEFAULT_SETTINGS: DEFAULT_SETTINGS };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PypPolicy;
})(typeof window !== 'undefined' ? window : globalThis);
