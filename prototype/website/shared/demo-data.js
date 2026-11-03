/*
 * Demo transport: everything Pyp shows comes through a "transport".
 * This one runs entirely in the browser on made-up DEMO DATA, so the UI works
 * with no server. The real backend only has to implement the same methods
 * (see prototype/README.md, "Plugging in the real API"):
 *
 *   ready                       Promise that resolves once saved state is loaded
 *   greet()                     -> Promise<string>
 *   chat({ text, attachment })  -> Promise<{ text }>
 *   inbox()                     -> Promise<{ greeting, summary, items }>
 *   act(itemId, action, data)   -> Promise<item>        approve | dismiss | restore | review | cancel | send | undo | timer-done
 *   activity()                  -> Promise<entry[]>     newest first
 *   brief()                     -> Promise<brief>
 *   overview()               -> Promise<overview>  (read-only sandbox data)
 *   transactions(options)       -> Promise<transactions> (read-only sandbox data)
 *   invoices(options)            -> Promise<invoices> (read-only sandbox data)
 *   disputes(options)            -> Promise<disputes> (read-only sandbox data)
 *   getSettings() / updateSettings(patch) / setPaused(bool) / isPaused()
 *   subscribe(fn)               -> unsubscribe()        fn(items) after every change
 *   capture()                   -> Promise<dataUrl|null>  screenshot (optional)
 *   reset()                     back to the starting demo data
 *
 * options.persist = { load(): Promise<state|null>, save(state), watch(cb) } keeps the
 * state in localStorage / chrome.storage, so every page and tab shares it.
 */
