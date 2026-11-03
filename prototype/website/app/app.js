// Pyp dashboard (UI preview on demo data).
// Pages: Overview, Transactions, Inbox, Activity, Weekly brief, Setup.
// All data comes from one demo transport saved in localStorage, shared with the
// landing page and with other open tabs. To use the real API, replace `transport`.
(function () {
  'use strict';

  var Fig = window.PypFigure;

  var transport = window.PypDemo.createTransport({ persist: window.PypDemo.localPersist() });
  var view = document.getElementById('view');
  var title = document.getElementById('page-title');
  var toastEl = document.querySelector('.toast');
  var widget = null;
  var inboxHandle = null;
  var cleanup = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fig(sel, opts) {
    document.querySelectorAll('[data-fig="' + sel + '"]').forEach(function (el) {
      el.innerHTML = Fig.svg(Object.assign({ label: '' }, opts));
    });
  }
  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2600);
  }
  function fmtWhen(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function isOpen(i) { return i.state === 'open' || i.state === 'auto'; }

  document.querySelector('[data-signout]').addEventListener('click', function () {
    if (widget) { widget.destroy(); widget = null; }
    window.location.href = 'http://localhost:3000/login';
  });

  /* ---------------- shell ---------------- */
  function startApp() {
    fig('brand', { size: 30, mode: 'idle' });
    if (!widget) widget = window.PypWidget.mount({ transport: transport, right: 24, bottom: 24 });
    route();
  }

  function updateChrome(items) {
    var n = items.filter(isOpen).length;
    document.querySelector('[data-navcount]').textContent = n ? String(n) : '';
    document.querySelector('[data-pausepill]').hidden = !transport.isPaused();
  }
  transport.subscribe(updateChrome);
  transport.inbox().then(function (d) { updateChrome(d.items); });

  var PAGES = {
    overview: { title: 'Overview', render: renderOverview },
    transactions: { title: 'Transactions', render: renderTransactions },
    invoices: { title: 'Invoices', render: renderInvoices },
    inbox: { title: 'Inbox', render: renderInbox },
    activity: { title: 'Activity', render: renderActivity },
    brief: { title: 'Weekly brief', render: renderBrief },
    setup: { title: 'Setup', render: renderSetup }
  };

  function route() {
    var name = (location.hash.replace(/^#\/?/, '') || 'inbox').split('?')[0];
    if (!PAGES[name]) name = 'inbox';
    cleanup.forEach(function (fn) { fn(); });
    cleanup = [];
    if (inboxHandle) { inboxHandle.destroy(); inboxHandle = null; }
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      if (a.getAttribute('data-nav') === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    title.textContent = PAGES[name].title;
    document.title = PAGES[name].title + ' · Pyp';
    view.innerHTML = '';
    PAGES[name].render();
  }
  window.addEventListener('hashchange', function () {
    route();
    document.getElementById('main').focus({ preventScroll: true });
  });

  /* ---------------- Inbox ---------------- */
  var INBOX_TABS = [
    { id: 'needs', label: 'Needs you', fn: function (i) { return i.state === 'open'; }, empty: 'Nothing needs you right now.' },
    { id: 'auto', label: 'Running on Auto', fn: function (i) { return i.state === 'auto'; }, empty: 'Nothing is running on Auto right now.' },
    { id: 'done', label: 'Done', fn: function (i) { return i.state === 'done' || i.state === 'closed'; }, empty: 'Nothing finished yet today.' },
    { id: 'all', label: 'All', fn: null, empty: 'No cards.' }
  ];
  var inboxTab = 'all';

  function renderOverview() {
    view.innerHTML = '<section class="panel"><div class="loading">Loading sandbox business data…</div></section>';
    transport.overview().then(function (data) {
      var balance = data.balances && data.balances[0];
      var currency = balance ? balance.currency : 'USD';
      var available = balance ? balance.available : 'Unavailable';
      var rows = (data.recentTransactions || []).map(function (item) {
        return '<tr><td>' + esc(fmtWhen(item.date)) + '</td><td>' + esc(item.subject || 'Unknown') +
          '</td><td title="' + esc(item.type) + '">' + esc(item.typeLabel || item.type) + '</td><td title="' + esc(item.status) + '">' + esc(item.statusLabel || item.status) + '</td><td class="num">' +
          esc(item.amount == null ? '—' : currency + ' ' + item.amount) + '</td></tr>';
      }).join('');
      view.innerHTML =
        '<section class="panel"><h2>Sandbox business overview</h2><p>Read-only data from your connected PayPal sandbox merchant.</p>' +
        '<div class="stats overview-stats">' +
        '<div class="stat"><span>Available balance</span><b>' + esc(available === 'Unavailable' ? available : currency + ' ' + available) + '</b><small>Current sandbox balance</small></div>' +
        '<div class="stat"><span>Transactions</span><b>' + esc(String(data.transactionCount)) + '</b><small>In the last 30 days</small></div>' +
        '<div class="stat"><span>Environment</span><b>' + esc(data.environment) + '</b><small>PayPal data source</small></div>' +
        '</div></section>' +
        '<section class="panel"><h2>Recent transactions</h2>' +
        (rows ? '<div class="tablewrap"><table><thead><tr><th>When</th><th>Customer</th><th>Type</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>' + rows + '</tbody></table></div>' :
          '<div class="empty">No transactions were returned for the selected period.</div>') +
        '<p class="note">This view only reads PayPal data. Pyp does not change your sandbox account here.</p></section>';
    }).catch(function (error) {
      view.innerHTML = '<section class="panel"><h2>Overview unavailable</h2><p class="setup-error">' + esc(error.message) + '</p><p class="note">Confirm the Next.js server is running on port 3000 and the sandbox connection check succeeds.</p></section>';
    });
  }

  function isoDateStart(value) {
    return value + 'T00:00:00Z';
  }
  function isoDateEnd(value) {
    var date = new Date(value + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  function inputDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function renderTransactions() {
    var end = new Date();
    var start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 30);
    var page = 1;
    var pageSize = 25;
    view.innerHTML =
      '<section class="panel"><h2>PayPal transactions</h2><p>Read-only transaction search for your connected sandbox merchant.</p>' +
      '<form class="filters transaction-filters" data-transaction-form>' +
      '<label>From<input type="date" name="start" value="' + inputDate(start) + '" required></label>' +
      '<label>To<input type="date" name="end" value="' + inputDate(end) + '" required></label>' +
      '<button class="btn" type="submit">Apply dates</button></form>' +
      '<div data-transaction-results><div class="loading">Loading transactions…</div></div></section>';

    var form = view.querySelector('[data-transaction-form]');
    var results = view.querySelector('[data-transaction-results]');

    function loadTransactions() {
      var values = new FormData(form);
      results.innerHTML = '<div class="loading">Loading transactions…</div>';
      transport.transactions({
        startDate: isoDateStart(values.get('start')),
        endDate: isoDateEnd(values.get('end')),
        page: page,
        pageSize: pageSize
      }).then(function (data) {
        var rows = (data.transactions || []).map(function (item) {
          var amount = item.amount == null ? '—' : (item.currency || '') + ' ' + item.amount;
          return '<tr><td>' + esc(fmtWhen(item.date)) + '</td><td>' + esc(item.subject || 'Unknown') +
            '</td><td><span title="' + esc(item.type) + '">' + esc(item.typeLabel || item.type) + '</span></td>' +
            '<td><span class="status status-' + esc(item.status) + '" title="' + esc(item.status) + '">' + esc(item.statusLabel || item.status) + '</span></td>' +
            '<td class="num">' + esc(amount) + '</td><td class="transaction-id" title="' + esc(item.id) + '">' + esc(item.id) + '</td></tr>';
        }).join('');
        var totalPages = data.totalPages || 1;
        results.innerHTML =
          '<div class="transaction-summary">' + esc(String(data.totalItems)) + ' transaction' + (data.totalItems === 1 ? '' : 's') + ' found</div>' +
          (rows ? '<div class="tablewrap"><table><thead><tr><th>When</th><th>Customer</th><th>Type</th><th>Status</th><th class="num">Amount</th><th>Transaction ID</th></tr></thead><tbody>' + rows + '</tbody></table></div>' :
            '<div class="empty">No transactions were returned for these dates.</div>') +
          '<div class="pagination"><button class="btn btn-ghost" type="button" data-page-prev ' + (page <= 1 ? 'disabled' : '') + '>Previous</button><span>Page ' + esc(String(page)) + ' of ' + esc(String(totalPages)) + '</span><button class="btn btn-ghost" type="button" data-page-next ' + (page >= totalPages ? 'disabled' : '') + '>Next</button></div>' +
          '<p class="note">PayPal transaction reporting can lag behind sandbox activity. Codes remain available in each row’s tooltip.</p>';
        results.querySelector('[data-page-prev]').addEventListener('click', function () { page -= 1; loadTransactions(); });
        results.querySelector('[data-page-next]').addEventListener('click', function () { page += 1; loadTransactions(); });
      }).catch(function (error) {
        results.innerHTML = '<p class="setup-error">' + esc(error.message) + '</p><p class="note">Choose a date range of 31 days or less and confirm the sandbox connection check succeeds.</p>';
      });
    }

    function renderInvoices() {
      var page = 1;
      var pageSize = 25;
      view.innerHTML = '<section class="panel"><h2>PayPal invoices</h2><p>Read-only invoices from your connected sandbox merchant.</p><div data-invoice-results><div class="loading">Loading invoices…</div></div></section>';
      var results = view.querySelector('[data-invoice-results]');

      function loadInvoices() {
        results.innerHTML = '<div class="loading">Loading invoices…</div>';
        transport.invoices({ page: page, pageSize: pageSize }).then(function (data) {
          var rows = (data.invoices || []).map(function (item) {
            var amount = item.amount == null ? '—' : (item.currency || '') + ' ' + item.amount;
            var due = item.dueAmount == null ? '—' : (item.currency || '') + ' ' + item.dueAmount;
            return '<tr><td>' + esc(item.number || item.id) + '</td><td>' + esc(item.recipient || 'Unknown') +
              '</td><td>' + esc(item.date || '—') + '</td><td>' + esc(item.dueDate || '—') + '</td>' +
              '<td><span class="status status-' + esc(item.status) + '" title="' + esc(item.status) + '">' + esc(item.statusLabel || item.status) + '</span></td>' +
              '<td class="num">' + esc(amount) + '</td><td class="num">' + esc(due) + '</td></tr>';
          }).join('');
          var totalPages = data.totalPages || 1;
          results.innerHTML =
            '<div class="transaction-summary">' + esc(String(data.totalItems)) + ' invoice' + (data.totalItems === 1 ? '' : 's') + ' found</div>' +
            (rows ? '<div class="tablewrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Issued</th><th>Due</th><th>Status</th><th class="num">Amount</th><th class="num">Due amount</th></tr></thead><tbody>' + rows + '</tbody></table></div>' :
              '<div class="empty">No invoices were returned.</div>') +
            '<div class="pagination"><button class="btn btn-ghost" type="button" data-page-prev ' + (page <= 1 ? 'disabled' : '') + '>Previous</button><span>Page ' + esc(String(page)) + ' of ' + esc(String(totalPages)) + '</span><button class="btn btn-ghost" type="button" data-page-next ' + (page >= totalPages ? 'disabled' : '') + '>Next</button></div>' +
            '<p class="note">This view only reads PayPal data. Pyp does not create, send, cancel, or update invoices here.</p>';
          results.querySelector('[data-page-prev]').addEventListener('click', function () { page -= 1; loadInvoices(); });
          results.querySelector('[data-page-next]').addEventListener('click', function () { page += 1; loadInvoices(); });
        }).catch(function (error) {
          results.innerHTML = '<p class="setup-error">' + esc(error.message) + '</p><p class="note">Confirm the PayPal app has Invoicing access enabled, then retry.</p>';
        });
      }
      loadInvoices();
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      page = 1;
      loadTransactions();
    });
    loadTransactions();
  }

  function renderInbox() {
    view.innerHTML =
      '<div class="tabs" role="group" aria-label="Filter cards">' +
      INBOX_TABS.map(function (t) {
        return '<button type="button" data-itab="' + t.id + '" aria-pressed="' + (t.id === inboxTab) + '">' + t.label + ' <span class="n" data-icount="' + t.id + '"></span></button>';
      }).join('') + '</div><div id="inbox-host"></div>';

    var tab = INBOX_TABS.filter(function (t) { return t.id === inboxTab; })[0];
    inboxHandle = window.PypInbox.mount(document.getElementById('inbox-host'), transport, { layout: 'grid', filter: tab.fn, emptyText: tab.empty });

    function counts(items) {
      INBOX_TABS.forEach(function (t) {
        var el = view.querySelector('[data-icount="' + t.id + '"]');
        if (el) el.textContent = String(t.fn ? items.filter(t.fn).length : items.length);
      });
    }
    transport.inbox().then(function (d) { counts(d.items); });
    cleanup.push(transport.subscribe(counts));

    view.querySelector('.tabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-itab]');
      if (!b) return;
      inboxTab = b.getAttribute('data-itab');
      view.querySelectorAll('[data-itab]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      var t = INBOX_TABS.filter(function (x) { return x.id === inboxTab; })[0];
      inboxHandle.setFilter(t.fn, t.empty);
    });
  }

  /* ---------------- Activity ---------------- */
  function statusClass(s) {
    if (/^Done/.test(s)) return 'st-Done';
    if (/Waiting/.test(s)) return 'st-Waiting';
    if (/Undo/.test(s)) return 'st-Undo';
    if (/Canceled/.test(s)) return 'st-Canceled';
    return 'st-Dismissed';
  }

  function renderActivity() {
    view.innerHTML =
      '<div class="filters">' +
      '<label>Search<input type="search" data-q placeholder="Customer, invoice, order…"></label>' +
      '<label>Skill<select data-skill><option value="">All skills</option><option>Collections</option><option>Disputes</option><option>Refunds</option><option>Insights</option></select></label>' +
      '<label>Status<select data-status><option value="">Any status</option><option>Done</option><option>Waiting for you</option><option>Undo window</option><option>Canceled</option><option>Dismissed</option></select></label>' +
      '</div>' +
      '<div class="tablewrap"><table><caption class="sr" style="position:absolute;left:-9999px">Everything Pyp has done or proposed</caption>' +
      '<thead><tr><th scope="col">When</th><th scope="col">Skill</th><th scope="col">What happened</th><th scope="col">For</th><th scope="col" class="num">Amount</th><th scope="col">Who</th><th scope="col">Status</th></tr></thead>' +
      '<tbody data-rows></tbody></table></div>' +
      '<p class="note">Click a row to see every step. (The real dashboard uses AG Grid here; this is a plain table with the same columns.)</p>';

    var rows = [];
    var q = view.querySelector('[data-q]');
    var sk = view.querySelector('[data-skill]');
    var st = view.querySelector('[data-status]');

    function draw() {
      var term = q.value.trim().toLowerCase();
      var shown = rows.filter(function (r) {
        if (sk.value && r.skill !== sk.value) return false;
        if (st.value && r.status !== st.value) return false;
        if (term && (r.action + ' ' + r.target + ' ' + r.skill + ' ' + r.amount).toLowerCase().indexOf(term) < 0) return false;
        return true;
      });
      view.querySelector('[data-rows]').innerHTML = shown.length ? shown.map(function (r) {
        var cell = function (content, cls) { return '<td' + (cls ? ' class="' + cls + '"' : '') + '><button type="button" data-row="' + esc(r.id) + '">' + content + '</button></td>'; };
        return '<tr>' + cell(esc(fmtWhen(r.when))) + cell(esc(r.skill)) + cell('<b>' + esc(r.action) + '</b>') + cell(esc(r.target)) +
          cell(esc(r.amount), 'num') + cell(esc(r.who)) + cell('<span class="status ' + statusClass(r.status) + '">' + esc(r.status) + '</span>') + '</tr>';
      }).join('') : '<tr><td colspan="7"><div class="empty">No activity matches those filters.</div></td></tr>';
    }

    function load() { transport.activity().then(function (a) { rows = a; draw(); }); }
    load();
    cleanup.push(transport.subscribe(load));
    [q, sk, st].forEach(function (el) { el.addEventListener('input', draw); });

    view.querySelector('[data-rows]').addEventListener('click', function (e) {
      var b = e.target.closest('[data-row]');
      if (!b) return;
      var r = rows.filter(function (x) { return x.id === b.getAttribute('data-row'); })[0];
      if (r) openDrawer(r, b);
    });
  }

  function openDrawer(r, opener) {
    var d = document.createElement('div');
    d.className = 'drawer';
    d.innerHTML =
      '<section class="sheet" role="dialog" aria-modal="true" aria-labelledby="dr-t">' +
      '<div class="sheethead"><h2 id="dr-t">' + esc(r.action) + '</h2><button type="button" data-close aria-label="Close"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg></button></div>' +
      '<dl class="kv"><dt>When</dt><dd>' + esc(fmtWhen(r.when)) + '</dd><dt>Skill</dt><dd>' + esc(r.skill) + '</dd><dt>For</dt><dd>' + esc(r.target) + '</dd>' +
      '<dt>Amount</dt><dd>' + esc(r.amount) + '</dd><dt>Who</dt><dd>' + esc(r.who) + '</dd><dt>Status</dt><dd><span class="status ' + statusClass(r.status) + '">' + esc(r.status) + '</span></dd></dl>' +
      '<h3 style="font-size:16px;font-weight:800">How Pyp got here <span style="font:600 12px ui-monospace,monospace;color:#4A5B7C">run ' + esc(r.run.id) + '</span></h3>' +
      '<ol class="steps">' + r.run.steps.map(function (s) {
        return '<li><time>' + esc(s.time) + '</time><span><span class="tag t-' + esc(s.tag.toLowerCase()) + '">' + esc(s.tag) + '</span>' + esc(s.text) + '</span></li>';
      }).join('') + '</ol>' +
      '<p class="note">' + esc(r.run.footer) + '</p>' +
      '</section>';
    document.body.appendChild(d);
    var closeBtn = d.querySelector('[data-close]');
    closeBtn.focus();
    function close() { d.remove(); document.removeEventListener('keydown', onKey); if (opener) opener.focus(); }
    function onKey(e) {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') { e.preventDefault(); closeBtn.focus(); }
    }
    d.addEventListener('click', function (e) { if (e.target === d || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', onKey);
  }

  /* ---------------- Weekly brief ---------------- */
  function renderBrief() {
    transport.brief().then(function (b) {
      view.innerHTML =
        '<section class="panel"><h2>' + esc(b.week) + '</h2><p>Pyp’s weekly look at your business. Insights only reads; it never changes anything in PayPal.</p>' +
        '<div class="stats">' + b.stats.map(function (s) {
          return '<div class="stat"><span>' + esc(s.label) + '</span><b>' + esc(s.value) + '</b><small>' + esc(s.note) + '</small></div>';
        }).join('') + '</div>' +
        '<div class="says"><div data-fig="brief"></div><div class="bub">' + esc(b.summary) + '</div></div>' +
        '<p class="note">' + esc(b.footnote) + '</p>' +
        '<p style="margin-top:14px"><a class="btn btn-ghost" href="#/inbox">See what needs you</a></p></section>';
      fig('brief', { size: 44, mode: 'avatar' });
    });
  }

  /* ---------------- Setup ---------------- */
  var SKILLS = [
    { id: 'collections', name: 'Collections', desc: 'Create invoices, send reminders, follow up on late payments.', modes: ['off', 'ask', 'auto'] },
    { id: 'disputes', name: 'Disputes', desc: 'Gather facts and draft evidence when a buyer opens a dispute.', modes: ['off', 'ask', 'auto'], noAuto: 'Evidence is never Auto. You always review it.' },
    { id: 'refunds', name: 'Refunds', desc: 'Small refunds you ask for in chat.', modes: ['off', 'ask', 'auto'], limit: true },
    { id: 'insights', name: 'Weekly brief', desc: 'A short summary every Monday. Read-only.', modes: ['off', 'on'] }
  ];
  var MODE_LABEL = { off: 'Off', ask: 'Ask me', auto: 'Auto', on: 'On' };

  function renderSetup() {
    var s = transport.getSettings();
    var paused = transport.isPaused();
    view.innerHTML =
      '<section class="panel"><h2>What your Pyp can do</h2><p>Pick, skill by skill, whether Pyp is off, asks you first, or acts on its own within your limits. Changes apply from Pyp’s next run.</p>' +
      '<div class="skills">' + SKILLS.map(function (k) {
        var cur = s.skills[k.id];
        return '<div class="skill"><div><h3 id="sk-' + k.id + '">' + k.name + '</h3><p>' + k.desc + (k.noAuto ? ' ' + k.noAuto : '') + '</p></div>' +
          '<div class="seg" role="group" aria-labelledby="sk-' + k.id + '">' + k.modes.map(function (m) {
            var disabled = k.noAuto && m === 'auto';
            return '<button type="button" data-skill="' + k.id + '" data-mode="' + m + '" aria-pressed="' + (cur === m) + '"' + (disabled ? ' disabled title="' + esc(k.noAuto) + '"' : '') + '>' + MODE_LABEL[m] + '</button>';
          }).join('') + '</div>' +
          (k.limit ? '<div class="subrow"><label for="lim">Auto only up to</label><span>$</span><input id="lim" type="number" min="0" max="500" step="1" value="' + s.refundAutoLimit + '" data-limit> <span class="muted">Anything bigger asks you first.</span></div>' : '') +
          '</div>';
      }).join('') + '</div></section>' +

      '<section class="panel"><h2>Limits</h2><p>Hard caps that apply even when a skill is on Auto.</p><div class="limits">' +
      '<label>Reminders per day<select data-perday>' + [1, 2, 3, 5].map(function (n) { return '<option' + (n === s.remindersPerDay ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>' +
      '<label>Undo window for Auto actions<select data-undo>' + [[30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [900, '15 minutes']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === s.undoSeconds ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
      '</div></section>' +

      '<section class="panel"><h2 id="pause-t">Pause Pyp</h2><div class="pauserow"><p>Stops everything at once. Pyp keeps watching and drafting, but nothing is sent to PayPal, and Auto timers freeze, until you turn this off.</p>' +
      '<button type="button" class="bigswitch" role="switch" aria-checked="' + paused + '" aria-labelledby="pause-t" data-pause><span></span></button></div></section>' +

      '<section class="panel"><h2>Connect the Chrome extension</h2><p>The extension puts Pyp in the corner of paypal.com. Paste this code into the extension when it asks.</p>' +
      '<div class="code"><span data-code>PYP-7F3A-K29Q</span><button type="button" class="btn btn-ghost" data-copy>Copy</button></div>' +
      '<ol class="olist"><li>Install the extension (see the website’s “Get the extension” steps).</li><li>Click the Pyp icon in Chrome’s toolbar, then the settings button.</li><li>Paste the code under “Connection code” and press Connect.</li></ol>' +
      '<p class="note">UI preview: the code is a placeholder until the real API exists.</p></section>' +

      '<section class="panel"><h2>Demo data</h2><p>Put every card, the activity log and these settings back to how they started.</p>' +
      '<p style="margin-top:12px"><button type="button" class="btn btn-danger" data-reset>Reset demo data</button></p></section>';

    view.addEventListener('click', onSetupClick);
    cleanup.push(function () { view.removeEventListener('click', onSetupClick); });
    view.querySelector('[data-limit]').addEventListener('change', function (e) {
      var v = Math.max(0, Math.min(500, Math.round(Number(e.target.value) || 0)));
      e.target.value = v;
      transport.updateSettings({ refundAutoLimit: v });
      toast('Saved. Refunds up to $' + v + ' can run on Auto.');
    });
    view.querySelector('[data-perday]').addEventListener('change', function (e) {
      transport.updateSettings({ remindersPerDay: Number(e.target.value) });
      toast('Saved.');
    });
    view.querySelector('[data-undo]').addEventListener('change', function (e) {
      transport.updateSettings({ undoSeconds: Number(e.target.value) });
      toast('Saved. New Auto actions get this undo window.');
    });
  }

  function onSetupClick(e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-skill') && !b.disabled) {
      var skill = b.getAttribute('data-skill');
      var mode = b.getAttribute('data-mode');
      var patch = { skills: {} };
      patch.skills[skill] = mode;
      if (skill === 'collections') patch.reminders = mode === 'auto' ? 'auto' : 'ask';
      transport.updateSettings(patch);
      b.parentNode.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      toast('Saved. ' + b.parentNode.getAttribute('aria-labelledby').replace('sk-', '').replace(/^./, function (c) { return c.toUpperCase(); }) + ': ' + MODE_LABEL[mode] + '.');
    } else if (b.hasAttribute('data-pause')) {
      var on = b.getAttribute('aria-checked') !== 'true';
      transport.setPaused(on);
      b.setAttribute('aria-checked', String(on));
      toast(on ? 'Pyp is paused. Nothing will be sent to PayPal.' : 'Pyp is back on.');
    } else if (b.hasAttribute('data-copy')) {
      var code = view.querySelector('[data-code]').textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(code) : Promise.reject()).then(function () { toast('Code copied.'); }, function () { toast('Copy failed. Select the code and copy it.'); });
    } else if (b.hasAttribute('data-reset')) {
      transport.reset();
      toast('Demo data reset.');
      route();
    }
  }

  /* ---------------- go ---------------- */
  startApp();
})();
