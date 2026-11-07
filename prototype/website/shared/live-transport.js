/*
 * Live transport: the same methods as the demo transport (see the top of
 * demo-data.js), backed by the real Next.js API instead of made-up data.
 *
 *   inbox / act / activity   /api/cards, /api/cards/{id}/approve|dismiss, /api/cards/{id}/trace
 *   chat                     /api/chat (the receptionist routes the sentence to a skill)
 *   overview … disputes      /api/paypal/* (read-only sandbox data)
 *   brief                    built here from /api/paypal/* and the cards (code does the maths)
 *
 * The page must be served from the same origin as the API (scripts/live-dashboard.mjs
 * on port 3001 does that), so the sign-in cookie rides along and no CORS is needed.
 * Settings and Pause live in this browser only until the engine reads them. Pause
 * blocks Approve from this browser; it doesn't stop the server (Auto cards, other tabs).
 */
(function (root) {
  'use strict';

  var SETTINGS_KEY = 'pyp-live-settings';
  var POLL_MS = 20000;

  var DEFAULT_SETTINGS = {
    skills: { collections: 'ask', disputes: 'ask', refunds: 'ask', insights: 'on' },
    reminders: 'ask',
    refundAutoLimit: 25,
    undoSeconds: 60,
    remindersPerDay: 2
  };

  // Engine trace stages -> the tags the card back and the Activity drawer colour.
  var TAG = { trigger: 'Trigger', gather: 'Read', menu: 'Menu', decide: 'AI', validate: 'Check', policy: 'Policy', act: 'Action', error: 'Error' };

  var STATUS = {
    awaiting_approval: 'Waiting for you',
    scheduled: 'Undo window',
    executing: 'Sending',
    executed: 'Done',
    failed: 'Failed',
    blocked: 'Blocked',
    obsolete: 'Canceled',
    rejected: 'Dismissed',
    undone: 'Canceled'
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function hms(iso) { return new Date(iso).toTimeString().slice(0, 8); }
  function shortDate(iso) { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  function clock(iso) { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }

  function money(value, currency) {
    var n = Number(value);
    if (value == null || !isFinite(n)) return '—';
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(n); } catch (e) { return (currency || '') + ' ' + n.toFixed(2); }
  }

  function loadSettings() {
    try {
      var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (saved && saved.settings) return saved;
    } catch (e) { /* blocked or bad JSON */ }
    return { settings: clone(DEFAULT_SETTINGS), paused: false };
  }
  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* blocked */ }
  }

  function createLiveTransport(options) {
    options = options || {};
    var base = options.apiBase || '';
    var listeners = [];
    var cards = [];
    var traces = {};   // card id -> { key, steps }
    var busy = {};     // card id -> true while approve/dismiss is in flight
    var notes = {};    // card id -> last message from approve/dismiss
    var local = loadSettings();
    var lastJson = '';
    var loadError = null; // why the last /api/cards load failed, shown instead of "all caught up"

    async function api(path, init) {
      var res = await fetch(base + path, Object.assign({ credentials: 'include', cache: 'no-store' }, init || {}, {
        headers: Object.assign({ 'Content-Type': 'application/json' }, (init && init.headers) || {})
      }));
      if (res.status === 401 && options.onSignedOut !== false) {
        root.location.href = base + '/login'; // sign-in ends at /dashboard, which sends :3001 back to /app/
        throw new Error('Signed out');
      }
      var body = await res.json().catch(function () { return {}; });
      return { ok: res.ok, status: res.status, body: body };
    }

    async function read(path, what) {
      var r = await api(path);
      if (!r.ok) throw new Error(r.body.error || what + ' is unavailable.');
      return r.body;
    }

    function skillOf(card) {
      var s = String((card.front && card.front.eyebrow) || '').split('·')[0].trim().toLowerCase();
      return s || 'pyp';
    }

    function toItem(card) {
      var f = card.front || {};
      var skill = skillOf(card);
      var kind = skill === 'disputes' ? 'dispute' : skill === 'refunds' ? 'refund' : 'invoice';
      var label = kind === 'dispute' ? 'Disputes' : kind === 'refund' ? 'Refunds' : 'Invoices';
      var sending = card.state === 'executing';
      var state = card.state === 'awaiting_approval' ? 'open' : card.state === 'scheduled' || sending ? 'auto' : card.state === 'executed' ? 'done' : 'closed';
      var amount = f.amount ? money(f.amount.value, f.amount.currency) : '';
      var meta = f.subtitle || (f.lines && f.lines.length ? f.lines.map(function (l) { return l.description; }).join(', ') : shortDate(card.createdAt));

      var badge, box;
      if (state === 'open') {
        badge = { text: 'Needs you', tone: kind === 'dispute' ? 'amber' : 'blue' };
        box = {
          tone: kind === 'dispute' ? 'amber' : 'blue',
          eyebrow: f.options && f.options.length ? 'Pyp asks' : 'Pyp suggests',
          title: f.approveLabel || f.body || 'Review and approve',
          sub: notes[card.id] || f.reason || f.body || ''
        };
      } else if (sending) {
        badge = { text: 'Sending', tone: 'blue' };
        box = { tone: 'blue', eyebrow: 'Sending', title: 'Sending to PayPal…', sub: f.approveLabel || '' };
      } else if (state === 'auto') {
        badge = { text: 'Auto', tone: 'green' };
        box = { tone: 'green', eyebrow: 'Running on Auto', title: f.approveLabel || f.title, sub: f.reason || '' };
      } else if (state === 'done') {
        badge = { text: 'Done', tone: 'done' };
        box = { tone: 'green', eyebrow: 'Done', title: 'Sent through PayPal', sub: notes[card.id] || clock(card.createdAt) + ' · logged to activity' };
      } else {
        var word = STATUS[card.state] || card.state;
        badge = { text: word, tone: 'gray' };
        box = { tone: 'gray', eyebrow: word, title: card.state === 'failed' ? 'PayPal didn’t accept this' : card.state === 'obsolete' ? 'Not sent: things changed in PayPal' : 'Nothing was sent', sub: notes[card.id] || '' };
      }

      var buttons = busy[card.id]
        ? [{ id: 'noop', label: 'Sending…', style: 'primary', disabled: true }]
        : (card.actions || []).map(function (a) {
          // Answering a question and Undo aren't wired to the API yet.
          var wired = a.id === 'approve' || a.id === 'dismiss';
          return { id: a.id, label: a.label, style: a.style === 'danger' ? 'outline' : a.style, disabled: !wired };
        });
      if (state === 'done') buttons = [{ id: 'noop', label: 'Sent ✓', style: 'success', disabled: true }];

      var steps = (traces[card.id] && traces[card.id].steps) || [];
      return {
        id: card.id,
        kind: kind,
        skill: skill.charAt(0).toUpperCase() + skill.slice(1),
        label: label,
        state: state,
        cardState: card.state,
        createdAt: card.createdAt,
        badge: badge,
        title: f.title || 'Card',
        amount: amount, // '' when the card has no amount (a question): the card then shows no amount
        meta: meta,
        box: box,
        buttons: buttons,
        run: {
          id: String(card.id).slice(0, 4),
          date: shortDate(card.createdAt),
          steps: steps.length ? steps : [{ time: hms(card.createdAt), tag: 'Trigger', text: 'Loading the trace…' }],
          footer: steps.length + ' steps · from the engine’s trace'
        }
      };
    }

    function items() { return cards.map(toItem); }

    function emit() {
      var snapshot = items();
      listeners.forEach(function (fn) { try { fn(snapshot); } catch (e) { /* keep going */ } });
    }

    async function loadTrace(card) {
      var key = card.id + ':' + card.state;
      if (traces[card.id] && traces[card.id].key === key) return false;
      var r = await api('/api/cards/' + encodeURIComponent(card.id) + '/trace');
      if (!r.ok) {
        traces[card.id] = { key: key, steps: [] }; // don't refetch a failed trace on every poll
        return false;
      }
      traces[card.id] = {
        key: key,
        steps: (r.body.steps || []).map(function (s) {
          var tag = TAG[s.kind] || (s.kind ? s.kind.charAt(0).toUpperCase() + s.kind.slice(1) : 'Step');
          return { time: hms(s.at), tag: tag, text: (s.ok === true ? '✓ ' : s.ok === false ? '✗ ' : '') + s.label };
        })
      };
      return true;
    }

    async function refresh() {
      var r = await api('/api/cards');
      if (!r.ok) {
        loadError = r.body.error || 'The Inbox is unavailable (' + r.status + ').';
        throw new Error(loadError);
      }
      loadError = null;
      cards = r.body.cards || [];
      var json = JSON.stringify(cards);
      var changed = json !== lastJson;
      lastJson = json;
      if (changed) emit();
      // Traces come in the background; the card backs fill in as they arrive.
      Promise.all(cards.map(function (c) { return loadTrace(c).catch(function () { return false; }); })).then(function (got) {
        if (got.some(Boolean)) emit();
      });
      return cards;
    }

    var ready = refresh().catch(function (e) {
      loadError = loadError || 'Couldn’t reach Pyp: ' + e.message;
      console.warn('[Pyp live] first load failed:', e.message);
    });

    setInterval(function () {
      if (document.visibilityState === 'visible') refresh().catch(function () { /* try again next tick */ });
    }, POLL_MS);

    function openCount() { return items().filter(function (i) { return i.state === 'open' || i.state === 'auto'; }).length; }

    function greeting() {
      var h = new Date().getHours();
      return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    }

    async function act(id, action) {
      await ready;
      var card = cards.filter(function (c) { return c.id === id; })[0];
      if (!card) throw new Error('No card ' + id);
      if (action !== 'approve' && action !== 'dismiss') return toItem(card);
      if (action === 'approve' && local.paused) {
        notes[id] = 'Pyp is paused. Turn it back on in Setup to send this.';
        emit();
        return toItem(card);
      }
      busy[id] = true;
      emit();
      try {
        var r = await api('/api/cards/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
        notes[id] = r.body.message || r.body.error || (r.ok ? '' : 'Request failed (' + r.status + ')');
      } catch (e) {
        notes[id] = 'Couldn’t reach Pyp, so nothing was sent. Try again in a moment.';
      } finally {
        busy[id] = false;
        delete traces[id]; // a retry or failure adds trace steps without changing the state
        lastJson = '';
        await refresh().catch(function () { emit(); });
      }
      var after = cards.filter(function (c) { return c.id === id; })[0];
      return after ? toItem(after) : toItem(card);
    }

    return {
      name: 'live',
      isDemo: false,
      ready: ready,
      greet: async function () {
        await ready;
        var open = openCount();
        return 'Hi, I’m Pyp! I’m connected to your PayPal sandbox. ' +
          (open ? open + ' thing' + (open === 1 ? '' : 's') + ' need a look in your Inbox. ' : 'You’re all caught up. ') +
          'Try “Invoice PyP Test $450 for product photos, due in 30 days”.';
      },
      chat: async function (msg) {
        var text = ((msg && msg.text) || '').trim();
        if (msg && msg.attachment) return { text: 'I can’t read files or screenshots yet. Type what you need and I’ll look in PayPal.' };
        if (!text) return { text: 'Type what you need, like “Invoice PyP Test $300 for the logo, net 30”.' };
        var r = await api('/api/chat', { method: 'POST', body: JSON.stringify({ message: text.slice(0, 1000) }) });
        lastJson = '';
        refresh().catch(function () { /* the poll will catch up */ });
        if (!r.ok) return { text: r.body.error || 'Something went wrong on my side. Try again in a moment.' };
        return { text: r.body.reply || 'Done. Check your Inbox.' };
      },
      inbox: async function () {
        await ready;
        var all = items();
        // The inbox view reads this line once, so it mustn't depend on the cards.
        return {
          greeting: greeting(),
          summary: loadError || 'Here’s what Pyp is working on in your PayPal sandbox.',
          needLook: openCount(),
          items: all
        };
      },
      act: act,
      activity: async function () {
        await ready;
        return items().map(function (it) {
          var card = cards.filter(function (c) { return c.id === it.id; })[0];
          return {
            id: 'a-' + it.id,
            itemId: it.id,
            when: it.createdAt,
            skill: it.skill,
            action: it.title,
            target: it.meta,
            amount: it.amount || '—',
            who: card && card.state === 'rejected' ? 'You' : card && card.state === 'executed' ? 'Pyp' : '—',
            status: (card && STATUS[card.state]) || it.badge.text,
            run: it.run
          };
        });
      },
      brief: async function () {
        var end = new Date();
        var start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
        var iso = function (d) { return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); };
        var got = await Promise.all([
          read('/api/paypal/transactions?start_date=' + encodeURIComponent(iso(start)) + '&end_date=' + encodeURIComponent(iso(end)) + '&page=1&page_size=100', 'PayPal transaction data').catch(function () { return null; }),
          read('/api/paypal/invoices?page=1&page_size=100', 'PayPal invoice data').catch(function () { return null; }),
          read('/api/paypal/disputes?page=1&page_size=50', 'PayPal dispute data').catch(function () { return null; })
        ]);
        var tx = (got[0] && got[0].transactions) || [];
        var inv = (got[1] && got[1].invoices) || [];
        var dis = (got[2] && got[2].disputes) || [];
        var cur = (tx[0] && tx[0].currency) || (inv[0] && inv[0].currency) || 'USD';
        var inCur = function (x) { return !x.currency || x.currency === cur; }; // one currency per total
        var cents = function (v) { return Math.round(Number(v || 0) * 100); };
        // Money in: completed (S) incoming payments (T00xx event codes) only. Not denied, pending or
        // voided ones, and not balance corrections such as the sandbox's starting funds (T19xx).
        var received = tx.filter(function (t) { return t.status === 'S' && /^T00/.test(t.type || '') && cents(t.amount) > 0 && inCur(t); });
        var inCents = received.reduce(function (s, t) { return s + cents(t.amount); }, 0);
        var payments = received.length;
        var partial = !!(got[0] && got[0].totalItems > tx.length);
        // Same unpaid statuses as the Activity grid (activity-grid.js isOverdue).
        var unpaid = inv.filter(function (i) { return /^(SENT|UNPAID|PARTIALLY_PAID|MARKED_AS_PARTIALLY_PAID)$/.test(i.status) && inCur(i); });
        var dueCents = unpaid.reduce(function (s, i) { return s + cents(i.dueAmount != null ? i.dueAmount : i.amount); }, 0);
        var openDis = dis.filter(function (d) { return !/^(RESOLVED|CLOSED)$/.test(d.status); });
        var disCents = openDis.filter(inCur).reduce(function (s, d) { return s + cents(d.amount); }, 0);
        var needs = openCount();
        return {
          week: 'Week of ' + shortDate(start.toISOString()) + ' – ' + shortDate(end.toISOString()),
          stats: [
            { label: 'Money in', value: money(inCents / 100, cur), note: payments + ' completed payment' + (payments === 1 ? '' : 's') + ' in the last 7 days' + (partial ? ' (first 100 only)' : '') },
            { label: 'Unpaid invoices', value: money(dueCents / 100, cur), note: unpaid.length + ' invoice' + (unpaid.length === 1 ? '' : 's') + ' waiting on payment' },
            { label: 'Open disputes', value: String(openDis.length), note: openDis.length ? money(disCents / 100, cur) + ' in question' : 'Nothing open' },
            { label: 'Needs you', value: String(needs), note: needs ? 'cards waiting in your Inbox' : 'You’re all caught up' }
          ],
          summary: (got[0] ? money(inCents / 100, cur) + ' came in this week from ' + payments + ' payment' + (payments === 1 ? '' : 's') + '. ' : 'I couldn’t read this week’s transactions from PayPal. ') +
            (unpaid.length ? unpaid.length + ' invoice' + (unpaid.length === 1 ? ' is' : 's are') + ' still unpaid, ' + money(dueCents / 100, cur) + ' in total. ' : 'No invoices are waiting on payment. ') +
            (openDis.length ? openDis.length + ' dispute' + (openDis.length === 1 ? ' is' : 's are') + ' open.' : 'No open disputes.'),
          footnote: 'Built from your live PayPal sandbox data, in ' + cur + '. Code did every calculation; no AI wrote this one yet.'
        };
      },
      overview: function () { return read('/api/paypal/overview', 'PayPal overview'); },
      transactions: function (o) {
        o = o || {};
        var p = new URLSearchParams();
        if (o.startDate) p.set('start_date', o.startDate);
        if (o.endDate) p.set('end_date', o.endDate);
        p.set('page', String(o.page || 1));
        p.set('page_size', String(o.pageSize || 25));
        return read('/api/paypal/transactions?' + p.toString(), 'PayPal transaction data');
      },
      order: function (id) { return read('/api/paypal/orders/' + encodeURIComponent(id), 'PayPal order data'); },
      invoices: function (o) {
        o = o || {};
        return read('/api/paypal/invoices?' + new URLSearchParams({ page: String(o.page || 1), page_size: String(o.pageSize || 25) }).toString(), 'PayPal invoice data');
      },
      disputes: function (o) {
        o = o || {};
        return read('/api/paypal/disputes?' + new URLSearchParams({ page: String(o.page || 1), page_size: String(o.pageSize || 25) }).toString(), 'PayPal dispute data');
      },
      getSettings: function () { return clone(local.settings); },
      updateSettings: function (patch) {
        var skills = Object.assign({}, local.settings.skills, patch.skills || {});
        local.settings = Object.assign({}, local.settings, patch, { skills: skills });
        saveSettings(local);
        emit();
      },
      isPaused: function () { return !!local.paused; },
      setPaused: function (on) {
        local.paused = !!on;
        saveSettings(local);
        emit();
      },
      reset: function () { /* live data can't be reset from the browser */ },
      subscribe: function (fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (l) { return l !== fn; }); };
      },
      capture: async function () { await wait(0); return null; }
    };
  }

  root.PypLive = { createTransport: createLiveTransport };
})(typeof window !== 'undefined' ? window : globalThis);
