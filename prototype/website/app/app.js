// Pyp dashboard (UI preview on demo data).
// Pages: Overview, Transactions, Invoices, Disputes, Inbox, Activity (AG Grid,
// see activity-grid.js), Weekly brief, Setup.
// All data comes from one demo transport saved in localStorage, shared with the
// landing page and with other open tabs. To use the real API, replace `transport`.
(function () {
  'use strict';

  var Fig = window.PypFigure;

  var transport = window.PypTransport();
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
    if (transport.isDemo) { window.location.href = 'http://localhost:3000/login'; return; }
    // Live: end the session on the server first, or /login would still find you signed in.
    fetch('/api/auth/signout', { method: 'POST', credentials: 'include' })
      .catch(function () { /* go to /login anyway */ })
      .then(function () { window.location.href = '/login'; });
  });

  /* ---------------- shell ---------------- */
  function startApp() {
    fig('brand', { size: 30, mode: 'idle' });
    if (!transport.isDemo) {
      document.querySelectorAll('[data-data-label]').forEach(function (el) { el.textContent = 'LIVE · PAYPAL SANDBOX'; });
      document.querySelector('[data-me-initial]').textContent = 'P';
      document.querySelector('[data-me-name]').textContent = 'Pyp Demo Business';
      document.querySelector('[data-me-biz]').textContent = 'PayPal sandbox';
    }
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
    orders: { title: 'Order details', render: renderOrder },
    invoices: { title: 'Invoices', render: renderInvoices },
    disputes: { title: 'Disputes', render: renderDisputes },
    clients: { title: 'Clients', render: renderClients },
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
            '<td class="num">' + esc(amount) + '</td><td class="transaction-id" title="' + esc(item.id) + '">' + esc(item.id) + '</td><td>' +
            (item.orderId ? '<a href="#/orders?order_id=' + encodeURIComponent(item.orderId) + '">' + esc(item.orderId) + '</a>' : '—') + '</td></tr>';
        }).join('');
        var totalPages = data.totalPages || 1;
        results.innerHTML =
          '<div class="transaction-summary">' + esc(String(data.totalItems)) + ' transaction' + (data.totalItems === 1 ? '' : 's') + ' found</div>' +
          (rows ? '<div class="tablewrap"><table><thead><tr><th>When</th><th>Customer</th><th>Type</th><th>Status</th><th class="num">Amount</th><th>Transaction ID</th><th>Order ID</th></tr></thead><tbody>' + rows + '</tbody></table></div>' :
            '<div class="empty">No transactions were returned for these dates.</div>') +
          '<div class="pagination"><button class="btn btn-ghost" type="button" data-page-prev ' + (page <= 1 ? 'disabled' : '') + '>Previous</button><span>Page ' + esc(String(page)) + ' of ' + esc(String(totalPages)) + '</span><button class="btn btn-ghost" type="button" data-page-next ' + (page >= totalPages ? 'disabled' : '') + '>Next</button></div>' +
          '<p class="note">PayPal transaction reporting can lag behind sandbox activity. Codes remain available in each row’s tooltip.</p>';
        results.querySelector('[data-page-prev]').addEventListener('click', function () { page -= 1; loadTransactions(); });
        results.querySelector('[data-page-next]').addEventListener('click', function () { page += 1; loadTransactions(); });
      }).catch(function (error) {
        results.innerHTML = '<p class="setup-error">' + esc(error.message) + '</p><p class="note">Choose a date range of 31 days or less and confirm the sandbox connection check succeeds.</p>';
      });
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      page = 1;
      loadTransactions();
    });
    loadTransactions();
  }

  /* ---------------- Clients ---------------- */
  // Pyp's own client list: who Pyp may invoice by name or nickname. PayPal has no
  // contacts list, so saving here never changes PayPal.
  function renderClients() {
    if (!transport.clients) {
      view.innerHTML = '<section class="panel"><h2>Clients</h2><p>Clients are saved on the Pyp server. Sign in to the live dashboard to manage them.</p></section>';
      return;
    }
    var editing = null; // id of the saved client being edited, or 'new'
    var prefill = null;
    var data = null;

    function load() {
      transport.clients().then(function (d) { data = d; draw(); }, function (e) {
        view.innerHTML = '<section class="panel"><h2>Clients</h2><p class="setup-error">' + esc(e.message) + '</p></section>';
      });
    }

    function form(c) {
      c = c || {};
      return '<form class="client-form" data-client-form>' +
        '<label>Name<input name="name" maxlength="120" value="' + esc(c.name || '') + '" placeholder="John Smith"></label>' +
        '<label>Business<input name="businessName" maxlength="120" value="' + esc(c.businessName || '') + '" placeholder="Optional"></label>' +
        '<label>Email<input name="email" type="email" required maxlength="254" value="' + esc(c.email || '') + '" placeholder="john@example.com"></label>' +
        '<label>Nicknames<input name="nicknames" maxlength="300" value="' + esc((c.nicknames || []).join(', ')) + '" placeholder="John, JS"></label>' +
        '<div class="client-form-actions"><button class="btn" type="submit">Save client</button><button class="btn btn-ghost" type="button" data-cancel>Cancel</button></div>' +
        '</form>';
    }

    function who(c) { return c.businessName && c.name ? c.name + ' · ' + c.businessName : c.businessName || c.name || c.email; }

    function draw() {
      var saved = data.saved || [];
      var rows = saved.map(function (c) {
        if (editing === c.id) return '<tr><td colspan="4">' + form(c) + '</td></tr>';
        return '<tr><td><b>' + esc(who(c)) + '</b>' + (c.source === 'chat' ? ' <span class="chip chip-info">added in chat</span>' : '') + '</td><td>' + esc(c.email) + '</td><td>' + esc((c.nicknames || []).join(', ') || '—') +
          '</td><td class="num"><div class="row-actions"><button class="btn btn-ghost btn-sm" type="button" data-edit="' + esc(c.id) + '">Edit</button><button class="btn btn-danger btn-sm" type="button" data-del="' + esc(c.id) + '">Remove</button></div></td></tr>';
      }).join('');
      var others = (data.fromPayPal || []).map(function (c, i) {
        return '<tr><td>' + esc(who(c)) + '</td><td>' + esc(c.email) + '</td><td class="num"><div class="row-actions"><button class="btn btn-ghost btn-sm" type="button" data-adopt="' + i + '">Save to Pyp</button></div></td></tr>';
      }).join('');
      view.innerHTML =
        '<section class="panel"><div class="activity-head"><div><h2>Your clients</h2><p>Who Pyp can invoice from the chat. Add nicknames so “invoice Pyp $200” finds the right client. Saving a client here never changes PayPal.</p></div>' +
        '<div class="activity-actions"><button class="btn" type="button" data-new>Add client</button></div></div>' +
        (editing === 'new' ? form(prefill) : '') +
        (rows ? '<div class="tablewrap"><table><thead><tr><th>Client</th><th>Email</th><th>Nicknames</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
          : (editing === 'new' ? '' : '<div class="empty">No saved clients yet. Add one here, or tell Pyp in the chat: “add John Smith, john@example.com”.</div>')) +
        '</section>' +
        '<section class="panel"><h2>From your PayPal invoices</h2><p>People you’ve invoiced before. Pyp can already invoice them by name; save one to add nicknames.</p>' +
        (others ? '<div class="tablewrap"><table><thead><tr><th>Client</th><th>Email</th><th></th></tr></thead><tbody>' + others + '</tbody></table></div>'
          : '<div class="empty">' + (data.paypalOk === false ? 'PayPal didn’t answer just now.' : 'Everyone you’ve invoiced is saved.') + '</div>') +
        '</section>';
      var first = view.querySelector('[data-client-form] input');
      if (first) first.focus();
    }

    function onClick(e) {
      var b = e.target.closest('button');
      if (!b || !data) return;
      if (b.hasAttribute('data-new')) { editing = 'new'; prefill = null; draw(); }
      else if (b.hasAttribute('data-cancel')) { editing = null; prefill = null; draw(); }
      else if (b.hasAttribute('data-edit')) { editing = b.getAttribute('data-edit'); draw(); }
      else if (b.hasAttribute('data-adopt')) { editing = 'new'; prefill = data.fromPayPal[Number(b.getAttribute('data-adopt'))]; draw(); }
      else if (b.hasAttribute('data-del')) {
        b.disabled = true;
        transport.deleteClient(b.getAttribute('data-del')).then(function () { toast('Removed from your clients. PayPal and past invoices are unchanged.'); load(); }, function (err) { b.disabled = false; toast(err.message); });
      }
    }
    function onSubmit(e) {
      if (!e.target.matches('[data-client-form]')) return;
      e.preventDefault();
      var f = new FormData(e.target);
      var c = {
        name: String(f.get('name') || ''),
        businessName: String(f.get('businessName') || ''),
        email: String(f.get('email') || ''),
        nicknames: String(f.get('nicknames') || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean)
      };
      var btn = e.target.querySelector('[type=submit]');
      btn.disabled = true;
      transport.saveClient(c, editing === 'new' ? null : editing).then(function () {
        toast('Saved. Ask Pyp to invoice them any time.');
        editing = null; prefill = null; load();
      }, function (err) { btn.disabled = false; toast(err.message); });
    }
    view.addEventListener('click', onClick);
    view.addEventListener('submit', onSubmit);
    cleanup.push(function () { view.removeEventListener('click', onClick); view.removeEventListener('submit', onSubmit); });
    view.innerHTML = '<section class="panel"><h2>Your clients</h2><div class="loading">Loading clients…</div></section>';
    load();
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

  function renderDisputes() {
    var page = 1;
    var pageSize = 25;
    view.innerHTML = '<section class="panel"><h2>PayPal disputes</h2><p>Read-only disputes from your connected sandbox merchant.</p><div data-dispute-results><div class="loading">Loading disputes…</div></div></section>';
    var results = view.querySelector('[data-dispute-results]');

    function loadDisputes() {
      results.innerHTML = '<div class="loading">Loading disputes…</div>';
      transport.disputes({ page: page, pageSize: pageSize }).then(function (data) {
        var rows = (data.disputes || []).map(function (item) {
          var amount = item.amount == null ? '—' : (item.currency || '') + ' ' + item.amount;
          return '<tr><td class="transaction-id" title="' + esc(item.id) + '">' + esc(item.id) + '</td>' +
            '<td><span class="status status-' + esc(item.status) + '" title="' + esc(item.status) + '">' + esc(item.statusLabel || item.status) + '</span></td>' +
            '<td title="' + esc(item.reason) + '">' + esc(item.reasonLabel || item.reason) + '</td>' +
            '<td>' + esc(item.createdAt ? item.createdAt.slice(0, 10) : '—') + '</td>' +
            '<td>' + esc(item.responseDueDate ? item.responseDueDate.slice(0, 10) : '—') + '</td>' +
            '<td class="num">' + esc(amount) + '</td></tr>';
        }).join('');
        var totalPages = data.totalPages || 1;
        results.innerHTML =
          '<div class="transaction-summary">' + esc(String(data.totalItems)) + ' dispute' + (data.totalItems === 1 ? '' : 's') + ' found</div>' +
          (rows ? '<div class="tablewrap"><table><thead><tr><th>Dispute ID</th><th>Status</th><th>Reason</th><th>Created</th><th>Response due</th><th class="num">Amount</th></tr></thead><tbody>' + rows + '</tbody></table></div>' :
            '<div class="empty">No disputes were returned.</div>') +
          '<div class="pagination"><button class="btn btn-ghost" type="button" data-page-prev ' + (page <= 1 ? 'disabled' : '') + '>Previous</button><span>Page ' + esc(String(page)) + ' of ' + esc(String(totalPages)) + '</span><button class="btn btn-ghost" type="button" data-page-next ' + (page >= totalPages ? 'disabled' : '') + '>Next</button></div>' +
          '<p class="note">This view only reads PayPal data. Pyp does not respond to, resolve, or change disputes here.</p>';
        results.querySelector('[data-page-prev]').addEventListener('click', function () { page -= 1; loadDisputes(); });
        results.querySelector('[data-page-next]').addEventListener('click', function () { page += 1; loadDisputes(); });
      }).catch(function (error) {
        results.innerHTML = '<p class="setup-error">' + esc(error.message) + '</p><p class="note">Confirm the PayPal app has Customer disputes access enabled, then retry.</p>';
      });
    }

    loadDisputes();
  }

  function renderOrder() {
    var orderId = new URLSearchParams(location.hash.split('?')[1] || '').get('order_id');
    if (!orderId) {
      view.innerHTML = '<section class="panel"><h2>Order details</h2><p>Open an order from a transaction row to view its PayPal details.</p></section>';
      return;
    }
    view.innerHTML = '<section class="panel"><h2>Order details</h2><p>Read-only details for order ' + esc(orderId) + '.</p><div class="loading">Loading order…</div></section>';
    transport.order(orderId).then(function (order) {
      view.innerHTML = '<section class="panel"><h2>Order details</h2><p>Read-only PayPal order information.</p><dl class="kv">' +
        '<dt>Order ID</dt><dd>' + esc(order.id) + '</dd><dt>Status</dt><dd>' + esc(order.status) + '</dd>' +
        '<dt>Intent</dt><dd>' + esc(order.intent || '—') + '</dd><dt>Amount</dt><dd>' + esc(order.amount == null ? '—' : (order.currency || '') + ' ' + order.amount) + '</dd>' +
        '<dt>Payer</dt><dd>' + esc(order.payerEmail || '—') + '</dd><dt>Created</dt><dd>' + esc(order.createdAt || '—') + '</dd><dt>Updated</dt><dd>' + esc(order.updatedAt || '—') + '</dd></dl>' +
        '<p class="note">This view only reads PayPal data. Pyp does not modify this order.</p></section>';
    }).catch(function (error) {
      view.innerHTML = '<section class="panel"><h2>Order unavailable</h2><p class="setup-error">' + esc(error.message) + '</p><p class="note">PayPal order details require a valid order ID from a transaction.</p></section>';
    });
  }

  // What kind of card: the skill it came from. Anything else (a general question) is Other.
  var INBOX_KINDS = [
    { id: 'all', label: 'All types' },
    { id: 'invoice', label: 'Invoices' },
    { id: 'dispute', label: 'Disputes' },
    { id: 'insight', label: 'Weekly briefs' },
    { id: 'other', label: 'Other' }
  ];
  var inboxKind = 'all';
  var inboxQuery = '';

  function renderInbox() {
    view.innerHTML =
      // One toolbar: status as tabs, type as a menu, and search.
      '<div class="inbox-bar">' +
      '<div class="inbox-seg" role="group" aria-label="Filter by status">' +
      INBOX_TABS.map(function (t) {
        return '<button type="button" data-itab="' + t.id + '" aria-pressed="' + (t.id === inboxTab) + '">' + t.label + '<span class="n" data-icount="' + t.id + '"></span></button>';
      }).join('') + '</div>' +
      '<label class="inbox-type"><span class="sr-label">Type</span><select data-ikind>' +
      INBOX_KINDS.map(function (k) {
        return '<option value="' + k.id + '"' + (k.id === inboxKind ? ' selected' : '') + '>' + k.label + '</option>';
      }).join('') + '</select></label>' +
      '<label class="inbox-search"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span class="sr-label">Search the Inbox</span><input type="search" data-isearch placeholder="Search by title, client or invoice" value="' + esc(inboxQuery) + '"></label>' +
      '</div><div id="inbox-host"></div>';

    function matches(i) {
      if (inboxKind !== 'all' && (INBOX_KINDS.some(function (k) { return k.id === i.kind; }) ? i.kind : 'other') !== inboxKind) return false;
      var q = inboxQuery.trim().toLowerCase();
      if (!q) return true;
      return [i.title, i.meta, i.amount, i.label, i.box && i.box.title].join(' ').toLowerCase().indexOf(q) >= 0;
    }
    function status() { return INBOX_TABS.filter(function (t) { return t.id === inboxTab; })[0]; }
    function combined() {
      var t = status();
      return function (i) { return matches(i) && (!t.fn || t.fn(i)); };
    }
    function emptyText() {
      return inboxQuery.trim() || inboxKind !== 'all' ? 'No cards match. Try another search or type.' : status().empty;
    }

    inboxHandle = window.PypInbox.mount(document.getElementById('inbox-host'), transport, { layout: 'grid', filter: combined(), emptyText: emptyText() });

    var lastItems = [];
    function counts(items) {
      lastItems = items;
      var shown = items.filter(matches);
      INBOX_TABS.forEach(function (t) {
        var el = view.querySelector('[data-icount="' + t.id + '"]');
        if (el) el.textContent = String(t.fn ? shown.filter(t.fn).length : shown.length);
      });
    }
    function apply() {
      inboxHandle.setFilter(combined(), emptyText());
      counts(lastItems);
    }
    transport.inbox().then(function (d) { counts(d.items); });
    cleanup.push(transport.subscribe(counts));

    // On the toolbar itself, so nothing is left behind on the page when you leave the Inbox.
    var bar = view.querySelector('.inbox-bar');
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-itab]');
      if (!b) return;
      inboxTab = b.getAttribute('data-itab');
      bar.querySelectorAll('[data-itab]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      apply();
    });
    bar.querySelector('[data-ikind]').addEventListener('change', function (e) {
      inboxKind = e.target.value;
      apply();
    });
    view.querySelector('[data-isearch]').addEventListener('input', function (e) {
      inboxQuery = e.target.value;
      apply();
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
    window.PypActivityGrid.render(view, {
      transport: transport,
      esc: esc,
      fmtWhen: fmtWhen,
      openPypDrawer: openDrawer,
      onCleanup: function (fn) { cleanup.push(fn); }
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
    { id: 'insights', name: 'Weekly brief', desc: 'A short summary every Friday. Read-only.', modes: ['off', 'on'] }
  ];
  var MODE_LABEL = { off: 'Off', ask: 'Ask me', auto: 'Auto', on: 'On' };

  /* Live: the server's own controls (GET /api/rules). What a dial may be is checked on the server. */
  var SKILL_NAMES = { collections: 'Collections', disputes: 'Disputes', insights: 'Weekly brief' };
  var UNDO_CHOICES = [[30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [600, '10 minutes']];

  function renderSetupLive() {
    view.innerHTML = '<section class="panel"><h2>Your controls</h2><p>Loading from Pyp…</p></section>';
    transport.controls().then(draw, function (e) {
      view.innerHTML = '<section class="panel"><h2>Your controls</h2><p class="setup-error">' + esc(e.message) + '</p></section>';
    });

    function draw(c) {
      var skills = [];
      c.commands.forEach(function (x) { if (skills.indexOf(x.skill) < 0) skills.push(x.skill); });
      var undoChoices = UNDO_CHOICES.some(function (o) { return o[0] === c.undoSeconds; }) ? UNDO_CHOICES : UNDO_CHOICES.concat([[c.undoSeconds, c.undoSeconds + ' seconds']]);
      view.innerHTML =
        '<section class="panel"><h2 id="pause-t">Pause Pyp (kill switch)</h2><div class="pauserow"><p>' +
        (c.killSwitch ? '<b>Pyp is paused.</b> ' : '') +
        'Stops every write to PayPal at once: Approve, Auto actions waiting out their undo window, and the daily checks. Pyp keeps reading and drafting, and nothing is lost: turn it off and Approve works again.</p>' +
        '<button type="button" class="bigswitch" role="switch" aria-checked="' + c.killSwitch + '" aria-labelledby="pause-t" data-pause><span></span></button></div></section>' +

        '<section class="panel"><h2>What your Pyp can do</h2><p>For each action: Off, Ask me first, or Auto (it runs after the undo window unless you tap Undo). Actions that move money or answer a request you typed always ask.</p>' +
        '<div class="skills">' + skills.map(function (sk) {
          return '<h3 class="skillhead">' + esc(SKILL_NAMES[sk] || sk) + '</h3>' + c.commands.filter(function (x) { return x.skill === sk; }).map(function (x) {
            return '<div class="skill"><div><h3 id="cmd-' + esc(x.id.replace('.', '-')) + '">' + esc(x.label) + '</h3>' + (x.canAuto ? '' : '<p>Always asks you first.</p>') + '</div>' +
              '<div class="seg" role="group" aria-labelledby="cmd-' + esc(x.id.replace('.', '-')) + '">' + ['off', 'ask', 'auto'].map(function (m) {
                var disabled = m === 'auto' && !x.canAuto;
                return '<button type="button" data-cmd="' + esc(x.id) + '" data-mode="' + m + '" aria-pressed="' + (x.dial === m) + '"' + (disabled ? ' disabled title="This always needs your approval"' : '') + '>' + MODE_LABEL[m] + '</button>';
              }).join('') + '</div></div>';
          }).join('');
        }).join('') + '</div></section>' +

        '<section class="panel"><h2>Undo window</h2><p>How long an Auto action waits before it goes to PayPal, so you can tap Undo.</p><div class="limits">' +
        '<label>Undo window for Auto actions<select data-undo>' + undoChoices.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === c.undoSeconds ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
        '</div></section>' +

        '<section class="panel"><h2>Check now</h2><p>Pyp checks these every morning from 8:00 your time. Run one now: anything that needs you shows up in your Inbox.</p>' +
        '<p class="sweeps"><button type="button" class="btn btn-ghost" data-sweep="overdue-invoices">Check overdue invoices</button> ' +
        '<button type="button" class="btn btn-ghost" data-sweep="dispute-deadlines">Check dispute deadlines</button> ' +
        '<button type="button" class="btn btn-ghost" data-sweep="weekly-brief">Weekly brief now</button></p></section>' +

        '<section class="panel"><h2>Live data</h2><p>Cards, the activity log and PayPal data on this page are live from your sandbox. These controls are saved on the Pyp server and apply everywhere: this page, the Chrome extension and the worker.</p></section>';
    }

    function onClick(e) {
      var b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.hasAttribute('data-pause')) {
        var on = b.getAttribute('aria-checked') !== 'true';
        b.disabled = true;
        transport.setPaused(on).then(function () {
          toast(on ? 'Pyp is paused. Nothing will be sent to PayPal until you turn this off.' : 'Pyp is running again.');
          transport.controls().then(draw);
        }, function (err) { b.disabled = false; toast(err.message); });
      } else if (b.hasAttribute('data-cmd')) {
        var mode = b.getAttribute('data-mode');
        transport.setDial(b.getAttribute('data-cmd'), mode).then(function (c) {
          draw(c);
          toast('Saved: ' + MODE_LABEL[mode] + '.');
        }, function (err) { toast(err.message); });
      } else if (b.hasAttribute('data-sweep')) {
        var label = b.textContent;
        b.disabled = true;
        transport.runSweep(b.getAttribute('data-sweep')).then(function (out) {
          b.disabled = false;
          var made = (out.cardIds || []).length;
          toast(label + ': found ' + out.found + ', ' + made + ' new card' + (made === 1 ? '' : 's') + (out.skipped ? ', ' + out.skipped + ' already in hand' : '') + (out.deferred ? ', ' + out.deferred + ' left for next time' : '') + '.');
        }, function (err) { b.disabled = false; toast(err.message); });
      }
    }
    function onChange(e) {
      if (!e.target.matches('[data-undo]')) return;
      transport.setUndoSeconds(Number(e.target.value)).then(function (c) {
        toast('Saved. Auto actions now wait ' + c.undoSeconds + ' s before sending.');
      }, function (err) { toast(err.message); });
    }
    view.addEventListener('click', onClick);
    view.addEventListener('change', onChange);
    cleanup.push(function () { view.removeEventListener('click', onClick); view.removeEventListener('change', onChange); });
  }

  function renderSetup() {
    if (!transport.isDemo) return renderSetupLive();
    var s = transport.getSettings();
    var paused = transport.isPaused();
    view.innerHTML =
      '<section class="panel"><h2>What your Pyp can do</h2><p>Pick, skill by skill, whether Pyp is off, asks you first, or acts on its own within your limits. ' +
      (transport.isDemo ? 'Changes apply from Pyp’s next run.' : 'For now these are saved in this browser only; the engine still asks you before every write.') + '</p>' +
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

      '<section class="panel"><h2 id="pause-t">Pause Pyp</h2><div class="pauserow"><p>' + (transport.isDemo
        ? 'Stops everything at once. Pyp keeps watching and drafting, but nothing is sent to PayPal, and Auto timers freeze, until you turn this off.'
        : 'Turns off Approve in this browser until you turn this off. It doesn’t stop the server yet: other tabs and Auto actions still run.') + '</p>' +
      '<button type="button" class="bigswitch" role="switch" aria-checked="' + paused + '" aria-labelledby="pause-t" data-pause><span></span></button></div></section>' +

      '<section class="panel"><h2>Connect the Chrome extension</h2><p>The extension puts Pyp in the corner of paypal.com. Paste this code into the extension when it asks.</p>' +
      '<div class="code"><span data-code>PYP-7F3A-K29Q</span><button type="button" class="btn btn-ghost" data-copy>Copy</button></div>' +
      '<ol class="olist"><li>Install the extension (see the website’s “Get the extension” steps).</li><li>Click the Pyp icon in Chrome’s toolbar, then the settings button.</li><li>Paste the code under “Connection code” and press Connect.</li></ol>' +
      '<p class="note">UI preview: the code is a placeholder until the real API exists.</p></section>' +

      (transport.isDemo
        ? '<section class="panel"><h2>Demo data</h2><p>Put every card, the activity log and these settings back to how they started.</p>' +
          '<p style="margin-top:12px"><button type="button" class="btn btn-danger" data-reset>Reset demo data</button></p></section>'
        : '<section class="panel"><h2>Live data</h2><p>Cards, the activity log and PayPal data on this page are live from your sandbox. These settings are saved in this browser for now; the engine still asks you before every write.</p></section>');

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
      toast(on ? (transport.isDemo ? 'Pyp is paused. Nothing will be sent to PayPal.' : 'Approvals from this browser are paused.') : 'Pyp is back on.');
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
