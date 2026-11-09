// Pyp dashboard (UI preview on demo data).
// Pages: Overview, Transactions, Invoices, Disputes, Inbox, Activity (AG Grid,
// see activity-grid.js), Weekly brief, Settings.
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
    business: { title: 'About my business', render: renderMemory },
    workflows: { title: 'Workflows', render: function () { window.PypWorkflows.render(view, transport, { toast: toast, cleanup: cleanup }); } },
    skills: { title: 'My skills', render: function () { window.PypSkills.render(view, transport, { toast: toast, cleanup: cleanup }); } },
    inbox: { title: 'Inbox', render: renderInbox },
    activity: { title: 'Activity', render: renderActivity },
    brief: { title: 'Weekly brief', render: renderBrief },
    settings: { title: 'Settings', render: renderSetup }
  };

  /* Sidebar folders: PayPal, Your Pyp, Reports. Open ones are remembered in this browser. */
  var FOLDERS_KEY = 'pyp.nav.open';
  function openFolders() { try { return JSON.parse(localStorage.getItem(FOLDERS_KEY) || '["paypal"]'); } catch (e) { return ['paypal']; } }
  function setFolder(g, open) {
    var b = g.querySelector('.nav-folder');
    b.setAttribute('aria-expanded', String(open));
    g.querySelector('.nav-sub').hidden = !open;
    g.classList.toggle('open', open);
    var ids = openFolders().filter(function (x) { return x !== g.getAttribute('data-group'); });
    if (open) ids.push(g.getAttribute('data-group'));
    try { localStorage.setItem(FOLDERS_KEY, JSON.stringify(ids)); } catch (e) { /* blocked */ }
  }
  document.querySelectorAll('.nav-group').forEach(function (g) {
    if (openFolders().indexOf(g.getAttribute('data-group')) >= 0) setFolder(g, true);
    g.querySelector('.nav-folder').addEventListener('click', function () { setFolder(g, !g.classList.contains('open')); });
  });

  function route() {
    var name = (location.hash.replace(/^#\/?/, '') || 'inbox').split('?')[0];
    if (name === 'setup') name = 'settings'; // the page's old name, in old links and bookmarks
    if (!PAGES[name]) name = 'inbox';
    cleanup.forEach(function (fn) { fn(); });
    cleanup = [];
    if (inboxHandle) { inboxHandle.destroy(); inboxHandle = null; }
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      if (a.getAttribute('data-nav') === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    // The folder holding this page opens, and is marked as holding it.
    document.querySelectorAll('.nav-group').forEach(function (g) {
      var here = !!g.querySelector('[data-nav="' + name + '"]');
      g.classList.toggle('has-current', here);
      if (here) setFolder(g, true);
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

  /* ---------------- Pyp's memory ---------------- */
  // What Pyp knows about the business: facts the merchant added, and facts Pyp
  // noticed in chat waiting to be confirmed. They reach case files as notes for
  // Pyp's judgment, never sent to clients and never above code's checks.
  function renderMemory() {
    if (!transport.facts) {
      view.innerHTML = '<section class="panel"><h2>About my business</h2><p>Sign in to the live dashboard to see what Pyp knows.</p></section>';
      return;
    }
    var facts = null;
    var clients = [];
    var editingId = null;

    function load() {
      Promise.all([transport.facts(), transport.clients ? transport.clients().catch(function () { return { saved: [], fromPayPal: [] }; }) : { saved: [], fromPayPal: [] }]).then(function (r) {
        facts = r[0].facts || [];
        var seen = {};
        clients = (r[1].saved || []).concat(r[1].fromPayPal || []).filter(function (c) {
          var k = c.email.toLowerCase();
          if (seen[k]) return false;
          seen[k] = true;
          return true;
        });
        draw();
      }, function (e) {
        view.innerHTML = '<section class="panel"><h2>About my business</h2><p class="setup-error">' + esc(e.message) + '</p></section>';
      });
    }

    function clientName(email) {
      var c = clients.filter(function (x) { return x.email.toLowerCase() === String(email).toLowerCase(); })[0];
      return c ? (c.businessName || c.name || c.email) : email;
    }
    function clientSelect(selected) {
      return '<select name="clientEmail"><option value="">Your whole business</option>' +
        clients.map(function (c) { return '<option value="' + esc(c.email) + '"' + (selected && selected.toLowerCase() === c.email.toLowerCase() ? ' selected' : '') + '>' + esc(c.businessName || c.name || c.email) + '</option>'; }).join('') +
        '</select>';
    }
    function form(f) {
      f = f || {};
      return '<form class="fact-form" data-fact-form' + (f.id ? ' data-id="' + esc(f.id) + '"' : '') + '>' +
        '<label class="fact-text"><span class="sr-label">The fact</span><input name="text" maxlength="300" required value="' + esc(f.text || '') + '" placeholder="e.g. Acme always pays on the 15th"></label>' +
        '<label class="fact-about"><span class="sr-label">About</span>' + clientSelect(f.clientEmail) + '</label>' +
        '<button class="btn btn-sm" type="submit">' + (f.id ? 'Save' : 'Remember this') + '</button>' +
        (f.id ? '<button class="btn btn-ghost btn-sm" type="button" data-cancel>Cancel</button>' : '') +
        '</form>';
    }
    // The business profile: quick picks, all optional. Each answer is one fact the server
    // tags "profile:<key>:<value>"; Pyp reads its words in every case file.
    var PROFILE = [
      { key: 'what', label: 'What you do', text: true, placeholder: 'e.g. Product photography' },
      { key: 'terms', label: 'Usual terms', options: [['receipt', 'On receipt'], ['net_15', 'Net 15'], ['net_30', 'Net 30'], ['net_60', 'Net 60']] },
      { key: 'tone', label: 'Reminder tone', options: [['gentle', 'Gentle'], ['balanced', 'Balanced'], ['firm', 'Firm']] },
      { key: 'late_fees', label: 'Late fees', options: [['never', 'Never'], ['ask', 'Ask me first']] }
    ];
    var memTab = 'learned';
    function isProfile(f) { return (f.subjectRef || '').indexOf('profile:') === 0; }
    function profileValues() {
      var out = {};
      facts.filter(isProfile).forEach(function (f) {
        var parts = f.subjectRef.split(':');
        out[parts[1]] = parts[1] === 'what' ? f.text.replace(/^My business: /, '').replace(/\.$/, '') : parts[2];
      });
      return out;
    }

    function chip(f) {
      if (editingId === f.id) return '<div class="mem-editing">' + form(f) + '</div>';
      var unsure = f.status === 'proposed';
      return '<span class="mem-chip' + (unsure ? ' unsure' : '') + '" data-fact="' + esc(f.id) + '">' +
        '<button type="button" class="mem-chip-text" data-edit title="Edit">' + esc(f.text) + '</button>' +
        (unsure ? '<button type="button" class="mem-keep" data-confirm>Keep</button>' : '') +
        '<button type="button" class="mem-x" data-forget aria-label="Forget: ' + esc(f.text) + '">×</button></span>';
    }

    function line(f) {
      if (editingId === f.id) return '<li class="mem-line">' + form(f) + '</li>';
      var when = new Date(f.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return '<li class="mem-line" data-fact="' + esc(f.id) + '"><span class="mem-dot" aria-hidden="true"></span>' +
        '<div class="mem-line-main"><p>' + esc(f.text) + '</p><span class="mem-line-meta">' + (f.source === 'chat' ? 'Learned in chat' : 'You added this') + ' · ' + esc(when) + '</span></div>' +
        '<div class="row-actions">' + (f.status === 'proposed' ? '<button class="btn btn-sm" type="button" data-confirm>Keep</button>' : '') +
        '<button class="btn btn-ghost btn-sm" type="button" data-edit>Edit</button><button class="btn btn-danger btn-sm" type="button" data-forget>Forget</button></div></li>';
    }

    function draw() {
      var name = (document.querySelector('[data-me-name]') || {}).textContent || 'your business';
      var profile = profileValues();
      var learned = facts.filter(function (f) { return !f.clientEmail && !isProfile(f); });
      var byClient = {};
      facts.filter(function (f) { return f.clientEmail; }).forEach(function (f) {
        var k = f.clientEmail.toLowerCase();
        (byClient[k] = byClient[k] || { email: f.clientEmail, facts: [] }).facts.push(f);
      });
      var clientCards = Object.keys(byClient).map(function (k) { return byClient[k]; });

      // The gist: the profile in a line, else the newest things Pyp learned.
      var gist = PROFILE.map(function (p) {
        var v = profile[p.key];
        if (!v) return null;
        if (p.text) return v;
        var label = p.options.filter(function (o) { return o[0] === v; })[0][1];
        return p.key === 'tone' ? label + ' reminders' : p.key === 'late_fees' ? (v === 'never' ? 'No late fees' : 'Late fees: ask first') : label;
      }).filter(Boolean);
      if (!gist.length) gist = learned.slice(0, 2).map(function (f) { return f.text.replace(/[.!]+$/, ''); });

      var profileRows = PROFILE.map(function (p) {
        var v = profile[p.key] || '';
        var control = p.text
          ? '<input class="mem-what" data-profile-text="' + p.key + '" maxlength="120" value="' + esc(v) + '" placeholder="' + esc(p.placeholder) + '">'
          : '<div class="inbox-seg mem-seg" role="group" aria-label="' + esc(p.label) + '">' + p.options.map(function (o) {
            return '<button type="button" data-profile="' + p.key + '" data-value="' + o[0] + '" aria-pressed="' + (v === o[0]) + '">' + esc(o[1]) + '</button>';
          }).join('') + '</div>';
        return '<div class="mem-row"><span class="mem-row-label">' + esc(p.label) + '</span>' + control + '</div>';
      }).join('');

      var tabBody = memTab === 'clients'
        ? (clientCards.length ? '<div class="mem-clients">' + clientCards.map(function (c) {
          return '<div class="mem-client"><div class="mem-client-head"><span class="mem-avatar" aria-hidden="true">' + esc(clientName(c.email).charAt(0).toUpperCase()) + '</span><b>' + esc(clientName(c.email)) + '</b></div>' +
            '<div class="mem-chips">' + c.facts.map(chip).join('') + '</div></div>';
        }).join('') + '</div>' : '<div class="empty">Nothing about clients yet. Mention it in chat: “John prefers a call before reminders.”</div>')
        : (learned.length ? '<ul class="mem-lines">' + learned.map(line).join('') + '</ul>' : '<div class="empty">Nothing yet. Pyp picks things up as you chat, or say “remember that…”.</div>');

      view.innerHTML =
        '<section class="panel mem-hero"><div class="mem-hero-icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24"><path d="M12 4a6 6 0 0 0-6 6c0 2.2 1.2 3.6 2.4 4.6.6.5.9 1.2.9 2V18h5.4v-1.4c0-.8.3-1.5.9-2 1.2-1 2.4-2.4 2.4-4.6a6 6 0 0 0-6-6z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M10 21h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div>' +
        '<div><h2>' + esc(name) + '</h2>' +
        (gist.length ? '<p class="mem-gist">' + gist.map(esc).join(' · ') + '</p>' : '<p class="mem-gist muted">Pyp is still getting to know you.</p>') +
        '<p class="mem-how">Pyp reads this before it decides anything. It’s all optional, never sent to clients, and never above the safety checks.</p></div></section>' +

        '<section class="panel"><div class="mem-head"><h2>Your business profile</h2><span class="chip chip-muted">All optional</span></div>' +
        '<div class="mem-profile">' + profileRows + '</div></section>' +

        '<section class="panel"><div class="mem-tabs" role="tablist">' +
        '<button type="button" role="tab" data-memtab="learned" aria-selected="' + (memTab === 'learned') + '">Learned in chat <span class="n">' + learned.length + '</span></button>' +
        '<button type="button" role="tab" data-memtab="clients" aria-selected="' + (memTab === 'clients') + '">Clients <span class="n">' + clientCards.length + '</span></button></div>' +
        '<div class="mem-tabbody">' + tabBody + '</div>' +
        '<div class="mem-tell"><span class="mem-row-label">Tell Pyp something</span>' + (editingId ? '' : form(null)) + '</div></section>';
      var focus = view.querySelector('.mem-editing input, .mem-line input');
      if (focus) focus.focus();
    }

    // Quick picks save at once; tapping the chosen one again clears it.
    function onProfile(e) {
      var b = e.target.closest('[data-profile], [data-memtab]');
      if (!b || !facts) return;
      if (b.hasAttribute('data-memtab')) { memTab = b.getAttribute('data-memtab'); editingId = null; draw(); return; }
      var key = b.getAttribute('data-profile');
      var value = b.getAttribute('aria-pressed') === 'true' ? null : b.getAttribute('data-value');
      b.closest('.mem-seg').querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b && value !== null)); });
      transport.setProfile(key, value).then(function () { toast(value ? 'Saved. Pyp will use it.' : 'Cleared.'); return load(); }, function (err) { toast(err.message); load(); });
    }
    function onProfileText(e) {
      if (!e.target.matches('[data-profile-text]')) return;
      transport.setProfile(e.target.getAttribute('data-profile-text'), e.target.value.trim() || null).then(function () { toast('Saved.'); return load(); }, function (err) { toast(err.message); });
    }
    view.addEventListener('click', onProfile);
    view.addEventListener('change', onProfileText);
    cleanup.push(function () { view.removeEventListener('click', onProfile); view.removeEventListener('change', onProfileText); });
    function onSubmit(e) {
      if (!e.target.matches('[data-fact-form]')) return;
      e.preventDefault();
      var fd = new FormData(e.target);
      var id = e.target.getAttribute('data-id');
      var body = { text: String(fd.get('text') || ''), clientEmail: String(fd.get('clientEmail') || '') || null };
      var btn = e.target.querySelector('[type=submit]');
      btn.disabled = true;
      transport.saveFact(body, id).then(function () {
        toast(id ? 'Saved.' : 'Pyp will keep that in mind.');
        editingId = null; load();
      }, function (err) { btn.disabled = false; toast(err.message); });
    }
    function onClick(e) {
      var b = e.target.closest('button');
      if (!b || !facts) return;
      var li = b.closest('[data-fact]') || (b.closest('.mem-editing') && b.closest('.mem-editing').querySelector('[data-fact-form]'));
      var fid = li && (li.getAttribute('data-fact') || li.getAttribute('data-id'));
      var f = fid && facts.filter(function (x) { return x.id === fid; })[0];
      if (b.hasAttribute('data-cancel')) { editingId = null; draw(); }
      else if (f && b.hasAttribute('data-edit')) { editingId = f.id; draw(); }
      else if (f && b.hasAttribute('data-confirm')) {
        b.disabled = true;
        transport.saveFact({ text: f.text, clientEmail: f.clientEmail, confirm: true }, f.id).then(function () { toast('Kept. Pyp will use it.'); load(); }, function (err) { b.disabled = false; toast(err.message); });
      } else if (f && b.hasAttribute('data-forget')) {
        b.disabled = true;
        transport.deleteFact(f.id).then(function () { toast('Forgotten.'); load(); }, function (err) { b.disabled = false; toast(err.message); });
      }
    }
    view.addEventListener('submit', onSubmit);
    view.addEventListener('click', onClick);
    cleanup.push(function () { view.removeEventListener('submit', onSubmit); view.removeEventListener('click', onClick); });
    view.innerHTML = '<section class="panel"><h2>What Pyp knows about you</h2><div class="loading">Loading…</div></section>';
    load();
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
    var DAY = 24 * 60 * 60 * 1000;
    // Bryntum is served from node_modules by `npm run live` only; the static demo has no timeline.
    var liveData = !!(window.PYP_CONFIG && window.PYP_CONFIG.live);
    var currentScheduler = null;
    var loadId = 0;
    function destroyScheduler() {
      if (currentScheduler) { currentScheduler.destroy(); currentScheduler = null; }
    }
    cleanup.push(function () { loadId += 1; destroyScheduler(); });
    function isClosed(item) { return /^(resolved|closed|won|lost)$/i.test(String(item.status || '')); }
    // Local calendar date, so a late-evening deadline isn't shown as tomorrow's UTC date.
    function localDate(iso) {
      var d = new Date(iso || '');
      return isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    }
    function startOfDay(time) { var d = new Date(time); d.setHours(0, 0, 0, 0); return d.getTime(); }

    function loadDisputes() {
      var thisLoad = ++loadId;
      destroyScheduler();
      results.innerHTML = '<div class="loading">Loading disputes…</div>';
      transport.disputes({ page: page, pageSize: pageSize }).then(function (data) {
        if (thisLoad !== loadId) return;
        var disputes = (data.disputes || []).slice().sort(function (a, b) {
          var aDue = new Date(a.responseDueDate).getTime();
          var bDue = new Date(b.responseDueDate).getTime();
          var aClosed = isClosed(a);
          var bClosed = isClosed(b);
          if (aClosed !== bClosed) return aClosed ? 1 : -1;
          if (!isFinite(aDue)) return 1;
          if (!isFinite(bDue)) return -1;
          return aDue - bDue;
        });
        // Closed disputes have no countdown. Otherwise count local calendar days, and test
        // "past due" on the exact time first so a deadline a few hours ago never reads "Due today".
        function deadlineText(item) {
          if (isClosed(item)) return 'Closed';
          var due = new Date(item.responseDueDate).getTime();
          if (!isFinite(due)) return '—';
          var now = Date.now();
          var days = Math.round((startOfDay(due) - startOfDay(now)) / DAY);
          if (due < now) {
            var late = Math.max(0, -days);
            return late ? late + ' day' + (late === 1 ? '' : 's') + ' overdue' : 'Overdue today';
          }
          if (days === 0) return 'Due today';
          return days + ' day' + (days === 1 ? '' : 's') + ' remaining';
        }
        function evidenceStage(item) {
          var status = String(item.status || '').toUpperCase();
          if (/^(RESOLVED|CLOSED|WON|LOST)/.test(status)) return 'Dispute closed';
          if (status === 'WAITING_FOR_SELLER_RESPONSE') return 'Awaiting merchant review';
          if (status === 'WAITING_FOR_BUYER_RESPONSE') return 'Waiting for buyer';
          if (status === 'UNDER_REVIEW') return 'Under PayPal review';
          return 'Review stage not provided';
        }
        function urgencyFor(item) {
          var due = new Date(item.responseDueDate).getTime();
          if (isClosed(item)) return 'gray';
          if (!isFinite(due) || due < Date.now()) return 'red';
          if (due <= Date.now() + 7 * 24 * 60 * 60 * 1000) return 'amber';
          return 'green';
        }
        var rows = disputes.map(function (item) {
          var amount = item.amount == null ? '—' : (item.currency || '') + ' ' + item.amount;
          return '<tr><td class="transaction-id" title="' + esc(item.id) + '">' + esc(item.id) + '</td>' +
            '<td><span class="status status-' + esc(item.status) + '" title="' + esc(item.status) + '">' + esc(item.statusLabel || item.status) + '</span></td>' +
            '<td title="' + esc(item.reason) + '">' + esc(item.reasonLabel || item.reason) + '</td>' +
            '<td>' + esc(localDate(item.createdAt) || '—') + '</td>' +
            '<td>' + esc(localDate(item.responseDueDate) || '—') + '</td>' +
            '<td>' + esc(deadlineText(item)) + '</td>' +
            '<td class="num">' + esc(amount) + '</td>' +
            '<td><button class="btn btn-ghost dispute-review-btn" type="button" data-review-dispute="' + esc(item.id) + '">Review</button></td></tr>';
        }).join('');
        var totalPages = data.totalPages || 1;
        // PayPal's disputes list may not report a total, so a full page can still mean more exist.
        var pageOnly = totalPages > 1 || disputes.length >= pageSize ? ' (this page)' : '';
        var now = Date.now();
        var dueSoon = disputes.filter(function (item) {
          var due = new Date(item.responseDueDate).getTime();
          return isFinite(due) && due >= now && due <= now + 7 * DAY && !isClosed(item);
        }).length;
        var overdue = disputes.filter(function (item) {
          var due = new Date(item.responseDueDate).getTime();
          return isFinite(due) && due < now && !isClosed(item);
        }).length;
        results.innerHTML =
          (rows && liveData ? '<section class="dispute-schedule"><div class="dispute-schedule-heading"><div><h3>Dispute deadline schedule</h3><p class="note">A read-only timeline of the time remaining to respond.</p></div><span class="schedule-legend"><span class="schedule-dot schedule-dot-green"></span>7+ days <span class="schedule-dot schedule-dot-amber"></span>Due soon <span class="schedule-dot schedule-dot-red"></span>Overdue <span class="schedule-dot schedule-dot-milestone"></span>Milestones</span></div><div class="dispute-scheduler" data-dispute-scheduler><div class="loading">Loading schedule…</div></div></section>' : '') +
          (rows ? '<div class="dispute-urgency" aria-label="Dispute deadline summary"><div><strong>' + esc(String(data.totalItems || 0)) + '</strong><span>Total disputes</span></div><div class="' + (dueSoon ? 'is-warning' : '') + '"><strong>' + esc(String(dueSoon)) + '</strong><span>Due within 7 days' + pageOnly + '</span></div><div class="' + (overdue ? 'is-danger' : '') + '"><strong>' + esc(String(overdue)) + '</strong><span>Overdue' + pageOnly + '</span></div></div>' : '') +
          '<div class="transaction-summary">' + esc(String(data.totalItems)) + ' dispute' + (data.totalItems === 1 ? '' : 's') + ' found</div>' +
          (rows ? '<div class="tablewrap"><table><thead><tr><th>Dispute ID</th><th>Status</th><th>Reason</th><th>Created</th><th>Response due</th><th>Time remaining</th><th class="num">Amount</th><th>Review</th></tr></thead><tbody>' + rows + '</tbody></table></div>' :
          '') +
          '<div data-dispute-review></div>' +
          (rows ? '' : '<div class="empty">No disputes were returned.</div>') +
          '<div class="pagination"><button class="btn btn-ghost" type="button" data-page-prev ' + (page <= 1 ? 'disabled' : '') + '>Previous</button><span>Page ' + esc(String(page)) + ' of ' + esc(String(totalPages)) + '</span><button class="btn btn-ghost" type="button" data-page-next ' + (page >= totalPages ? 'disabled' : '') + '>Next</button></div>' +
          '<p class="note">This view only reads PayPal data. Pyp does not respond to, resolve, or change disputes here.</p>';
        var schedule = results.querySelector('[data-dispute-scheduler]');
        var review = results.querySelector('[data-dispute-review]');
        function showReview(item) {
          var amount = item.amount == null ? '—' : (item.currency || '') + ' ' + item.amount;
          review.innerHTML = '<section class="dispute-review panel"><div class="dispute-review-heading"><div><h3>Review dispute</h3><p class="note">Read-only PayPal details for merchant review.</p></div><button class="btn btn-ghost" type="button" data-close-review>Close</button></div><dl class="kv">' +
            '<dt>Dispute ID</dt><dd>' + esc(item.id) + '</dd>' +
            '<dt>Status</dt><dd>' + esc(item.statusLabel || item.status || '—') + '</dd>' +
            '<dt>Reason</dt><dd>' + esc(item.reasonLabel || item.reason || '—') + '</dd>' +
            '<dt>Amount</dt><dd>' + esc(amount) + '</dd>' +
            '<dt>Created</dt><dd>' + esc(localDate(item.createdAt) || '—') + '</dd>' +
            '<dt>Response due</dt><dd>' + esc(localDate(item.responseDueDate) || '—') + '</dd>' +
            '<dt>Time remaining</dt><dd>' + esc(deadlineText(item)) + '</dd>' +
            '<dt>Transaction</dt><dd>' + esc(item.transactionId || 'Not provided by PayPal') + '</dd></dl></section>';
          review.querySelector('.dispute-review').insertAdjacentHTML('beforeend',
            '<div class="evidence-milestones"><h4>Evidence milestones</h4><ol>' +
            '<li class="is-complete"><span>1</span><div><strong>Dispute opened</strong><small>' + esc(localDate(item.createdAt) || 'Date unavailable') + '</small></div></li>' +
            '<li class="is-current"><span>2</span><div><strong>' + esc(evidenceStage(item)) + '</strong><small>Based on the current PayPal status</small></div></li>' +
            '<li><span>3</span><div><strong>Response deadline</strong><small>' + esc(localDate(item.responseDueDate) || 'Date unavailable') + '</small></div></li>' +
            '</ol><p class="note">These milestones are read-only. Pyp has not submitted evidence.</p></div>');
          review.querySelector('[data-close-review]').addEventListener('click', function () { review.innerHTML = ''; });
          if (transport.uploadDocument) mountProof(review.querySelector('.dispute-review'), item);
          review.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        // Proof for this dispute: a receipt, shipping label or courier screenshot. Pyp reads it,
        // and what it shows becomes a note its evidence can cite. Nothing goes to PayPal from here.
        function mountProof(panel, item) {
          var subject = 'dispute:' + item.id;
          panel.insertAdjacentHTML('beforeend',
            '<div class="proof"><h4>Proof for Pyp</h4><p class="note">Add a shipping receipt, tracking screenshot or delivery photo (PDF or image, up to 8 MB). Pyp reads it and uses it when it drafts your response. Nothing is sent to PayPal until you approve.</p>' +
            '<div class="proof-list" data-proof-list><div class="loading">Loading…</div></div>' +
            '<div class="proof-actions"><label class="btn btn-ghost btn-sm">Attach proof<input class="sr-label" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.pdf" data-proof-file></label>' +
            '<button type="button" class="btn btn-sm" data-proof-draft hidden>Ask Pyp to draft my response</button></div></div>');
          var list = panel.querySelector('[data-proof-list]');
          var draftBtn = panel.querySelector('[data-proof-draft]');
          function draw(docs) {
            var usable = docs.filter(function (d) { return d.status === 'read'; });
            draftBtn.hidden = !usable.length;
            list.innerHTML = docs.length ? '<ul>' + docs.map(function (d) {
              var what = d.status === 'read' ? (d.line || d.summary || 'Read.') : (d.reason || 'Pyp couldn’t use this file.');
              return '<li class="proof-item' + (d.status === 'read' ? '' : ' is-bad') + '"><div><b>' + esc(d.name) + '</b>' + (d.kind ? ' <span class="chip chip-info">' + esc(d.kind) + '</span>' : '') +
                '<p>' + esc(what) + '</p></div><button type="button" class="btn btn-ghost btn-sm" data-proof-remove="' + esc(d.id) + '" aria-label="Remove ' + esc(d.name) + '">Remove</button></li>';
            }).join('') + '</ul>' : '<p class="note">No proof attached yet.</p>';
          }
          function load() {
            return transport.documents(subject).then(function (r) { if (list.isConnected) draw(r.documents || []); }, function (e) { list.innerHTML = '<p class="setup-error">' + esc(e.message) + '</p>'; });
          }
          panel.addEventListener('change', function (e) {
            if (!e.target.matches('[data-proof-file]')) return;
            var file = e.target.files && e.target.files[0];
            e.target.value = '';
            if (!file) return;
            list.insertAdjacentHTML('afterbegin', '<div class="loading">Pyp is reading ' + esc(file.name) + '…</div>');
            transport.uploadDocument(file, subject).then(function (r) {
              toast(r.document.status === 'read' ? 'Pyp read ' + r.document.name + '.' : (r.document.reason || 'Pyp couldn’t use that file.'));
              return load();
            }, function (err) { toast(err.message); return load(); });
          });
          panel.addEventListener('click', function (e) {
            var rm = e.target.closest('[data-proof-remove]');
            if (rm) {
              rm.disabled = true;
              transport.deleteDocument(rm.getAttribute('data-proof-remove')).then(load, function (err) { rm.disabled = false; toast(err.message); });
              return;
            }
            if (e.target.closest('[data-proof-draft]')) {
              draftBtn.disabled = true;
              draftBtn.textContent = 'Pyp is drafting…';
              // The same path as typing it in chat: Pyp proposes, and the card waits for your OK.
              transport.chat({ text: 'Draft my response to dispute ' + item.id + ' using the proof I attached to it.' }).then(function (r) {
                toast(r.text || 'Done. Check your Inbox.');
              }, function (err) { toast(err.message); }).then(function () {
                if (draftBtn.isConnected) { draftBtn.disabled = false; draftBtn.textContent = 'Ask Pyp to draft my response'; }
              });
            }
          });
          load();
        }
        results.querySelectorAll('[data-review-dispute]').forEach(function (button) {
          button.addEventListener('click', function () {
            var item = disputes.find(function (dispute) { return dispute.id === button.getAttribute('data-review-dispute'); });
            if (item) showReview(item);
          });
        });
        if (schedule) {
          import('@bryntum/scheduler-community').then(function (module) {
           // Paged away or left the route while Bryntum loaded: don't attach to a stale node.
           if (thisLoad !== loadId || !schedule.isConnected) return;
           var scheduledDisputes = disputes.filter(function (item) { return item.createdAt && item.responseDueDate; });
           var resources = scheduledDisputes.map(function (item) {
             return { id: item.id, name: item.id + ' · ' + deadlineText(item), statusLabel: item.statusLabel || item.status, reasonLabel: item.reasonLabel || item.reason };
           });
           var events = [];
           scheduledDisputes.forEach(function (item) {
             var startDate = new Date(item.createdAt);
             var dueDate = new Date(item.responseDueDate);
             var stageDate = new Date(item.updatedAt || item.createdAt);
             events.push({
               id: item.id,
               resourceId: item.id,
               name: (item.reasonLabel || item.reason || 'Dispute') + ' · ' + deadlineText(item),
               startDate: startDate,
               endDate: dueDate,
               eventColor: urgencyFor(item),
               cls: 'dispute-deadline-event',
               milestoneKind: 'dispute',
               dispute: item
             });
             events.push({
               id: item.id + '-opened',
               resourceId: item.id,
               name: 'Dispute opened',
               startDate: startDate,
               endDate: new Date(startDate.getTime() + 60 * 60 * 1000),
               eventColor: 'blue',
               cls: 'dispute-milestone',
               milestoneKind: 'opened',
               dispute: item
             });
             events.push({
               id: item.id + '-stage',
               resourceId: item.id,
               name: evidenceStage(item),
               startDate: stageDate,
               endDate: new Date(stageDate.getTime() + 60 * 60 * 1000),
               eventColor: 'purple',
               cls: 'dispute-milestone',
               milestoneKind: 'stage',
               dispute: item
             });
             events.push({
               id: item.id + '-deadline',
               resourceId: item.id,
               name: 'Response deadline',
               startDate: dueDate,
               endDate: new Date(dueDate.getTime() + 60 * 60 * 1000),
               eventColor: 'red',
               cls: 'dispute-milestone dispute-milestone-deadline',
               milestoneKind: 'deadline',
               dispute: item
             });
           });
           var disputeEvents = events.filter(function (event) { return event.milestoneKind === 'dispute'; });
           if (!disputeEvents.length) {
             schedule.innerHTML = '<div class="empty">No disputes have both creation and response dates for the schedule.</div>';
             return;
           }
           // Keep today in view: old sandbox disputes would otherwise stretch the axis over months
           // or years and open it far from every live deadline. Bars older than 60 days are clipped.
           var nowTime = Date.now();
           var earliest = Math.min.apply(null, disputeEvents.map(function (event) { return new Date(event.startDate).getTime(); }));
           var latest = Math.max.apply(null, disputeEvents.map(function (event) { return new Date(event.endDate).getTime(); }));
           var start = new Date(startOfDay(Math.max(earliest, nowTime - 60 * DAY)));
           var end = new Date(startOfDay(Math.max(latest, nowTime + 7 * DAY)) + DAY);
           var spanDays = (end.getTime() - start.getTime()) / DAY;
           schedule.innerHTML = '';
           var scheduler = new module.Scheduler({
             appendTo: schedule,
             height: Math.max(190, Math.min(520, 92 + scheduledDisputes.length * 44)),
             maxHeight: 520,
             startDate: start,
             endDate: end,
             viewPreset: spanDays > 45 ? 'weekAndMonth' : 'weekAndDay',
             visibleDate: { date: new Date(nowTime), block: 'center' },
             rowHeight: 44,
             barMargin: 5,
             readOnly: true,
             features: {
               eventEdit: false,
               eventDrag: false,
               eventResize: false,
               eventTooltip: {
                 template: function (data) {
                   var item = data.eventRecord.data.dispute;
                   var amount = item.amount == null ? '—' : (item.currency || '') + ' ' + item.amount;
                   if (data.eventRecord.data.milestoneKind !== 'dispute') {
                     return '<strong>' + esc(data.eventRecord.name) + '</strong><br>' +
                       esc(item.id) + '<br>' +
                       esc(item.statusLabel || item.status || 'Unknown');
                   }
                   return '<strong>' + esc(item.reasonLabel || item.reason || 'Dispute') + '</strong><br>' +
                     esc(item.statusLabel || item.status || 'Unknown') + ' · ' + esc(amount) + '<br>' +
                     'Respond by ' + esc(localDate(item.responseDueDate) || '—') + '<br>' +
                     esc(deadlineText(item));
                 }
               }
             },
             columns: [{ text: 'Dispute', field: 'name', width: 200 }],
             resources: resources,
             events: events
           });
           currentScheduler = scheduler;
          }).catch(function (error) {
           schedule.innerHTML = '<p class="setup-error">The dispute schedule could not load: ' + esc(error.message) + '</p>';
          });
        }
        results.querySelector('[data-page-prev]').addEventListener('click', function () { page -= 1; loadDisputes(); });
        results.querySelector('[data-page-next]').addEventListener('click', function () { page += 1; loadDisputes(); });
      }).catch(function (error) {
        if (thisLoad !== loadId) return;
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
    var current = true; // the brief reads PayPal three times; don't paint over a page opened meanwhile
    cleanup.push(function () { current = false; });
    transport.brief().then(function (b) {
      if (!current) return;
      var trends = b.trends;
      var trendMarkup = '';
      if (trends) {
        // rate is null for a week with no payments: there is nothing to divide by, so show "—".
        var maxRate = Math.max.apply(null, trends.buckets.map(function (bucket) { return bucket.rate || 0; }).concat([1]));
        var bars = trends.buckets.map(function (bucket) {
          var none = bucket.rate == null;
          var height = none ? 0 : Math.max(4, Math.round(bucket.rate / maxRate * 100));
          var title = bucket.disputes + ' dispute' + (bucket.disputes === 1 ? '' : 's') + ', ' + bucket.payments + ' completed payment' + (bucket.payments === 1 ? '' : 's') +
            (none ? ': no payments, so no rate' : ', ' + bucket.rate.toFixed(1) + '% dispute rate');
          return '<div class="trend-bar-group" title="' + esc(title) + '"><div class="trend-bar" style="height:' + height + '%' + (none ? ';visibility:hidden' : '') + '"></div><strong>' + esc(none ? '—' : bucket.rate.toFixed(1) + '%') + '</strong><small>' + esc(bucket.label) + '</small></div>';
        }).join('');
        var heatmap = trends.reasons.length ? trends.reasons.map(function (row) {
          var cells = row.cells.map(function (count, index) {
            var ids = row.disputeIds[index] || [];
            var title = ids.length ? ids.join(', ') : 'No disputes';
            var intensity = count ? Math.min(1, .25 + count / 4) : 0;
            return '<td title="' + esc(title) + '" style="--heat:' + intensity + '">' + (count ? '<a href="#/disputes">' + esc(String(count)) + '</a>' : '—') + '</td>';
          }).join('');
          return '<tr><th>' + esc(row.reason) + '</th>' + cells + '</tr>';
        }).join('') : '<tr><td colspan="5" class="empty">No disputes in this period.</td></tr>';
        trendMarkup = '<section class="trend-panel"><div class="trend-heading"><div><h3>Dispute rate</h3><p class="note">Disputes opened divided by completed payments, calculated in code.</p></div><span class="trend-badge">Last 28 days</span></div><div class="trend-bars">' + bars + '</div>' +
          '<div class="trend-heading"><div><h3>Dispute reasons heatmap</h3><p class="note">Click a count to open the Disputes page. Hover a cell to see dispute IDs.</p></div></div><div class="heatmap-wrap"><table class="heatmap"><thead><tr><th>Reason</th>' + trends.buckets.map(function (bucket) { return '<th>' + esc(bucket.label) + '</th>'; }).join('') + '</tr></thead><tbody>' + heatmap + '</tbody></table></div>' +
          (trends.partial ? '<p class="note">' + esc(trends.partial) + '</p>' : '') + '</section>';
      }
      view.innerHTML =
        '<section class="panel"><h2>' + esc(b.week) + '</h2><p>' + (trends ? 'Pyp’s look at the last 28 days of your business.' : 'Pyp’s weekly look at your business.') + ' Insights only reads; it never changes anything in PayPal.</p>' +
        '<div class="stats">' + b.stats.map(function (s) {
          return '<div class="stat"><span>' + esc(s.label) + '</span><b>' + esc(s.value) + '</b><small>' + esc(s.note) + '</small></div>';
        }).join('') + '</div>' +
        trendMarkup +
        '<div class="says"><div data-fig="brief"></div><div class="bub">' + esc(b.summary) + '</div></div>' +
        '<p class="note">' + esc(b.footnote) + '</p>' +
        '<p style="margin-top:14px"><a class="btn btn-ghost" href="#/inbox">See what needs you</a></p></section>';
      fig('brief', { size: 44, mode: 'avatar' });
    });
  }

  /* ---------------- Settings ---------------- */
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
        settingsJump('Saved on the Pyp server, so they apply everywhere: this dashboard, the Chrome extension and Pyp’s daily work.') +
        '<section class="panel" id="set-pause"><h2 id="pause-t">Pause Pyp</h2><div class="pauserow"><p>' +
        (c.killSwitch ? '<b>Pyp is paused.</b> ' : '') +
        'Stops every write to PayPal at once: Approve, Auto actions waiting out their undo window, and the daily checks. Pyp keeps reading and drafting, and nothing is lost: turn it off and Approve works again.</p>' +
        '<button type="button" class="bigswitch" role="switch" aria-checked="' + c.killSwitch + '" aria-labelledby="pause-t" data-pause><span></span></button></div></section>' +

        '<section class="panel" id="set-permissions"><h2>Permissions</h2><p>What Pyp may do for each action: Off, Ask me first, or Auto (it runs after the undo window unless you tap Undo). Actions that move money or answer a request you typed always ask.</p>' +
        '<div class="skills">' + skills.map(function (sk) {
          return '<h3 class="skillhead">' + esc(SKILL_NAMES[sk] || sk) + '</h3>' + c.commands.filter(function (x) { return x.skill === sk; }).map(function (x) {
            return '<div class="skill"><div><h3 id="cmd-' + esc(x.id.replace('.', '-')) + '">' + esc(x.label) + '</h3>' + (x.canAuto ? '' : '<p>Always asks you first.</p>') + '</div>' +
              '<div class="seg" role="group" aria-labelledby="cmd-' + esc(x.id.replace('.', '-')) + '">' + ['off', 'ask', 'auto'].map(function (m) {
                var disabled = m === 'auto' && !x.canAuto;
                return '<button type="button" data-cmd="' + esc(x.id) + '" data-mode="' + m + '" aria-pressed="' + (x.dial === m) + '"' + (disabled ? ' disabled title="This always needs your approval"' : '') + '>' + MODE_LABEL[m] + '</button>';
              }).join('') + '</div></div>';
          }).join('');
        }).join('') + '</div></section>' +

        '<section class="panel" id="set-undo"><h2>Undo window</h2><p>How long an Auto action waits before it goes to PayPal, so you can tap Undo.</p><div class="limits">' +
        '<label>Undo window for Auto actions<select data-undo>' + undoChoices.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === c.undoSeconds ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
        '</div></section>' +

        '<section class="panel" id="set-checks"><h2>Daily checks</h2><p>Pyp checks these every morning from 8:00 your time. Run one now: anything that needs you shows up in your Inbox.</p>' +
        '<p class="sweeps"><button type="button" class="btn btn-ghost" data-sweep="overdue-invoices">Check overdue invoices</button> ' +
        '<button type="button" class="btn btn-ghost" data-sweep="dispute-deadlines">Check dispute deadlines</button> ' +
        '<button type="button" class="btn btn-ghost" data-sweep="weekly-brief">Weekly brief now</button></p></section>' +

        '<section class="panel" id="set-connections" data-connections></section>';
      dropJumps();
      var cx = view.querySelector('[data-connections]');
      if (cx && window.PypConnections) window.PypConnections.mount(cx, transport, { toast: toast });
    }

    function onClick(e) {
      var b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.hasAttribute('data-jump')) return jumpTo(b.getAttribute('data-jump'));
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

  /**
   * The jump bar at the top of Settings: everything stays on one page, and these
   * scroll to a section. A button shows only when its section (an element with
   * that id) is on the page; dropJumps() removes the rest after each draw.
   */
  var SETTINGS_SECTIONS = [['set-pause', 'Pause Pyp'], ['set-permissions', 'Permissions'], ['set-limits', 'Limits'], ['set-undo', 'Undo window'], ['set-checks', 'Daily checks'], ['set-extension', 'Chrome extension'], ['set-connections', 'Connections']];
  function settingsJump(note) {
    return '<nav class="settings-jump" aria-label="Settings sections"><p>' + note + '</p><div>' +
      SETTINGS_SECTIONS.map(function (s) { return '<button type="button" class="btn btn-ghost btn-sm" data-jump="' + s[0] + '">' + s[1] + '</button>'; }).join('') + '</div></nav>';
  }
  function dropJumps() {
    view.querySelectorAll('[data-jump]').forEach(function (j) { if (!document.getElementById(j.getAttribute('data-jump'))) j.remove(); });
  }
  /** Scroll to a section and move focus to its heading (keyboard and screen readers follow). */
  function jumpTo(id) {
    var to = document.getElementById(id);
    if (!to) return;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    to.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    var h = to.querySelector('h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  function renderSetup() {
    if (!transport.isDemo) return renderSetupLive();
    var s = transport.getSettings();
    var paused = transport.isPaused();
    view.innerHTML =
      settingsJump('Demo settings, saved in this browser.') +
      '<section class="panel" id="set-permissions"><h2>Permissions</h2><p>Pick, skill by skill, whether Pyp is off, asks you first, or acts on its own within your limits. Changes apply from Pyp’s next run.</p>' +
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

      '<section class="panel" id="set-limits"><h2>Limits</h2><p>Hard caps that apply even when a skill is on Auto.</p><div class="limits">' +
      '<label>Reminders per day<select data-perday>' + [1, 2, 3, 5].map(function (n) { return '<option' + (n === s.remindersPerDay ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>' +
      '<label>Undo window for Auto actions<select data-undo>' + [[30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [900, '15 minutes']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === s.undoSeconds ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
      '</div></section>' +

      '<section class="panel" id="set-pause"><h2 id="pause-t">Pause Pyp</h2><div class="pauserow"><p>' +
      'Stops everything at once. Pyp keeps watching and drafting, but nothing is sent to PayPal, and Auto timers freeze, until you turn this off.</p>' +
      '<button type="button" class="bigswitch" role="switch" aria-checked="' + paused + '" aria-labelledby="pause-t" data-pause><span></span></button></div></section>' +

      '<section class="panel" id="set-extension"><h2>Connect the Chrome extension</h2><p>The extension puts Pyp in the corner of paypal.com. Paste this code into the extension when it asks.</p>' +
      '<div class="code"><span data-code>PYP-7F3A-K29Q</span><button type="button" class="btn btn-ghost" data-copy>Copy</button></div>' +
      '<ol class="olist"><li>Install the extension (see the website’s “Get the extension” steps).</li><li>Click the Pyp icon in Chrome’s toolbar, then the settings button.</li><li>Paste the code under “Connection code” and press Connect.</li></ol>' +
      '<p class="note">UI preview: the code is a placeholder until the real API exists.</p></section>' +

      '<section class="panel"><h2>Demo data</h2><p>Put every card, the activity log and these settings back to how they started.</p>' +
      '<p style="margin-top:12px"><button type="button" class="btn btn-danger" data-reset>Reset demo data</button></p></section>';
    dropJumps();

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
    if (b.hasAttribute('data-jump')) return jumpTo(b.getAttribute('data-jump'));
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
