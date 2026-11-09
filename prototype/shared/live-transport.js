/*
 * Live transport: the same methods as the demo transport (see the top of
 * demo-data.js), backed by the real Next.js API instead of made-up data.
 *
 *   inbox / act / activity   /api/cards, /api/cards/{id}/approve|dismiss|clear, /api/cards/{id}/trace
 *   chat                     /api/chat (the receptionist routes the sentence to a skill)
 *   overview … disputes      /api/paypal/* (read-only sandbox data)
 *   brief                    built here from /api/paypal/* and the cards (code does the maths)
 *
 * The page must be served from the same origin as the API (scripts/live-dashboard.mjs
 * on port 3001 does that), so the sign-in cookie rides along and no CORS is needed.
 * The Chrome extension instead passes { apiBase, fetch, onSignedOut, signedOutText }:
 * its fetch runs in the background worker, which may send the cookie to the server.
 *
 *   controls                 /api/rules, /api/kill-switch, /api/sweeps/{name}: the same
 *                            kill switch, dials and undo window as the server enforces
 *   answer / undo / edit     /api/cards/{id}/answer|undo, and approve with { edits }
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
    var busy = {};     // card id -> the action (approve/dismiss/clear) while it's in flight
    var notes = {};    // card id -> last message from approve/dismiss
    var local = loadSettings();
    var lastJson = '';
    var controls = null;  // the server's kill switch, undo window and dials (GET /api/rules)
    var editing = {};     // card id -> true while the merchant rewrites its text
    var loadSeq = 0;      // a slower, older /api/cards answer never overwrites a newer one
    var kicked = {};      // card id -> its undo window ended; we've asked for a fresh look
    var removing = {};    // card id -> "Remove from Inbox" sent; hidden while it's in flight
    var loadError = null; // why the last /api/cards load failed, shown instead of "all caught up"
    // This chat so far (this page only), sent with each message so Pyp follows up on what you said.
    var chatHistory = [];

    // The Chrome extension passes its own fetch, which goes through the background
    // worker so the sign-in cookie for the Pyp server rides along from paypal.com.
    var doFetch = options.fetch || function (url, init) { return fetch(url, init); };

    async function api(path, init) {
      var res = await doFetch(base + path, Object.assign({ credentials: 'include', cache: 'no-store' }, init || {}, {
        headers: Object.assign({ 'Content-Type': 'application/json' }, (init && init.headers) || {})
      }));
      if (res.status === 401 && typeof options.onSignedOut === 'function') {
        loadError = options.signedOutText || 'You’re signed out of Pyp.';
        options.onSignedOut();
        throw new Error(loadError);
      }
      if (res.status === 401 && options.onSignedOut !== false) {
        root.location.href = base + '/login'; // sign-in ends at /dashboard, which sends :3001 back to /app/
        throw new Error('Signed out');
      }
      var body = await res.json().catch(function () { return {}; });
      return { ok: res.ok, status: res.status, body: body };
    }

    // A file to /api/documents: multipart, so no JSON Content-Type header.
    async function uploadDocument(file, subject) {
      var form = new FormData();
      form.append('file', file, file.name || 'file');
      if (subject) form.append('subject', subject);
      var res = await doFetch(base + '/api/documents', { method: 'POST', body: form, credentials: 'include', cache: 'no-store' });
      var body = await res.json().catch(function () { return {}; });
      if (res.status === 401) throw new Error('You’re signed out of Pyp.');
      if (!body.document) throw new Error(body.error || 'Pyp couldn’t take that file (' + res.status + ').');
      return body;
    }
    // The chat's attachment: a chosen file, or a screenshot (a data: URL) turned into a PNG file.
    async function uploadForChat(att) {
      var file = att.file;
      if (!file && att.url && /^data:image\//.test(att.url)) {
        var blob = await (await fetch(att.url)).blob();
        file = new File([blob], 'screenshot.png', { type: blob.type || 'image/png' });
      }
      if (!file) throw new Error('I couldn’t get that file. Try attaching it again.');
      return uploadDocument(file, null);
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
      var kind = skill === 'disputes' ? 'dispute' : skill === 'refunds' ? 'refund' : skill === 'insights' ? 'insight' : skill === 'collections' ? 'invoice' : skill === 'workflows' ? 'workflow' : 'other';
      var label = kind === 'dispute' ? 'Disputes' : kind === 'refund' ? 'Refunds' : kind === 'insight' ? 'Weekly brief' : kind === 'invoice' ? 'Invoices' : kind === 'workflow' ? 'Workflow' : 'Pyp';
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
      } else if (state === 'done' && kind === 'insight') {
        // A brief only reads: show what it says and code's numbers, not "sent through PayPal".
        badge = { text: 'Brief', tone: 'green' };
        box = { tone: 'green', eyebrow: 'This week', title: f.body || f.title, sub: notes[card.id] || (f.lines || []).map(function (l) { return l.description + ': ' + l.amount; }).join(' · ') };
      } else if (state === 'done' && f.notice) {
        // A heads-up from a workflow: nothing was sent anywhere.
        badge = { text: 'Heads-up', tone: 'blue' };
        box = { tone: 'blue', eyebrow: 'Heads-up', title: f.body || f.title, sub: f.reason || '' };
      } else if (state === 'done' && /^You answered/.test(f.reason || '')) {
        // A question you answered: nothing went to PayPal.
        badge = { text: 'Answered', tone: 'green' };
        box = { tone: 'green', eyebrow: 'Answered', title: f.reason || 'You answered', sub: notes[card.id] || clock(card.updatedAt || card.createdAt) };
      } else if (state === 'done') {
        badge = { text: 'Done', tone: 'done' };
        box = { tone: 'green', eyebrow: 'Done', title: 'Sent through PayPal', sub: notes[card.id] || clock(card.createdAt) + ' · logged to activity' };
      } else {
        var word = STATUS[card.state] || card.state;
        badge = { text: word, tone: 'gray' };
        box = { tone: 'gray', eyebrow: word, title: card.state === 'failed' ? 'PayPal didn’t accept this' : card.state === 'obsolete' ? 'Not sent: things changed in PayPal' : 'Nothing was sent', sub: notes[card.id] || '' };
      }

      // The text the merchant may rewrite before Approve: the note or message (the card's body).
      var editField = state === 'open' && (f.edit || []).filter(function (e) { return e.field === 'note' || e.field === 'message' || e.field === 'reason'; })[0];
      var answerIndex = 0;
      var buttons = busy[card.id]
        ? [{ id: 'noop', label: busy[card.id] === 'clear' ? 'Removing…' : busy[card.id] === 'undo' ? 'Canceling…' : 'Sending…', style: 'primary', disabled: true }]
        : (card.actions || []).map(function (a) {
          // Each answer button carries which option it is: answer:0, answer:1, ...
          var id = a.id === 'answer' ? 'answer:' + answerIndex++ : a.id;
          // One look per role: the main action, an answer, a secondary step, or a quiet way out.
          // The box above already says what Approve does, so its button just says Approve.
          var role = a.id === 'approve' ? 'primary' : a.id === 'answer' ? 'choice' : a.id === 'undo' ? 'secondary' : 'quiet';
          return { id: id, label: a.id === 'approve' ? 'Approve' : a.label, style: role, countdown: a.id === 'undo' };
        });
      if (editField && !busy[card.id]) {
        // Edit sits right after Approve, before the quiet Dismiss.
        var at = buttons.findIndex(function (b) { return b.style === 'quiet'; });
        buttons.splice(at < 0 ? buttons.length : at, 0, { id: 'edit', label: 'Edit', style: 'secondary' });
      }
      // A finished card: the badge and box already say it was sent, so the only button is Remove.
      var reviewing = !!(editing[card.id] && editField && !busy[card.id]);
      if (reviewing) {
        buttons = [
          { id: 'send', label: 'Approve with my edits', style: 'primary' },
          { id: 'cancel-edit', label: 'Cancel', style: 'quiet' }
        ];
      }
      // A countdown only for an Auto action about to go out; a follow-up days away just says when.
      var due = card.state === 'scheduled' && f.scheduledFor ? Date.parse(f.scheduledFor) : NaN;
      var undoEndsAt = isFinite(due) && due - Date.now() < 15 * 60 * 1000 ? due : null;
      if (card.state === 'scheduled' && isFinite(due) && !undoEndsAt) {
        box.sub = (f.reason ? f.reason + ' ' : '') + 'Due ' + shortDate(f.scheduledFor) + '.';
      }

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
        undoEndsAt: undoEndsAt,
        reviewing: reviewing,
        draft: editField ? editField.value : '',
        draftField: editField ? editField.field : null,
        reviewNote: reviewing ? notes[card.id] || '' : '',
        run: {
          id: String(card.id).slice(0, 4),
          date: shortDate(card.createdAt),
          steps: steps.length ? steps : [{ time: hms(card.createdAt), tag: 'Trigger', text: 'Loading the trace…' }],
          footer: steps.length + ' steps · from the engine’s trace'
        }
      };
    }

    function items() { return cards.map(toItem); }
    // The Inbox leaves out cards the merchant removed from it; Activity still lists them.
    // A card being removed leaves at once; it comes back with a note if the server says no.
    function inboxItems() { return cards.filter(function (c) { return !c.clearedAt && !removing[c.id]; }).map(toItem); }

    function emit() {
      var snapshot = inboxItems();
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

    async function loadControls() {
      var r = await api('/api/rules');
      if (!r.ok) throw new Error(r.body.error || 'Your controls are unavailable.');
      controls = r.body;
      return controls;
    }

    async function refresh() {
      var seq = ++loadSeq;
      loadControls().then(emit, function () { /* keep the last known controls */ });
      var r = await api('/api/cards');
      if (seq !== loadSeq) return cards; // a newer load has started; its answer wins
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

    async function act(id, action, extra) {
      await ready;
      var card = cards.filter(function (c) { return c.id === id; })[0];
      if (!card) throw new Error('No card ' + id);
      if (action === 'edit' || action === 'cancel-edit') {
        editing[id] = action === 'edit';
        delete notes[id];
        emit();
        return toItem(card);
      }
      if (action === 'timer-done') {
        // The worker sends it on its next tick (every 15 s): look again shortly after.
        if (!kicked[id]) {
          kicked[id] = true;
          setTimeout(function () { lastJson = ''; refresh().catch(function () {}); }, 5000);
          setTimeout(function () { lastJson = ''; refresh().catch(function () {}); }, 20000);
        }
        return toItem(card);
      }
      var path = action;
      var body;
      if (/^answer:\d+$/.test(action)) {
        path = 'answer';
        body = JSON.stringify({ optionIndex: Number(action.split(':')[1]) });
      } else if (action === 'send') {
        // Approve with the merchant's words; the server checks them like the model's.
        var item = toItem(card);
        var draft = extra && extra.draft != null ? extra.draft : item.draft;
        path = 'approve';
        if (item.draftField && draft !== item.draft) {
          var edits = {};
          edits[item.draftField] = draft;
          body = JSON.stringify({ edits: edits });
        }
      } else if (['approve', 'dismiss', 'clear', 'undo'].indexOf(action) < 0) {
        return toItem(card);
      }
      busy[id] = path === 'answer' ? 'approve' : path;
      if (action === 'clear') removing[id] = true;
      emit();
      try {
        var r = await api('/api/cards/' + encodeURIComponent(id) + '/' + path, { method: 'POST', body: body });
        notes[id] = r.body.message || r.body.error || (r.ok ? '' : 'Request failed (' + r.status + ')');
        if (action === 'clear' && !r.ok) removing[id] = false;
        // Refused or paused: nothing was sent, so keep the merchant's words open to fix.
        if (r.body.status !== 'edit_rejected' && r.body.status !== 'paused') editing[id] = false;
      } catch (e) {
        notes[id] = action === 'clear' ? 'Couldn’t reach Pyp, so it’s still here. Try again in a moment.' : 'Couldn’t reach Pyp, so nothing was sent. Try again in a moment.';
        removing[id] = false;
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
      attachments: false, // Pyp can't read photos or screenshots yet: the chat hides its + menu
      ready: ready,
      lastError: function () { return loadError; },
      greet: async function () {
        await ready;
        if (loadError) return 'Hi, I’m Pyp! ' + loadError;
        var open = openCount();
        return 'Hi, I’m Pyp! I’m connected to your PayPal sandbox. ' +
          (open ? open + (open === 1 ? ' thing needs' : ' things need') + ' a look in your Inbox. ' : 'You’re all caught up. ') +
          'Try “Invoice PyP Test $450 for product photos, due in 30 days”.';
      },
      chat: async function (msg) {
        var text = ((msg && msg.text) || '').trim();
        var documentIds = [];
        var att = msg && msg.attachment;
        if (att) {
          // The extension's requests go through its background worker, which can't carry a file.
          if (options.fetch) return { text: 'Attach files in the Pyp dashboard for now: open it from the extension, then use + in the chat there.' };
          var up = await uploadForChat(att).catch(function (e) { return { error: e.message }; });
          if (up.error) return { text: up.error };
          if (up.document.status !== 'read') return { text: up.document.reason || 'I couldn’t use that file.' };
          documentIds.push(up.document.id);
          if (!text) text = 'Here’s a file. Tell me what it is, and do what it calls for.';
        }
        if (!text) return { text: 'Type what you need, like “Invoice PyP Test $300 for the logo, net 30”.' };
        var r;
        try {
          r = await api('/api/chat', { method: 'POST', body: JSON.stringify({ message: text.slice(0, 1000), history: chatHistory.slice(-8), documentIds: documentIds }) });
        } catch (e) {
          return { text: loadError || 'I couldn’t reach the Pyp server. Is it running?' };
        }
        lastJson = '';
        refresh().catch(function () { /* the poll will catch up */ });
        setTimeout(function () { lastJson = ''; refresh().catch(function () {}); }, 1500);
        if (!r.ok) return { text: r.body.error || 'Something went wrong on my side. Try again in a moment.' };
        var reply = r.body.reply || 'Done. Check your Inbox.';
        // The cards a line made go back with the history, so answering a question here closes its card.
        chatHistory.push({ from: 'merchant', text: text.slice(0, 1000) }, { from: 'pyp', text: reply.slice(0, 1000), waiting: r.body.waiting !== false, cardIds: (r.body.cardIds || []).slice(0, 5) });
        if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
        return { text: reply };
      },
      inbox: async function () {
        await ready;
        var all = inboxItems();
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
        var start = new Date(end.getTime() - 28 * 24 * 60 * 60 * 1000);
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
        var rateDis = dis.filter(inCur); // same currency as the payments it is divided by
        var buckets = [0, 1, 2, 3].map(function (index) {
          var bucketStart = new Date(start.getTime() + index * 7 * 24 * 60 * 60 * 1000);
          var bucketEnd = new Date(bucketStart.getTime() + 7 * 24 * 60 * 60 * 1000);
          var inBucket = function (isoDate) {
            var time = new Date(isoDate || '').getTime();
            return isFinite(time) && time >= bucketStart.getTime() && time < bucketEnd.getTime();
          };
          var paymentsInBucket = received.filter(function (t) { return inBucket(t.date); }).length;
          var disputesInBucket = rateDis.filter(function (d) { return inBucket(d.createdAt); });
          return {
            label: shortDate(bucketStart.toISOString()),
            payments: paymentsInBucket,
            disputes: disputesInBucket.length,
            // No payments that week means no rate, not 0% (a dispute often lands a week after its payment).
            rate: paymentsInBucket ? disputesInBucket.length / paymentsInBucket * 100 : null
          };
        });
        var reasons = [];
        dis.forEach(function (item) {
          var created = new Date(item.createdAt || '').getTime();
          var index = isFinite(created) ? Math.floor((created - start.getTime()) / (7 * 24 * 60 * 60 * 1000)) : -1;
          if (index < 0 || index > 3) return; // outside the 28 days: no empty row for it
          var reason = item.reasonLabel || item.reason || 'Unknown reason';
          var row = reasons.filter(function (candidate) { return candidate.reason === reason; })[0];
          if (!row) {
            row = { reason: reason, cells: [0, 0, 0, 0], disputeIds: [[], [], [], []], total: 0 };
            reasons.push(row);
          }
          row.cells[index] += 1;
          row.total += 1;
          row.disputeIds[index].push(item.id);
        });
        reasons.sort(function (a, b) { return b.total - a.total; }); // busiest reasons first
        // PayPal's disputes list doesn't always report a total, so a full page may mean more exist.
        var disPartial = !!(got[2] && (got[2].totalItems > dis.length || dis.length >= 50));
        var trendPartial = partial && disPartial ? 'Based on the first 100 payments and the first 50 PayPal disputes.'
          : partial ? 'Based on the first 100 payments, so rates may read high.'
          : disPartial ? 'Based on the first 50 PayPal disputes.' : '';
        var needs = openCount();
        return {
          week: 'Dispute trends · ' + shortDate(start.toISOString()) + ' – ' + shortDate(end.toISOString()),
          stats: [
            { label: 'Money in', value: money(inCents / 100, cur), note: payments + ' completed payment' + (payments === 1 ? '' : 's') + ' in the last 28 days' + (partial ? ' (first 100 only)' : '') },
            { label: 'Unpaid invoices', value: money(dueCents / 100, cur), note: unpaid.length + ' invoice' + (unpaid.length === 1 ? '' : 's') + ' waiting on payment' },
            { label: 'Open disputes', value: String(openDis.length), note: openDis.length ? money(disCents / 100, cur) + ' in question' : 'Nothing open' },
            { label: 'Needs you', value: String(needs), note: needs ? 'cards waiting in your Inbox' : 'You’re all caught up' }
          ],
          summary: (got[0] ? money(inCents / 100, cur) + ' came in over the last 28 days from ' + payments + ' payment' + (payments === 1 ? '' : 's') + '. ' : 'I couldn’t read the last 28 days of transactions from PayPal. ') +
            (unpaid.length ? unpaid.length + ' invoice' + (unpaid.length === 1 ? ' is' : 's are') + ' still unpaid, ' + money(dueCents / 100, cur) + ' in total. ' : 'No invoices are waiting on payment. ') +
            (openDis.length ? openDis.length + ' dispute' + (openDis.length === 1 ? ' is' : 's are') + ' open.' : 'No open disputes.'),
          footnote: 'Built from your live PayPal sandbox data, in ' + cur + '. Code did every calculation; no AI wrote this one yet.',
          trends: { buckets: buckets, reasons: reasons.slice(0, 8), partial: trendPartial }
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
      // What Pyp knows about the business (/api/facts): case-file notes, never sent to clients.
      facts: function () { return read('/api/facts', 'About my business'); },
      saveFact: async function (f, id) {
        var r = await api('/api/facts' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PATCH' : 'POST', body: JSON.stringify(f) });
        if (!r.ok) throw new Error(r.body.error || 'Couldn\u2019t save that (' + r.status + ').');
        return r.body.fact;
      },
      // One answer in the business profile (null clears it).
      setProfile: async function (key, value) {
        var r = await api('/api/facts/profile', { method: 'PUT', body: JSON.stringify({ key: key, value: value }) });
        if (!r.ok) throw new Error(r.body.error || 'Couldn\u2019t save that (' + r.status + ').');
        return r.body.fact;
      },
      deleteFact: async function (id) {
        var r = await api('/api/facts/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!r.ok) throw new Error(r.body.error || 'Couldn\u2019t forget that (' + r.status + ').');
      },
      // The merchant's workflows (/api/workflows). A workflow only shapes how Pyp proposes.
      workflows: async function () {
        var r = await api('/api/workflows');
        if (!r.ok && !r.body.catalog) throw new Error(r.body.error || 'Your workflows are unavailable (' + r.status + ').');
        return { workflows: r.body.workflows || [], catalog: r.body.catalog, error: r.ok ? null : r.body.error };
      },
      saveWorkflow: async function (w, id) {
        var r = await api('/api/workflows' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PUT' : 'POST', body: JSON.stringify(w) });
        if (!r.ok) throw new Error(r.body.error || 'Couldn’t save that workflow (' + r.status + ').');
        return r.body;
      },
      deleteWorkflow: async function (id) {
        var r = await api('/api/workflows/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!r.ok) throw new Error(r.body.error || 'Couldn’t delete that workflow (' + r.status + ').');
      },
      runWorkflow: async function (id) {
        var r = await api('/api/workflows/' + encodeURIComponent(id) + '/run', { method: 'POST' });
        lastJson = '';
        await refresh().catch(function () { emit(); });
        if (!r.ok) throw new Error(r.body.message || r.body.error || 'The workflow didn’t run (' + r.status + ').');
        return r.body;
      },
      // Files Pyp reads (/api/documents): on a dispute or invoice, what a file shows becomes a note
      // Pyp can cite there. Uploading never sends anything anywhere.
      documents: function (subject) { return read('/api/documents' + (subject ? '?subject=' + encodeURIComponent(subject) : ''), 'Your files'); },
      uploadDocument: function (file, subject) { return uploadDocument(file, subject); },
      deleteDocument: async function (id) {
        var r = await api('/api/documents/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!r.ok) throw new Error(r.body.error || 'Couldn’t remove that file (' + r.status + ').');
      },
      // The merchant's custom skills (/api/skills): Pyp's judgment, their way. Run now
      // makes cards like any run; Try it and drafting save nothing and send nothing.
      skills: async function () {
        var r = await api('/api/skills');
        if (!r.ok && !r.body.catalog) throw new Error(r.body.error || 'Your skills are unavailable (' + r.status + ').');
        return { skills: r.body.skills || [], catalog: r.body.catalog, timeZone: r.body.timeZone || '', error: r.ok ? null : r.body.error };
      },
      saveSkill: async function (s, id) {
        var r = await api('/api/skills' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PUT' : 'POST', body: JSON.stringify(s) });
        if (!r.ok) throw new Error(r.body.error || 'Couldn’t save that skill (' + r.status + ').');
        return r.body;
      },
      deleteSkill: async function (id) {
        var r = await api('/api/skills/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!r.ok) throw new Error(r.body.error || 'Couldn’t delete that skill (' + r.status + ').');
      },
      runSkill: async function (id) {
        var r = await api('/api/skills/' + encodeURIComponent(id) + '/run', { method: 'POST' });
        lastJson = '';
        await refresh().catch(function () { emit(); });
        if (!r.ok) throw new Error(r.body.message || r.body.error || 'The skill didn’t run (' + r.status + ').');
        return r.body;
      },
      trySkill: async function (id) {
        var r = await api('/api/skills/' + encodeURIComponent(id) + '/try', { method: 'POST' });
        if (!r.ok && r.status !== 409) throw new Error(r.body.message || r.body.error || 'Couldn’t try the skill (' + r.status + ').');
        if (r.status === 409 && r.body.status === 'busy') throw new Error(r.body.message);
        return r.body;
      },
      draftSkill: async function (description) {
        var r = await api('/api/skills/draft', { method: 'POST', body: JSON.stringify({ description: description }) });
        if (!r.ok) throw new Error(r.body.error || 'Pyp couldn’t draft that (' + r.status + ').');
        return r.body;
      },
      // Pyp's own client list (/api/clients). Saving a client never touches PayPal.
      clients: function () { return read('/api/clients', 'Your clients'); },
      saveClient: async function (c, id) {
        var r = await api('/api/clients' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PATCH' : 'POST', body: JSON.stringify(c) });
        if (!r.ok) throw new Error(r.body.error || 'Couldn’t save that client (' + r.status + ').');
        return r.body.client;
      },
      deleteClient: async function (id) {
        var r = await api('/api/clients/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!r.ok) throw new Error(r.body.error || 'Couldn’t remove that client (' + r.status + ').');
      },
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
      // The kill switch is the server's: it stops Approve, Auto actions and sweeps everywhere.
      isPaused: function () { return !!(controls && controls.killSwitch); },
      setPaused: async function (on) {
        var r = await api('/api/kill-switch', { method: 'POST', body: JSON.stringify({ on: !!on }) });
        if (!r.ok) throw new Error(r.body.error || 'Couldn’t pause or resume Pyp (' + r.status + ').');
        controls = r.body;
        lastJson = '';
        await refresh().catch(function () { emit(); });
        return controls.killSwitch;
      },
      controls: async function () { return controls || loadControls(); },
      setDial: async function (commandId, dial) {
        var dials = {};
        dials[commandId] = dial;
        var r = await api('/api/rules', { method: 'PUT', body: JSON.stringify({ dials: dials }) });
        if (!r.ok) throw new Error(r.body.error || 'Couldn’t save that (' + r.status + ').');
        controls = r.body;
        emit();
        return controls;
      },
      setUndoSeconds: async function (seconds) {
        var r = await api('/api/rules', { method: 'PUT', body: JSON.stringify({ undoSeconds: seconds }) });
        if (!r.ok) throw new Error(r.body.error || 'Couldn’t save that (' + r.status + ').');
        controls = r.body;
        emit();
        return controls;
      },
      runSweep: async function (name) {
        var r = await api('/api/sweeps/' + encodeURIComponent(name), { method: 'POST' });
        lastJson = '';
        await refresh().catch(function () { emit(); });
        if (!r.ok) throw new Error(r.body.message || r.body.error || 'The check didn’t run (' + r.status + ').');
        return r.body;
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
