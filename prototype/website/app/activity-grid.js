/*
 * Activity tab: one AG Grid (Community, MIT) with everything in one place:
 *   - PayPal sandbox payments (last 31 days), invoices and disputes, from the
 *     read-only /api/paypal/* routes on the Next.js server
 *   - Pyp's own actions (what it proposed, sent, or was told to skip)
 *
 * Sort, filter per column, search everything, filter by kind, export to CSV,
 * and click a row (or press Enter) for details. Read-only: nothing here
 * changes anything in PayPal.
 *
 *   PypActivityGrid.render(container, { transport, esc, fmtWhen, openPypDrawer, onCleanup })
 *
 * The data-shaping functions (toRows, parseAmount, …) have no DOM or AG Grid
 * dependency, so tests/activity-grid.test.mjs can run them in Node.
 */
(function (root) {
  'use strict';

  var KINDS = [
    { id: 'all', label: 'All' },
    { id: 'payment', label: 'Payments' },
    { id: 'invoice', label: 'Invoices' },
    { id: 'dispute', label: 'Disputes' },
    { id: 'pyp', label: 'Pyp actions' }
  ];
  var KIND_LABEL = { payment: 'Payment', invoice: 'Invoice', dispute: 'Dispute', pyp: 'Pyp action' };

  // Rows per request and most pages we fetch per source. PayPal allows up to
  // 100 rows per page for transactions and invoices, but only 50 for disputes,
  // and the disputes API has no page number (only a next-page token), so we
  // take the latest 50 disputes in one request.
  var PAGE_SIZE = { transactions: 100, invoices: 100, disputes: 50 };
  var MAX_PAGES = { transactions: 5, invoices: 3, disputes: 1 };

  /* ---------------- data shaping (no DOM) ---------------- */

  // "$1,200.00" -> 1200, "-18.00" -> -18, "—" / null -> null
  function parseAmount(value) {
    if (value == null) return null;
    if (typeof value === 'number') return isFinite(value) ? value : null;
    var cleaned = String(value).replace(/[^0-9.\-]/g, '');
    if (!cleaned || cleaned === '-' || cleaned === '.') return null;
    var n = Number(cleaned);
    return isFinite(n) ? n : null;
  }

  // Dates from PayPal come as "2026-10-22" or full ISO strings.
  function toIso(value) {
    if (!value) return null;
    var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T12:00:00Z' : value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function isOverdue(invoice, now) {
    if (!invoice.dueDate) return false;
    if (!/^(SENT|UNPAID|PARTIALLY_PAID|MARKED_AS_PARTIALLY_PAID)$/.test(invoice.status || '')) return false;
    var due = parseAmount(invoice.dueAmount);
    if (due != null && due <= 0) return false;
    var dueAt = new Date(invoice.dueDate + 'T23:59:59Z');
    return !isNaN(dueAt.getTime()) && dueAt.getTime() < (now || Date.now());
  }

  // Status -> colour group for the chip.
  function toneFor(kind, status) {
    var s = String(status || '').toLowerCase();
    if (/overdue|denied|waiting|needs|open|under review|required/.test(s)) return 'warn';
    if (/success|paid|done|completed|resolved|won/.test(s)) return 'good';
    if (/pending|undo|scheduled|draft|partially|sent/.test(s)) return 'info';
    return 'muted';
  }

  function fromTransaction(t) {
    return {
      id: 'tx-' + t.id,
      kind: 'payment',
      source: 'PayPal',
      when: toIso(t.date),
      what: t.typeLabel || t.type || 'Transaction',
      who: t.subject || '',
      amount: parseAmount(t.amount),
      currency: t.currency || 'USD',
      status: t.statusLabel || t.status || '',
      ref: t.id,
      raw: t
    };
  }

  function fromInvoice(inv, now) {
    var overdue = isOverdue(inv, now);
    return {
      id: 'inv-' + inv.id,
      kind: 'invoice',
      source: 'PayPal',
      when: toIso(inv.date),
      what: 'Invoice ' + (inv.number || inv.id),
      who: inv.recipient || '',
      amount: parseAmount(inv.amount),
      currency: inv.currency || 'USD',
      status: overdue ? 'Overdue' : (inv.statusLabel || inv.status || ''),
      ref: inv.number || inv.id,
      raw: inv
    };
  }

  function fromDispute(d) {
    return {
      id: 'dsp-' + d.id,
      kind: 'dispute',
      source: 'PayPal',
      when: toIso(d.createdAt),
      what: d.reasonLabel || d.reason || 'Dispute',
      who: '',
      amount: parseAmount(d.amount),
      currency: d.currency || 'USD',
      status: d.statusLabel || d.status || '',
      ref: d.id,
      raw: d
    };
  }

  function fromPyp(a) {
    return {
      id: 'pyp-' + a.id,
      kind: 'pyp',
      source: 'Pyp',
      when: toIso(a.when),
      what: a.action,
      who: a.target || '',
      amount: parseAmount(a.amount),
      currency: 'USD',
      status: a.status || '',
      ref: a.run ? 'run ' + a.run.id : '',
      skill: a.skill,
      raw: a
    };
  }

  function toRows(data, now) {
    data = data || {};
    var rows = []
      .concat((data.transactions || []).map(fromTransaction))
      .concat((data.invoices || []).map(function (i) { return fromInvoice(i, now); }))
      .concat((data.disputes || []).map(fromDispute))
      .concat((data.pyp || []).map(fromPyp));
    rows.forEach(function (r) { r.tone = toneFor(r.kind, r.status); });
    rows.sort(function (a, b) { return (b.when || '') < (a.when || '') ? -1 : (b.when || '') > (a.when || '') ? 1 : 0; });
    return rows;
  }

  function countByKind(rows) {
    var c = { all: rows.length, payment: 0, invoice: 0, dispute: 0, pyp: 0 };
    rows.forEach(function (r) { c[r.kind] = (c[r.kind] || 0) + 1; });
    return c;
  }

  function formatMoney(amount, currency) {
    if (amount == null) return '—';
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount);
    } catch (e) {
      return (currency || '') + ' ' + amount.toFixed(2);
    }
  }

  /* ---------------- fetching ---------------- */

  async function fetchAllPages(load, maxPages) {
    var all = [];
    var page = 1;
    var totalPages = 1;
    do {
      var res = await load(page);
      all = all.concat(res.items || []);
      totalPages = res.totalPages || 1;
      page += 1;
    } while (page <= totalPages && page <= maxPages);
    return { items: all, truncated: totalPages > maxPages };
  }

  function last31Days() {
    var end = new Date();
    var start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    var iso = function (d) { return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); };
    return { startDate: iso(start), endDate: iso(end) };
  }

  async function loadEverything(transport) {
    var range = last31Days();
    var jobs = {
      transactions: typeof transport.transactions === 'function'
        ? fetchAllPages(function (page) {
          return transport.transactions({ startDate: range.startDate, endDate: range.endDate, page: page, pageSize: PAGE_SIZE.transactions })
            .then(function (d) { return { items: d.transactions, totalPages: d.totalPages }; });
        }, MAX_PAGES.transactions)
        : Promise.reject(new Error('not available')),
      invoices: typeof transport.invoices === 'function'
        ? fetchAllPages(function (page) {
          return transport.invoices({ page: page, pageSize: PAGE_SIZE.invoices })
            .then(function (d) { return { items: d.invoices, totalPages: d.totalPages }; });
        }, MAX_PAGES.invoices)
        : Promise.reject(new Error('not available')),
      disputes: typeof transport.disputes === 'function'
        ? fetchAllPages(function (page) {
          return transport.disputes({ page: page, pageSize: PAGE_SIZE.disputes })
            .then(function (d) { return { items: d.disputes, totalPages: d.totalPages }; });
        }, MAX_PAGES.disputes)
        : Promise.reject(new Error('not available')),
      pyp: transport.activity().then(function (items) { return { items: items, truncated: false }; })
    };
    var names = Object.keys(jobs);
    var settled = await Promise.allSettled(names.map(function (n) { return jobs[n]; }));
    var data = {};
    var problems = [];
    var truncated = [];
    settled.forEach(function (s, i) {
      var name = names[i];
      if (s.status === 'fulfilled') {
        data[name] = s.value.items || [];
        if (s.value.truncated) truncated.push(name);
      } else {
        data[name] = [];
        problems.push({ source: name, message: (s.reason && s.reason.message) || 'Unavailable' });
      }
    });
    return { data: data, problems: problems, truncated: truncated };
  }

  /* ---------------- UI ---------------- */

  var SOURCE_NAME = { transactions: 'payments', invoices: 'invoices', disputes: 'disputes', pyp: 'Pyp’s actions' };

  function render(container, deps) {
    var esc = deps.esc;
    var fmtWhen = deps.fmtWhen;
    var api = null;
    var rows = [];
    var kind = 'all';
    var destroyed = false;

    container.innerHTML =
      '<section class="panel activity-panel">' +
      '<div class="activity-head"><div><h2>Everything in one place</h2>' +
      '<p>Payments, invoices and disputes from your PayPal sandbox, plus every action Pyp proposed or took. Sort any column, filter, search, or click a row for details.</p></div>' +
      '<div class="activity-actions"><button type="button" class="btn btn-ghost" data-refresh>Refresh</button>' +
      '<button type="button" class="btn btn-ghost" data-export>Export CSV</button></div></div>' +
      '<div class="activity-tools">' +
      '<div class="tabs" role="group" aria-label="Show">' + KINDS.map(function (k) {
        return '<button type="button" data-kind="' + k.id + '" aria-pressed="' + (k.id === kind) + '">' + k.label + ' <span class="n" data-kcount="' + k.id + '"></span></button>';
      }).join('') + '</div>' +
      '<label class="activity-search"><span class="sr-label">Search all columns</span><input type="search" data-search placeholder="Search customers, IDs, statuses…"></label>' +
      '</div>' +
      '<div class="activity-notice" data-notice role="status" aria-live="polite"></div>' +
      '<div class="activity-grid" data-grid></div>' +
      '<p class="note">Read-only: this view never changes anything in PayPal. Payments cover the last 31 days (PayPal’s reporting limit). Table by AG Grid.</p>' +
      '</section>';

    var gridEl = container.querySelector('[data-grid]');
    var notice = container.querySelector('[data-notice]');
    var search = container.querySelector('[data-search]');

    if (!root.agGrid || typeof root.agGrid.createGrid !== 'function') {
      gridEl.innerHTML = '<div class="empty">The table library (AG Grid) didn’t load. Check your internet connection and reload the page.</div>';
      return;
    }

    function chip(text, tone) {
      return '<span class="chip chip-' + tone + '">' + esc(text) + '</span>';
    }

    var columnDefs = [
      {
        field: 'when', headerName: 'When', minWidth: 160, flex: 1, sort: 'desc',
        filter: 'agDateColumnFilter',
        valueGetter: function (p) { return p.data.when ? new Date(p.data.when) : null; },
        valueFormatter: function (p) { return p.value ? fmtWhen(p.value.toISOString()) : '—'; },
        filterParams: {
          comparator: function (filterDate, cellValue) {
            if (!cellValue) return -1;
            var day = new Date(cellValue.getFullYear(), cellValue.getMonth(), cellValue.getDate());
            return day < filterDate ? -1 : day > filterDate ? 1 : 0;
          }
        },
        getQuickFilterText: function (p) { return p.value ? fmtWhen(p.value.toISOString()) : ''; }
      },
      {
        field: 'kind', headerName: 'Type', minWidth: 120, flex: 0.8,
        valueFormatter: function (p) { return KIND_LABEL[p.value] || p.value; },
        cellRenderer: function (p) { return '<span class="kind kind-' + esc(p.value) + '">' + esc(KIND_LABEL[p.value] || p.value) + '</span>'; },
        filterValueGetter: function (p) { return KIND_LABEL[p.data.kind]; },
        getQuickFilterText: function (p) { return KIND_LABEL[p.value]; }
      },
      { field: 'what', headerName: 'What happened', minWidth: 190, flex: 1.6, cellClass: 'cell-strong', tooltipField: 'what' },
      { field: 'who', headerName: 'Customer / for', minWidth: 170, flex: 1.3, valueFormatter: function (p) { return p.value || '—'; } },
      {
        field: 'amount', headerName: 'Amount', minWidth: 120, flex: 0.9, type: 'rightAligned',
        filter: 'agNumberColumnFilter',
        // Blank amounts always sort to the bottom, whichever way you sort.
        comparator: function (a, b, nodeA, nodeB, isDescending) {
          if (a == null && b == null) return 0;
          if (a == null) return isDescending ? -1 : 1;
          if (b == null) return isDescending ? 1 : -1;
          return a - b;
        },
        valueFormatter: function (p) { return formatMoney(p.value, p.data.currency); },
        cellClassRules: { 'cell-negative': function (p) { return p.value != null && p.value < 0; } },
        getQuickFilterText: function (p) { return formatMoney(p.value, p.data.currency); }
      },
      {
        field: 'status', headerName: 'Status', minWidth: 150, flex: 1, tooltipField: 'status',
        cellRenderer: function (p) { return p.value ? chip(p.value, p.data.tone) : '—'; }
      },
      { field: 'ref', headerName: 'Reference', minWidth: 150, flex: 1, cellClass: 'cell-mono', tooltipField: 'ref', valueFormatter: function (p) { return p.value || '—'; } }
    ];

    var theme = root.agGrid.themeQuartz.withParams({
      fontFamily: 'Nunito, ui-rounded, "Segoe UI", system-ui, sans-serif',
      fontSize: 14,
      headerFontWeight: 800,
      headerFontSize: 12,
      headerTextColor: '#4A5B7C',
      headerBackgroundColor: '#FAFBFD',
      foregroundColor: '#0B1F4D',
      accentColor: '#1F5FE0',
      borderColor: '#E2E8F2',
      rowHoverColor: '#F3F7FF',
      selectedRowBackgroundColor: '#E6EFFF',
      wrapperBorderRadius: 18,
      borderRadius: 10,
      rowHeight: 48,
      headerHeight: 44,
      spacing: 7
    });

    api = root.agGrid.createGrid(gridEl, {
      theme: theme,
      columnDefs: columnDefs,
      rowData: [],
      getRowId: function (p) { return p.data.id; },
      defaultColDef: { sortable: true, filter: true, floatingFilter: true, resizable: true, suppressHeaderMenuButton: false },
      pagination: true,
      paginationPageSize: 25,
      paginationPageSizeSelector: [25, 50, 100],
      animateRows: true,
      tooltipShowDelay: 400,
      rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
      overlayLoadingTemplate: '<span class="grid-overlay">Loading your activity…</span>',
      overlayNoRowsTemplate: '<span class="grid-overlay">Nothing matches. Try a different filter or search.</span>',
      isExternalFilterPresent: function () { return kind !== 'all'; },
      doesExternalFilterPass: function (node) { return node.data.kind === kind; },
      onRowClicked: function (e) { openDetails(e.data); },
      onCellKeyDown: function (e) {
        if (e.event && e.event.key === 'Enter' && e.data) openDetails(e.data);
      },
      loading: true
    });

    function openDetails(r) {
      if (r.kind === 'pyp' && r.raw && r.raw.run) {
        deps.openPypDrawer(r.raw, gridEl);
        return;
      }
      openPayPalDrawer(r);
    }

    function openPayPalDrawer(r) {
      var raw = r.raw || {};
      var details = [['Type', KIND_LABEL[r.kind]], ['When', r.when ? fmtWhen(r.when) : '—'], ['Amount', formatMoney(r.amount, r.currency)], ['Status', r.status || '—']];
      var link = '';
      if (r.kind === 'payment') {
        details.push(['Customer', r.who || '—'], ['Transaction ID', raw.id], ['Fee', raw.fee == null ? '—' : formatMoney(parseAmount(raw.fee), r.currency)], ['Net', raw.net == null ? '—' : formatMoney(parseAmount(raw.net), r.currency)]);
        if (raw.orderId) link = '<a class="btn btn-ghost" href="#/orders?order_id=' + encodeURIComponent(raw.orderId) + '">Open order ' + esc(raw.orderId) + '</a>';
      } else if (r.kind === 'invoice') {
        details.push(['Customer', r.who || '—'], ['Invoice', raw.number || raw.id], ['Issued', raw.date || '—'], ['Due', raw.dueDate || '—'], ['Still owed', raw.dueAmount == null ? '—' : formatMoney(parseAmount(raw.dueAmount), r.currency)]);
        link = '<a class="btn btn-ghost" href="#/invoices">See all invoices</a>';
      } else if (r.kind === 'dispute') {
        details.push(['Reason', r.what], ['Dispute ID', raw.id], ['Reply by', raw.responseDueDate ? raw.responseDueDate.slice(0, 10) : '—'], ['Transaction', raw.transactionId || '—']);
        link = '<a class="btn btn-ghost" href="#/disputes">See all disputes</a>';
      }
      var d = document.createElement('div');
      d.className = 'drawer';
      d.innerHTML =
        '<section class="sheet" role="dialog" aria-modal="true" aria-labelledby="ag-dr-t">' +
        '<div class="sheethead"><h2 id="ag-dr-t">' + esc(r.what) + '</h2><button type="button" data-close aria-label="Close"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg></button></div>' +
        '<dl class="kv">' + details.map(function (kv) { return '<dt>' + esc(kv[0]) + '</dt><dd>' + esc(kv[1]) + '</dd>'; }).join('') + '</dl>' +
        (link ? '<p>' + link + '</p>' : '') +
        '<p class="note">From your PayPal sandbox, read-only. Pyp didn’t change anything here.</p>' +
        '</section>';
      document.body.appendChild(d);
      var closeBtn = d.querySelector('[data-close]');
      closeBtn.focus();
      function close() { d.remove(); document.removeEventListener('keydown', onKey); gridEl.focus(); }
      function onKey(e) {
        if (e.key === 'Escape') close();
        if (e.key === 'Tab') {
          var focusables = d.querySelectorAll('button, a[href]');
          var first = focusables[0];
          var last = focusables[focusables.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      d.addEventListener('click', function (e) {
        if (e.target === d || e.target.closest('[data-close]')) close();
        else if (e.target.closest('a[href^="#"]')) { d.remove(); document.removeEventListener('keydown', onKey); }
      });
      document.addEventListener('keydown', onKey);
    }

    function showCounts() {
      var c = countByKind(rows);
      KINDS.forEach(function (k) {
        var el = container.querySelector('[data-kcount="' + k.id + '"]');
        if (el) el.textContent = String(c[k.id] || 0);
      });
    }

    function showNotice(problems, truncated) {
      var parts = [];
      var paypalDown = problems.filter(function (p) { return p.source !== 'pyp'; });
      if (paypalDown.length === 3) {
        parts.push('Couldn’t reach your PayPal sandbox data, so only Pyp’s actions are shown. Make sure <code>npm run dev</code> is running on port 3000 and you’re signed in.');
      } else if (paypalDown.length) {
        parts.push('Couldn’t load ' + paypalDown.map(function (p) { return esc(SOURCE_NAME[p.source]); }).join(' and ') + ': ' + esc(paypalDown[0].message));
      }
      if (truncated.length) {
        parts.push('Showing the most recent ' + truncated.map(function (t) { return esc(SOURCE_NAME[t]); }).join(' and ') + ' only.');
      }
      notice.innerHTML = parts.join(' ');
      notice.hidden = !parts.length;
    }

    function load() {
      api.setGridOption('loading', true);
      loadEverything(deps.transport).then(function (result) {
        if (destroyed) return;
        rows = toRows(result.data);
        api.setGridOption('rowData', rows);
        api.setGridOption('loading', false);
        showCounts();
        showNotice(result.problems, result.truncated);
      });
    }

    container.querySelector('.tabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-kind]');
      if (!b) return;
      kind = b.getAttribute('data-kind');
      container.querySelectorAll('[data-kind]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      api.onFilterChanged();
    });
    search.addEventListener('input', function () { api.setGridOption('quickFilterText', search.value); });
    container.querySelector('[data-refresh]').addEventListener('click', load);
    container.querySelector('[data-export]').addEventListener('click', function () {
      api.exportDataAsCsv({
        fileName: 'pyp-activity.csv',
        processCellCallback: function (p) {
          var f = p.column.getColId();
          if (f === 'when') return p.value ? p.value.toISOString() : '';
          if (f === 'kind') return KIND_LABEL[p.value] || p.value;
          return p.value == null ? '' : p.value;
        }
      });
    });

    // Pyp's own actions change as you approve cards; keep the grid in sync.
    if (typeof deps.transport.subscribe === 'function' && typeof deps.onCleanup === 'function') {
      deps.onCleanup(deps.transport.subscribe(function () {
        deps.transport.activity().then(function (items) {
          if (destroyed) return;
          var pypRows = toRows({ pyp: items });
          rows = rows.filter(function (r) { return r.kind !== 'pyp'; }).concat(pypRows);
          api.setGridOption('rowData', rows);
          showCounts();
        });
      }));
    }

    if (typeof deps.onCleanup === 'function') {
      deps.onCleanup(function () { destroyed = true; if (api) api.destroy(); });
    }

    load();
  }

  var exported = { render: render, toRows: toRows, parseAmount: parseAmount, isOverdue: isOverdue, countByKind: countByKind, formatMoney: formatMoney, toneFor: toneFor };
  root.PypActivityGrid = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof window !== 'undefined' ? window : globalThis);