(function (root) {
  'use strict';

  var Policy = root.PypPolicy;
  var VERSION = 3;

  function clock(d) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function stamp(d) {
    return d.toTimeString().slice(0, 8);
  }
  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }
  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }
  function checksText(decision) {
    return decision.checks.map(function (c) { return c.text + (c.ok ? ' ✓' : ' ✗'); }).join(' · ');
  }

  var DEMO_SETTINGS = {
    skills: { collections: 'ask', disputes: 'ask', refunds: 'auto', insights: 'on' },
    reminders: 'ask',
    refundAutoLimit: 25,
    undoSeconds: 60,
    remindersPerDay: 2
  };

  function buildItems(settings) {
    var reminder = Policy.decide({ type: 'reminder', onMenu: true }, { status: 'UNPAID', remindersSentToday: 0 }, settings);
    var evidence = Policy.decide({ type: 'evidence' }, { disputeOpen: true }, settings);
    var refund = Policy.decide({ type: 'refund', amount: 18 }, { paid: 240, refunded: 0 }, settings);

    return [
      {
        id: 'inv-0042',
        kind: 'invoice',
        skill: 'Collections',
        label: 'Invoices',
        state: 'open',
        badge: { text: reminder.mode === 'auto' ? 'Auto' : 'Ask me', tone: 'blue' },
        title: 'Acme Studio is 9 days late',
        amount: '$1,200.00',
        meta: 'Invoice #0042 · due Oct 16',
        box: { tone: 'blue', eyebrow: 'Pyp suggests', title: 'Send a friendly reminder', sub: 'Acme usually pays within 3 days of a nudge' },
        buttons: [
          { id: 'approve', label: 'Approve', style: 'primary' },
          { id: 'dismiss', label: 'Dismiss', style: 'secondary' }
        ],
        run: {
          id: '7f3a', date: 'Oct 26',
          steps: [
            { time: '09:00:02', tag: 'Trigger', text: 'Morning check (daily schedule)' },
            { time: '09:00:03', tag: 'Read', text: 'Invoice #0042 from PayPal: unpaid, 9 days past due' },
            { time: '09:00:03', tag: 'Memory', text: 'Acme paid the last 3 invoices within 3 days of a reminder' },
            { time: '09:00:05', tag: 'AI', text: 'Proposed: send reminder, friendly tone' },
            { time: '09:00:05', tag: 'Check', text: checksText(reminder) },
            { time: '09:00:05', tag: 'Policy', text: reminder.policy }
          ],
          footer: '1 AI call · reminders today: 0 of ' + settings.remindersPerDay
        }
      },
      {
        id: 'dsp-1188',
        kind: 'dispute',
        skill: 'Disputes',
        label: 'Disputes',
        state: 'open',
        badge: { text: 'Needs you', tone: 'amber' },
        title: 'Buyer says “item not received”',
        amount: '$86.00',
        meta: 'Order PP-D-1188 · reply by Oct 31',
        box: { tone: 'amber', eyebrow: 'Pyp drafted', title: 'Send proof of delivery', sub: 'Tracking shows it was delivered Oct 20' },
        draft:
          'Hi, thanks for reaching out. Our records show this order shipped Oct 17 and was delivered Oct 20 ' +
          '(tracking 9400 1000 0000 0000 0000 00, left at front door). I’ve attached the carrier’s delivery ' +
          'confirmation. If it isn’t there, please check with neighbours or your building office and let me know.',
        buttons: [
          { id: 'review', label: 'Review', style: 'primary' },
          { id: 'dismiss', label: 'Dismiss', style: 'secondary' }
        ],
        run: {
          id: '9c12', date: 'Oct 25',
          steps: [
            { time: '11:30:10', tag: 'Trigger', text: 'PayPal event: dispute opened' },
            { time: '11:30:11', tag: 'Read', text: 'Order, payment and tracking: delivered Oct 20' },
            { time: '11:30:12', tag: 'Safety', text: 'Buyer’s message said “refund me now”. Treated as information, not an order' },
            { time: '11:30:16', tag: 'AI', text: 'Drafted evidence: proof of delivery' },
            { time: '11:30:16', tag: 'Check', text: checksText(evidence) + ' · deadline Oct 31' },
            { time: '11:30:16', tag: 'Policy', text: evidence.policy }
          ],
          footer: '1 AI call · nothing sent yet'
        }
      },
      {
        id: 'ref-beta',
        kind: 'refund',
        skill: 'Refunds',
        label: 'Refunds',
        state: refund.mode === 'auto' ? 'auto' : 'open',
        badge: { text: refund.mode === 'auto' ? 'Auto' : 'Ask me', tone: 'green' },
        title: 'Refunding Beta LLC’s shipping',
        amount: '$18.00',
        meta: 'of $240.00 · you asked in chat',
        box: { tone: 'green', eyebrow: 'Running on Auto', title: 'Within your $' + settings.refundAutoLimit + ' limit', sub: 'Goes through when the timer ends' },
        undoEndsAt: Date.now() + settings.undoSeconds * 1000,
        buttons: [{ id: 'undo', label: 'Undo', style: 'outline', countdown: true }],
        run: {
          id: 'b4e0', date: 'Oct 26',
          steps: [
            { time: '09:13:40', tag: 'Trigger', text: 'Chat: “refund Beta’s shipping”' },
            { time: '09:13:41', tag: 'Read', text: 'Payment of $240.00, no refunds yet' },
            { time: '09:13:43', tag: 'AI', text: 'Proposed: refund $18.00 (the shipping line)' },
            { time: '09:13:43', tag: 'Check', text: checksText(refund) },
            { time: '09:13:43', tag: 'Policy', text: refund.policy }
          ],
          footer: '1 AI call · logged to activity'
        }
      }
    ];
  }

  function seedActivity(items) {
    var overnight = [
      {
        id: 'a-0039', when: '2026-10-26T02:14:00', skill: 'Collections', action: 'Reminder sent', target: 'Invoice #0039 · Lumen Co', amount: '$450.00', who: 'Auto', status: 'Done',
        run: { id: '51c8', date: 'Oct 26', steps: [
          { time: '02:14:01', tag: 'Trigger', text: 'Overdue sweep' },
          { time: '02:14:02', tag: 'Read', text: 'Invoice #0039 unpaid, 5 days past due' },
          { time: '02:14:04', tag: 'AI', text: 'Proposed: send reminder, friendly tone' },
          { time: '02:14:04', tag: 'Check', text: 'On the menu ✓ · Live re-check: still unpaid ✓' },
          { time: '02:14:04', tag: 'Policy', text: 'Lumen Co is on your Auto list for reminders' },
          { time: '02:15:04', tag: 'Action', text: 'Reminder sent through PayPal after the undo window' }
        ], footer: '1 AI call' }
      },
      {
        id: 'a-0038', when: '2026-10-26T06:05:00', skill: 'Collections', action: 'Marked paid, thank-you sent', target: 'Invoice #0038 · Orchard & Co', amount: '$980.00', who: 'Auto', status: 'Done',
        run: { id: '6a2d', date: 'Oct 26', steps: [
          { time: '06:05:00', tag: 'Trigger', text: 'PayPal event: invoice paid' },
          { time: '06:05:01', tag: 'Read', text: 'Invoice #0038 paid in full' },
          { time: '06:05:02', tag: 'Policy', text: 'Thank-you notes are on Auto' },
          { time: '06:05:03', tag: 'Action', text: 'Thank-you note sent through PayPal' }
        ], footer: 'No AI call · template' }
      },
      {
        id: 'a-1102', when: '2026-10-26T07:40:00', skill: 'Disputes', action: 'Case closed in your favor', target: 'Order PP-D-1102', amount: '$64.00', who: 'PayPal', status: 'Done',
        run: { id: '3e91', date: 'Oct 26', steps: [
          { time: '07:40:00', tag: 'Trigger', text: 'PayPal event: dispute resolved' },
          { time: '07:40:01', tag: 'Read', text: 'Outcome: resolved in seller’s favor' },
          { time: '07:40:01', tag: 'Action', text: 'Logged. Nothing to send' }
        ], footer: 'No AI call' }
      },
      {
        id: 'a-brief', when: '2026-10-26T08:00:00', skill: 'Insights', action: 'Weekly brief ready', target: 'Week of Oct 19', amount: '—', who: 'Auto', status: 'Done',
        run: { id: '8b07', date: 'Oct 26', steps: [
          { time: '08:00:00', tag: 'Trigger', text: 'Weekly schedule' },
          { time: '08:00:03', tag: 'Read', text: '23 transactions, 2 overdue invoices, 1 open dispute' },
          { time: '08:00:05', tag: 'AI', text: 'Wrote the summary (code did all the maths)' }
        ], footer: '1 AI call' }
      }
    ];
    var fromCards = items.map(function (it) {
      return {
        id: 'a-' + it.id, itemId: it.id, when: it.id === 'dsp-1188' ? '2026-10-25T11:30:16' : it.id === 'ref-beta' ? '2026-10-26T09:13:43' : '2026-10-26T09:00:05',
        skill: it.skill, action: it.box.title, target: it.meta.split(' · ')[0] + (it.kind === 'invoice' ? ' · Acme Studio' : it.kind === 'refund' ? ' · Beta LLC' : ''),
        amount: it.amount, who: it.state === 'auto' ? 'Auto' : '—', status: it.state === 'auto' ? 'Undo window' : 'Waiting for you', run: it.run
      };
    });
    return fromCards.concat(overnight);
  }

  var BRIEF = {
    week: 'Week of Oct 19 – 25',
    stats: [
      { label: 'Money in', value: '$8,420.00', note: '23 payments · up 12% on last week' },
      { label: 'Overdue', value: '$1,650.00', note: '2 invoices · Acme Studio, Lumen Co' },
      { label: 'Open disputes', value: '1', note: '$86.00 · reply by Oct 31' },
      { label: 'Refunded', value: '$18.00', note: '1 refund · within your Auto limit' }
    ],
    summary:
      'A good week. Money in was up 12%, mostly from Orchard & Co’s $980.00 invoice. Two invoices are late: Acme Studio ' +
      'usually pays within 3 days of a reminder, so I’ve suggested one. The only open dispute has tracking that shows delivery, ' +
      'and I’ve drafted proof for you to review.',
    footnote: 'Pyp wrote the words; code did every calculation.'
  };

  var REPLIES = [
    { match: /track|payment status|where.*payment/i, text: 'Your most recent payment, $240.00 from Beta LLC, completed on Oct 22. Want me to show the details?' },
    { match: /refund/i, text: 'One refund is running: $18.00 back to Beta LLC for shipping. It’s within your $25 Auto limit, so it goes through when the timer ends. You can undo it in the Inbox.' },
    { match: /invoice|late|acme|owe/i, text: 'Acme Studio’s invoice #0042 for $1,200.00 is 9 days late. I drafted a friendly reminder. It’s waiting for your OK in the Inbox.' },
    { match: /dispute|not received|claim/i, text: 'A buyer says order PP-D-1188 never arrived, but tracking shows it was delivered Oct 20. I drafted proof of delivery for you to review in the Inbox. You have until Oct 31.' },
    { match: /brief|week|summary|how.*doing/i, text: 'This week: $8,420.00 in from 23 payments (up 12%), $1,650.00 overdue across 2 invoices, and 1 open dispute. The full brief is on your dashboard.' },
    { match: /send money|^send/i, text: 'Sure! Who are you sending to? You can type a name, email or phone number.' },
    { match: /something else|other/i, text: 'No problem! Type your question below, or tap + to share a screenshot or a photo.' },
    { match: /\b(hi|hello|hey)\b/i, text: 'Hi! Ask me about payments, invoices, refunds or disputes.' }
  ];

  function createDemoTransport(options) {
    options = options || {};
    var persist = options.persist || null;
    var userName = options.userName || 'Maya';
    var listeners = [];
    var state = freshState(options.settings);

    function freshState(settings) {
      var s = Object.assign({}, Policy.DEFAULT_SETTINGS, clone(DEMO_SETTINGS), settings || {});
      var items = buildItems(s);
      return { v: VERSION, settings: s, paused: false, items: items, activity: seedActivity(items) };
    }

    function emit() {
      var snapshot = state.items.slice();
      listeners.forEach(function (fn) { try { fn(snapshot); } catch (e) { /* a listener failed; keep going */ } });
    }

    function save() {
      if (persist) { try { persist.save(clone(state)); } catch (e) { /* storage full or blocked */ } }
    }

    function changed() {
      save();
      emit();
    }

    var ready = (persist ? Promise.resolve(persist.load()).catch(function () { return null; }) : Promise.resolve(null)).then(function (saved) {
      if (saved && saved.v === VERSION && Array.isArray(saved.items)) {
        state = saved;
        emit();
      } else if (persist) {
        save();
      }
    });

    if (persist && typeof persist.watch === 'function') {
      persist.watch(function (next) {
        if (next && next.v === VERSION && Array.isArray(next.items)) {
          state = next;
          emit();
        }
      });
    }

    function find(id) {
      for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
      return null;
    }

    function replace(id, next, activityPatch) {
      state.items = state.items.map(function (it) { return it.id === id ? next : it; });
      if (activityPatch) {
        state.activity = state.activity.map(function (a) {
          return a.itemId === id ? Object.assign({}, a, activityPatch, { run: next.run }) : a;
        });
      }
      changed();
      return next;
    }

    function addStep(item, tag, text) {
      return item.run.steps.concat([{ time: stamp(new Date()), tag: tag, text: text }]);
    }

    function doneState(item, text, sub, button) {
      return Object.assign({}, item, {
        state: 'done',
        badge: { text: 'Done', tone: 'done' },
        box: { tone: 'green', eyebrow: 'Done', title: text, sub: sub },
        buttons: [{ id: 'noop', label: button + ' ✓', style: 'success', disabled: true }],
        reviewing: false,
        undoEndsAt: null,
        pausedLeft: null
      });
    }

    function grayState(item, badge, text, sub, buttons) {
      return Object.assign({}, item, {
        state: 'closed',
        badge: { text: badge, tone: 'gray' },
        box: { tone: 'gray', eyebrow: badge, title: text, sub: sub },
        buttons: buttons || [],
        reviewing: false,
        undoEndsAt: null,
        pausedLeft: null
      });
    }

    async function act(id, action, data) {
      await ready;
      var item = find(id);
      if (!item) throw new Error('No item ' + id);
      var now = new Date();
      var nowIso = now.toISOString();
      var writes = { approve: 1, send: 1, 'timer-done': 1 };
      if (state.paused && writes[action]) return item; // nothing reaches PayPal while Pyp is paused

      if (action === 'approve' && item.kind === 'invoice') {
        replace(id, Object.assign({}, item, { buttons: [{ id: 'noop', label: 'Sending…', style: 'primary', disabled: true }, item.buttons[1]] }));
        await wait(900);
        var sent = doneState(item, 'Reminder sent through PayPal', clock(now) + ' · you approved · logged to activity', 'Sent');
        sent.run = Object.assign({}, item.run, { steps: addStep(item, 'Action', 'Reminder sent · you approved'), footer: '1 AI call · reminders today: 1 of ' + state.settings.remindersPerDay });
        return replace(id, sent, { action: 'Reminder sent', who: 'You approved', status: 'Done', when: nowIso });
      }

      if (action === 'review') {
        return replace(id, Object.assign({}, item, {
          reviewing: true,
          buttons: [
            { id: 'send', label: 'Send to PayPal', style: 'primary' },
            { id: 'cancel', label: 'Cancel', style: 'secondary' }
          ]
        }));
      }

      if (action === 'cancel') {
        return replace(id, Object.assign({}, item, {
          reviewing: false,
          buttons: [
            { id: 'review', label: 'Review', style: 'primary' },
            { id: 'dismiss', label: 'Dismiss', style: 'secondary' }
          ]
        }));
      }

      if (action === 'send') {
        var draft = (data && data.draft) || item.draft;
        replace(id, Object.assign({}, item, { draft: draft, buttons: [{ id: 'noop', label: 'Sending…', style: 'primary', disabled: true }] }));
        await wait(900);
        var ev = doneState(Object.assign({}, item, { draft: draft }), 'Evidence sent through PayPal', clock(now) + ' · you reviewed and sent', 'Sent');
        ev.run = Object.assign({}, item.run, { steps: addStep(item, 'Action', 'Evidence sent · you reviewed it first'), footer: '1 AI call · logged to activity' });
        return replace(id, ev, { action: 'Evidence sent', who: 'You approved', status: 'Done', when: nowIso });
      }

      if (action === 'undo') {
        var undone = grayState(item, 'Canceled', 'Refund canceled', 'Nothing was sent to Beta LLC');
        undone.run = Object.assign({}, item.run, { steps: addStep(item, 'Undo', 'You canceled before the timer ended') });
        return replace(id, undone, { action: 'Refund canceled', who: 'You', status: 'Canceled', when: nowIso });
      }

      if (action === 'timer-done') {
        if (item.state !== 'auto' || !item.undoEndsAt || Date.now() < item.undoEndsAt - 300) return item;
        var refunded = doneState(item, 'Refunded $18.00', clock(now) + ' · ran on Auto · logged to activity', 'Refunded');
        refunded.run = Object.assign({}, item.run, { steps: addStep(item, 'Action', 'Refund sent through PayPal after the undo window') });
        return replace(id, refunded, { action: 'Refund sent', who: 'Auto', status: 'Done', when: nowIso });
      }

      if (action === 'dismiss') {
        var dismissed = grayState(item, 'Dismissed', 'Dismissed', 'Nothing was sent', [{ id: 'restore', label: 'Restore', style: 'secondary' }]);
        dismissed.previous = item;
        dismissed.run = Object.assign({}, item.run, { steps: addStep(item, 'Dismiss', 'You dismissed this card') });
        return replace(id, dismissed, { who: 'You', status: 'Dismissed', when: nowIso });
      }

      if (action === 'restore' && item.previous) {
        return replace(id, item.previous, { who: '—', status: 'Waiting for you' });
      }

      return item;
    }

    function openCount() {
      return state.items.filter(function (i) { return i.state === 'open' || i.state === 'auto'; }).length;
    }

    return {
      name: 'demo',
      isDemo: true,
      ready: ready,
      greet: async function () {
        await ready;
        var open = openCount();
        return 'Hi, I’m Pyp! I keep an eye on your PayPal account. ' + (open ? open + ' thing' + (open === 1 ? '' : 's') + ' need a look in your Inbox.' : 'You’re all caught up.') + ' What can I help with?';
      },
      chat: async function (msg) {
        await wait(600);
        var text = (msg && msg.text) || '';
        var att = msg && msg.attachment;
        if (att && att.kind === 'screenshot') {
          return { text: 'Got the screenshot of this page. In demo mode I can’t read it yet. With the real backend I’d look at what’s on screen and answer about it.' };
        }
        if (att) {
          return { text: 'Thanks, I’ve got ' + (att.kind === 'image' ? 'your photo' : att.name) + '. In demo mode I can’t open files yet. This is where I’d answer about it.' };
        }
        for (var i = 0; i < REPLIES.length; i++) if (REPLIES[i].match.test(text)) return { text: REPLIES[i].text };
        return { text: 'I’m running on demo data, so I only know a few things. Try “late invoices”, “refund status” or “how was my week?”.' };
      },
      inbox: async function () {
        await ready;
        return {
          greeting: 'Good morning, ' + userName,
          summary: 'Pyp handled 4 things overnight.',
          needLook: openCount(),
          items: state.items.slice()
        };
      },
      act: act,
      activity: async function () {
        await ready;
        return state.activity.slice().sort(function (a, b) { return a.when < b.when ? 1 : -1; });
      },
      brief: async function () { await ready; return clone(BRIEF); },
      overview: async function () {
        var response = await fetch('http://localhost:3000/api/paypal/overview', {
          credentials: 'include',
          cache: 'no-store'
        });
        var body = await response.json();
        if (!response.ok) throw new Error(body.error || 'PayPal overview is unavailable.');
        return body;
      },
      transactions: async function (options) {
        options = options || {};
        var params = new URLSearchParams();
        if (options.startDate) params.set('start_date', options.startDate);
        if (options.endDate) params.set('end_date', options.endDate);
        params.set('page', String(options.page || 1));
        params.set('page_size', String(options.pageSize || 25));
        var response = await fetch('http://localhost:3000/api/paypal/transactions?' + params.toString(), {
          credentials: 'include',
          cache: 'no-store'
        });
        var body = await response.json();
        if (!response.ok) throw new Error(body.error || 'PayPal transaction data is unavailable.');
        return body;
      },
      order: async function (orderId) {
        var response = await fetch('http://localhost:3000/api/paypal/orders/' + encodeURIComponent(orderId), {
          credentials: 'include',
          cache: 'no-store'
        });
        var body = await response.json();
        if (!response.ok) throw new Error(body.error || 'PayPal order data is unavailable.');
        return body;
      },
      invoices: async function (options) {
        options = options || {};
        var params = new URLSearchParams({
          page: String(options.page || 1),
          page_size: String(options.pageSize || 25)
        });
        var response = await fetch('http://localhost:3000/api/paypal/invoices?' + params.toString(), {
          credentials: 'include',
          cache: 'no-store'
        });
        var body = await response.json();
        if (!response.ok) throw new Error(body.error || 'PayPal invoice data is unavailable.');
        return body;
      },
      disputes: async function (options) {
        options = options || {};
        var params = new URLSearchParams({
          page: String(options.page || 1),
          page_size: String(options.pageSize || 25)
        });
        var response = await fetch('http://localhost:3000/api/paypal/disputes?' + params.toString(), {
          credentials: 'include',
          cache: 'no-store'
        });
        var body = await response.json();
        if (!response.ok) throw new Error(body.error || 'PayPal dispute data is unavailable.');
        return body;
      },
      getSettings: function () { return clone(state.settings); },
      updateSettings: function (patch) {
        var skills = Object.assign({}, state.settings.skills, patch.skills || {});
        state.settings = Object.assign({}, state.settings, patch, { skills: skills });
        changed();
      },
      isPaused: function () { return !!state.paused; },
      setPaused: function (on) {
        on = !!on;
        if (on === state.paused) return;
        state.paused = on;
        var now = Date.now();
        state.items = state.items.map(function (it) {
          if (on && it.undoEndsAt) return Object.assign({}, it, { pausedLeft: Math.max(0, it.undoEndsAt - now), undoEndsAt: null });
          if (!on && it.pausedLeft != null) return Object.assign({}, it, { undoEndsAt: now + it.pausedLeft, pausedLeft: null });
          return it;
        });
        changed();
      },
      reset: function () {
        state = freshState(options.settings);
        changed();
      },
      subscribe: function (fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (l) { return l !== fn; }); };
      },
      capture: async function () { return null; }
    };
  }

  /* Ready-made "persist" adapters. */
  function localPersist(key) {
    key = key || 'pyp-demo-state';
    return {
      load: function () {
        try { return Promise.resolve(JSON.parse(localStorage.getItem(key) || 'null')); } catch (e) { return Promise.resolve(null); }
      },
      save: function (s) {
        try { localStorage.setItem(key, JSON.stringify(s)); } catch (e) { /* blocked */ }
      },
      watch: function (cb) {
        window.addEventListener('storage', function (e) {
          if (e.key !== key || !e.newValue) return;
          try { cb(JSON.parse(e.newValue)); } catch (err) { /* ignore bad data */ }
        });
      }
    };
  }

  function chromePersist(key) {
    key = key || 'pypDemoState';
    var last = '';
    return {
      load: function () {
        return chrome.storage.local.get(key).then(function (r) { return r[key] || null; });
      },
      save: function (s) {
        last = JSON.stringify(s);
        var o = {};
        o[key] = s;
        return chrome.storage.local.set(o);
      },
      watch: function (cb) {
        chrome.storage.onChanged.addListener(function (changes, area) {
          if (area !== 'local' || !changes[key] || !changes[key].newValue) return;
          var next = JSON.stringify(changes[key].newValue);
          if (next === last) return; // our own write
          last = next;
          cb(changes[key].newValue);
        });
      }
    };
  }

  root.PypDemo = { createTransport: createDemoTransport, localPersist: localPersist, chromePersist: chromePersist };
})(typeof window !== 'undefined' ? window : globalThis);
