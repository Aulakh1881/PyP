/*
 * Pyp inbox: the card view ("Pyp handled 4 things overnight. 3 need a look.").
 *
 *   PypInbox.mount(container, transport, { layout: 'grid' | 'stack', styleRoot: document | shadowRoot })
 *
 * Each card says what happened and what Pyp suggests. "How I got here" flips the
 * card to show the timestamped log of the run that produced it.
 */
(function (root) {
  'use strict';

  var CSS = [
    '.pypx{--ink:#0B1F4D;--muted:#4A5B7C;--line:#E2E8F2;--blue:#1F6BFF;font-family:Nunito,ui-rounded,"SF Pro Rounded","Segoe UI",system-ui,sans-serif;color:var(--ink)}',
    '.pypx *{box-sizing:border-box}',
    '.pypx-head{display:flex;flex-direction:column;gap:6px;margin-bottom:20px}',
    '.pypx-hello{display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
    '.pypx-hello h2{margin:0;font-family:"Baloo 2",Nunito,system-ui,sans-serif;font-weight:800;font-size:clamp(28px,5vw,40px);line-height:1.05;letter-spacing:-.01em}',
    '.pypx-demo{font:800 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;color:#8A5A00;background:#FFF4D6;border:1px solid #F2D58A;border-radius:6px;padding:5px 8px}',
    '.pypx-sum{margin:0;font-size:18px;font-weight:600;color:var(--muted)}.pypx-sum b{color:var(--ink);font-weight:800}',
    '.pypx-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr))}',
    '.pypx-decks{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr));gap:18px;align-items:start}',
    '.pypx-deck{border:1px solid var(--line);border-radius:18px;background:#F7F9FD;padding:14px;transition:box-shadow 180ms,transform 180ms}',
    '.pypx-deck:hover{box-shadow:0 8px 24px rgba(11,31,77,.08)}',
    '.pypx-deckhead{display:flex;align-items:center;gap:10px;margin-bottom:12px;cursor:pointer}',
    '.pypx-decktitle{margin:0;font-size:17px;font-weight:800}.pypx-deckcount{min-width:24px;padding:2px 8px;border-radius:999px;background:var(--ink);color:#fff;font-size:12px;text-align:center}',
    '.pypx-decktoggle{margin-left:auto;min-height:34px;padding:0 10px;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink);font:800 12px inherit;font-family:inherit;cursor:pointer}',
    '.pypx-decktoggle:hover{background:#EAF1FF;color:#1747B8}.pypx-decktoggle::after{content:"";}',
    '.pypx-deck:not(.is-expanded) .pypx-grid{display:grid;grid-template-columns:1fr;grid-template-rows:1fr;gap:0;padding-bottom:18px;overflow:visible}',
    '.pypx-deck:not(.is-expanded) .pypx-card{grid-column:1;grid-row:1;transition:transform 300ms cubic-bezier(.4,.2,.2,1)}',
    '.pypx-deck:not(.is-expanded) .pypx-card:nth-child(1){z-index:3}',
    '.pypx-deck:not(.is-expanded) .pypx-card:nth-child(2){z-index:2;transform:translateY(8px)}',
    '.pypx-deck:not(.is-expanded) .pypx-card:nth-child(3){z-index:1;transform:translateY(16px)}',
    '.pypx-deck:not(.is-expanded) .pypx-card:not(:nth-child(-n+3)){display:none}',
    '.pypx-deck:not(.is-expanded):hover .pypx-card:nth-child(1){transform:translateY(-3px)}',
    '.pypx-deck:not(.is-expanded):hover .pypx-card:nth-child(2){transform:translateY(24px)}',
    '.pypx-deck:not(.is-expanded):hover .pypx-card:nth-child(3){transform:translateY(48px)}',
    '.pypx-deck.is-expanded .pypx-grid{grid-template-columns:1fr;gap:12px}',
    '.pypx.stack .pypx-head{margin-bottom:12px}.pypx.stack .pypx-hello h2{font-size:22px}.pypx.stack .pypx-sum{font-size:14px}',
    '.pypx.stack .pypx-grid{grid-template-columns:1fr;gap:12px}',
    '.pypx-card{perspective:1400px;min-height:0;transition:min-height 280ms ease}',
    '.pypx-card.flipped{min-height:380px}',
    '.pypx.stack .pypx-card{min-height:0}.pypx.stack .pypx-card.flipped{min-height:360px}',
    '.pypx-inner{position:relative;display:grid;width:100%;height:100%;min-height:inherit;transition:transform 520ms cubic-bezier(.3,.7,.3,1);transform-style:preserve-3d}',
    '.pypx-card.flipped .pypx-inner{transform:rotateY(180deg)}',
    '.pypx-face{position:relative;grid-area:1/1;min-width:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 4px 16px rgba(11,31,77,.05);padding:14px;display:flex;flex-direction:column;gap:6px;overflow:hidden}',
    '.pypx.stack .pypx-face{padding:14px;border-radius:16px;gap:6px}',
    '.pypx-back{transform:rotateY(180deg)}',
    '.pypx-top{display:flex;align-items:center;gap:10px}',
    '.pypx-ico{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0}',
    '.pypx-label{font-size:13px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}',
    '.pypx-badge{margin-left:auto;font-size:13px;font-weight:800;padding:5px 11px;border-radius:999px;white-space:nowrap}',
    '.b-blue{background:#E6EFFF;color:#1747B8}.b-amber{background:#FFF0D6;color:#8A4B00}.b-green{background:#DDF5E9;color:#0B6B47}.b-done{background:#0E7A50;color:#fff}.b-gray{background:#EEF1F6;color:#4A5B7C}',
    '.pypx-title{margin:0;font-size:16px;line-height:1.25;font-weight:800}',
    '.pypx.stack .pypx-title{font-size:16px}',
    '.pypx-meta{margin:0;font-size:13px;font-weight:600;color:var(--muted)}.pypx-meta b{color:var(--ink);font-weight:800}',
    '.pypx-box{border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:1px;margin-top:2px}',
    '.pypx-box .e{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}',
    '.pypx-box .t{font-size:14px;font-weight:800}.pypx-box .s{font-size:12px;font-weight:600;color:var(--muted)}',
    '.x-blue{background:#EAF1FF}.x-blue .e{color:#1747B8}.x-amber{background:#FFF4E2}.x-amber .e{color:#8A4B00}.x-green{background:#E3F6EC}.x-green .e{color:#0B6B47}.x-gray{background:#F2F4F8}.x-gray .e{color:#4A5B7C}',
    '.pypx-draft{display:flex;flex-direction:column;gap:6px;margin-top:4px}',
    '.pypx-draft label{font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#8A4B00}',
    '.pypx-draft textarea{width:100%;min-height:110px;resize:vertical;border:1.5px solid #EED796;border-radius:12px;padding:10px 12px;font:600 14px/1.45 inherit;font-family:inherit;color:var(--ink);background:#FFFBF2}',
    '.pypx-draft textarea:focus{outline:2px solid #1F6BFF;outline-offset:1px}',
    '.pypx-foot{margin-top:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:4px}',
    '.pypx-btn{min-height:38px;padding:0 14px;border-radius:10px;border:0;font:800 14px/1 inherit;font-family:inherit;cursor:pointer;transition:transform 120ms,filter 120ms}',
    '.pypx-btn:active{transform:scale(.97)}.pypx-btn:disabled{cursor:default;transform:none}.pypx-btn:disabled:not(.s-success){opacity:.5;cursor:not-allowed}',
    '.pypx-btn:focus-visible,.pypx-flip:focus-visible{outline:2px solid #1F6BFF;outline-offset:2px}',
    '.s-primary{background:#1F5FE0;color:#fff}.s-primary:hover:not(:disabled){filter:brightness(1.08)}',
    '.s-secondary{background:#EEF1F6;color:var(--ink)}.s-secondary:hover{background:#E4E8F0}',
    '.s-success{background:#0E7A50;color:#fff}',
    '.s-outline{background:#fff;color:#0B6B47;border:1.5px solid #7FD3AE}',
    '.pypx-flip{margin-left:auto;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;min-height:38px;padding:0 4px;background:none;border:0;color:#1747B8;font:700 13px/1 inherit;font-family:inherit;cursor:pointer}',
    '.pypx-flip:hover{text-decoration:underline}',
    '.pypx-bhead{display:flex;align-items:baseline;gap:10px}',
    '.pypx-bhead h3{margin:0;font-size:19px;font-weight:800}',
    '.pypx-run{margin-left:auto;font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);white-space:nowrap}',
    '.pypx-steps{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:9px;flex:1}',
    '.pypx-steps li{display:grid;grid-template-columns:64px 12px 1fr;gap:8px;align-items:start;font-size:13.5px;line-height:1.4;font-weight:600}',
    '.pypx-steps time{font:600 11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}',
    '.pypx-steps .dot{width:10px;height:10px;border-radius:5px;border:2px solid #1F6BFF;margin-top:4px}',
    '.pypx-tag{display:inline-block;font:800 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;padding:3px 6px;border-radius:5px;margin-right:6px;background:#EEF1F6;color:#4A5B7C;vertical-align:1px}',
    '.t-ai{background:#EEE8FF;color:#5B3CC4}.t-safety{background:#FFF0D6;color:#8A4B00}.t-action{background:#DDF5E9;color:#0B6B47}.t-check,.t-policy{background:#E6EFFF;color:#1747B8}',
    '.d-ai{border-color:#7B5CFA!important}.d-safety{border-color:#E59A1A!important}.d-action{border-color:#0E7A50!important;background:#0E7A50}',
    '.pypx-bfoot{display:flex;align-items:center;gap:8px;border-top:1px solid var(--line);padding-top:6px;font-size:13px;font-weight:700;color:var(--muted)}',
    '.pypx-empty{margin:0;padding:28px;border:1.5px dashed var(--line);border-radius:18px;text-align:center;font-size:16px;font-weight:700;color:var(--muted);background:#fff}',
    '.pypx-paused{display:flex;align-items:center;gap:10px;margin:0 0 16px;padding:12px 16px;border-radius:14px;background:#FFF0D6;color:#6B3A00;font-size:15px;font-weight:800}',
    '.pypx-deckico{width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0}',
    '@media (prefers-reduced-motion: reduce){.pypx-inner,.pypx-card,.pypx-deck:not(.is-expanded) .pypx-card{transition:none}}'
  ].join('\n');

  var ICONS = {
    invoice: { bg: '#E6EFFF', fg: '#1747B8', path: '<path d="M7 3h7l4 4v14H7z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M10 11h5M10 15h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
    dispute: { bg: '#FFF0D6', fg: '#A35A00', path: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M12 8v4M12 15.5v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' },
    refund: { bg: '#DDF5E9', fg: '#0B6B47', path: '<path d="M9 7L4 12l5 5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 12h11a5 5 0 0 1 0 10h-2" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/>' }
  };
  var FLIP_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14-4.9M4 4v4h4M4 13a8 8 0 0 0 14 4.9M20 20v-4h-4" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function injectStyle(styleRoot) {
    var target = styleRoot && styleRoot.nodeType === 11 ? styleRoot : (styleRoot && styleRoot.head) || document.head;
    if (target.querySelector && target.querySelector('style[data-pypx]')) return;
    var st = document.createElement('style');
    st.setAttribute('data-pypx', '');
    st.textContent = CSS;
    target.appendChild(st);
  }

  function countdownLabel(item) {
    var ms = item.undoEndsAt ? item.undoEndsAt - Date.now() : (item.pausedLeft || 0);
    var left = Math.max(0, Math.ceil(ms / 1000));
    return (item.undoEndsAt ? 'Undo · ' : 'Paused · Undo · ') + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
  }

  function cardHTML(item, flipped, draftValue) {
    var ic = ICONS[item.kind] || ICONS.invoice;
    var buttons = item.buttons.map(function (b) {
      var label = b.countdown && (item.undoEndsAt || item.pausedLeft != null) ? countdownLabel(item) : b.label;
      return '<button type="button" class="pypx-btn s-' + b.style + '" data-act="' + b.id + '"' + (b.disabled ? ' disabled' : '') +
        (b.countdown ? ' data-countdown="1"' : '') + '>' + esc(label) + '</button>';
    }).join('');

    var middle = item.reviewing
      ? '<div class="pypx-draft"><label for="d-' + item.id + '">Pyp’s draft · edit before sending</label>' +
        '<textarea id="d-' + item.id + '" data-draft>' + esc(draftValue != null ? draftValue : item.draft) + '</textarea></div>'
      : '<div class="pypx-box x-' + item.box.tone + '"><span class="e">' + esc(item.box.eyebrow) + '</span><span class="t">' + esc(item.box.title) + '</span><span class="s">' + esc(item.box.sub) + '</span></div>';

    var steps = item.run.steps.map(function (s) {
      var k = s.tag.toLowerCase();
      return '<li><time>' + esc(s.time) + '</time><span class="dot d-' + k + '"></span><span><span class="pypx-tag t-' + k + '">' + esc(s.tag) + '</span>' + esc(s.text) + '</span></li>';
    }).join('');

    return (
      '<article class="pypx-card' + (flipped ? ' flipped' : '') + '" data-id="' + item.id + '" aria-label="' + esc(item.label + ': ' + item.title) + '">' +
      '<div class="pypx-inner">' +
      '<section class="pypx-face pypx-front"' + (flipped ? ' aria-hidden="true"' : '') + '>' +
      '<div class="pypx-top"><span class="pypx-ico" style="background:' + ic.bg + ';color:' + ic.fg + '"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">' + ic.path + '</svg></span>' +
      '<span class="pypx-label">' + esc(item.label) + '</span><span class="pypx-badge b-' + item.badge.tone + '">' + esc(item.badge.text) + '</span></div>' +
      '<h3 class="pypx-title">' + esc(item.title) + '</h3>' +
      '<p class="pypx-meta">' + (item.amount ? '<b>' + esc(item.amount) + '</b> · ' : '') + esc(item.meta) + '</p>' +
      middle +
      '<div class="pypx-foot">' + buttons + '<button type="button" class="pypx-flip" data-flip' + (flipped ? ' tabindex="-1"' : '') + '>' + FLIP_ICON + 'How I got here</button></div>' +
      '</section>' +
      '<section class="pypx-face pypx-back"' + (flipped ? '' : ' aria-hidden="true"') + '>' +
      '<div class="pypx-bhead"><h3>How Pyp got here</h3><span class="pypx-run">run ' + esc(item.run.id) + ' · ' + esc(item.run.date) + '</span></div>' +
      '<ol class="pypx-steps">' + steps + '</ol>' +
      '<div class="pypx-bfoot"><span>' + esc(item.run.footer) + '</span><button type="button" class="pypx-flip" data-flip' + (flipped ? '' : ' tabindex="-1"') + '>' + FLIP_ICON + 'Flip back</button></div>' +
      '</section>' +
      '</div></article>'
    );
  }

  function mount(container, transport, options) {
    options = options || {};
    injectStyle(options.styleRoot || document);
    var flipped = {};
    var drafts = {};
    var timer = null;
    var data = null;
    var filter = options.filter || null;
    var deckOpen = {};

    container.classList.add('pypx');
    if (options.layout === 'stack') container.classList.add('stack');

    function render() {
      if (!data) return;
      var open = data.items.filter(function (i) { return i.state === 'open' || i.state === 'auto'; }).length;
      container.innerHTML =
        (options.header === false ? '' :
          '<header class="pypx-head"><div class="pypx-hello"><h2>' + esc(data.greeting) + '</h2>' +
          (transport.isDemo ? '<span class="pypx-demo">DEMO DATA</span>' : '') + '</div>' +
          '<p class="pypx-sum">' + esc(data.summary) + ' <b>' + (open ? open + ' need' + (open === 1 ? 's' : '') + ' a look.' : 'You’re all caught up.') + '</b></p></header>') +
        (transport.isPaused && transport.isPaused() ? '<p class="pypx-paused" role="status">' + (transport.isDemo ? 'Pyp is paused. Nothing will be sent to PayPal until you resume it in Setup.' : 'Approvals from this browser are paused. Resume them in Setup.') + '</p>' : '') +
        (function () {
          var shown = filter ? data.items.filter(filter) : data.items;
          if (!shown.length) return '<p class="pypx-empty">' + esc(options.emptyText || 'Nothing here right now.') + '</p>';
          var groups = {};
          var groupOrder = ['invoice', 'dispute', 'refund', 'pyp'];
          var groupLabels = { invoice: 'Invoices', dispute: 'Disputes', refund: 'Refunds', pyp: 'Pyp activity' };
          shown.slice().sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }).forEach(function (item) {
            var kind = groupLabels[item.kind] ? item.kind : 'pyp';
            if (!groups[kind]) groups[kind] = [];
            groups[kind].push(item);
          });
          return '<div class="pypx-decks">' + groupOrder.filter(function (kind) { return groups[kind] && groups[kind].length; }).map(function (kind) {
            var items = groups[kind];
            var expanded = !!deckOpen[kind];
            var visible = expanded ? items : items.slice(0, 3);
            var dico = ICONS[kind] || ICONS.invoice;
            return '<section class="pypx-deck' + (expanded ? ' is-expanded' : '') + '" data-deck="' + kind + '"><div class="pypx-deckhead" data-deck-toggle="' + kind + '" role="button" tabindex="0" aria-expanded="' + expanded + '"><span class="pypx-deckico" style="background:' + dico.bg + ';color:' + dico.fg + '"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">' + dico.path + '</svg></span><h3 class="pypx-decktitle">' + groupLabels[kind] + '</h3><span class="pypx-deckcount">' + items.length + '</span>' +
              (items.length > 3 ? '<button type="button" class="pypx-decktoggle" data-deck-toggle="' + kind + '" aria-expanded="' + expanded + '">' + (expanded ? 'Collapse' : 'Show all') + '</button>' : '') +
              '</div><div class="pypx-grid">' + visible.map(function (it) { return cardHTML(it, !!flipped[it.id], drafts[it.id]); }).join('') + '</div></section>';
          }).join('') + '</div>';
        })();
      if (typeof options.onCount === 'function') options.onCount(open);
      startTimer();
    }

    function startTimer() {
      clearInterval(timer);
      var running = data.items.some(function (i) { return i.undoEndsAt; });
      if (!running) return;
      timer = setInterval(function () {
        data.items.forEach(function (it) {
          if (!it.undoEndsAt) return;
          var btn = container.querySelector('[data-id="' + it.id + '"] [data-countdown]');
          if (btn) btn.textContent = countdownLabel(it);
          if (Date.now() >= it.undoEndsAt && !(transport.isPaused && transport.isPaused())) transport.act(it.id, 'timer-done');
        });
      }, 250);
    }

    container.addEventListener('click', function (e) {
      var deckToggle = e.target.closest('[data-deck-toggle]');
      if (deckToggle) {
        var deckKind = deckToggle.getAttribute('data-deck-toggle');
        deckOpen[deckKind] = !deckOpen[deckKind];
        render();
        return;
      }
      var card = e.target.closest('.pypx-card');
      if (!card) return;
      var id = card.getAttribute('data-id');
      if (e.target.closest('[data-flip]')) {
        flipped[id] = !flipped[id];
        card.classList.toggle('flipped', flipped[id]);
        var faces = card.querySelectorAll('.pypx-face');
        faces[0].toggleAttribute('aria-hidden', flipped[id]);
        faces[1].toggleAttribute('aria-hidden', !flipped[id]);
        var target = card.querySelector(flipped[id] ? '.pypx-back [data-flip]' : '.pypx-front [data-flip]');
        if (target) setTimeout(function () { target.focus(); }, 300);
        return;
      }
      var btn = e.target.closest('[data-act]');
      if (btn && !btn.disabled) {
        var action = btn.getAttribute('data-act');
        var extra = action === 'send' ? { draft: drafts[id] } : undefined;
        transport.act(id, action, extra);
      }
    });

    container.addEventListener('keydown', function (e) {
      var deckToggle = e.target.closest('[data-deck-toggle]');
      if (!deckToggle || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      var deckKind = deckToggle.getAttribute('data-deck-toggle');
      deckOpen[deckKind] = !deckOpen[deckKind];
      render();
    });

    container.addEventListener('input', function (e) {
      if (e.target.matches('[data-draft]')) {
        drafts[e.target.closest('.pypx-card').getAttribute('data-id')] = e.target.value;
      }
    });

    var unsubscribe = transport.subscribe(function (items) {
      if (!data) return;
      data = Object.assign({}, data, { items: items });
      var active = container.ownerDocument.activeElement;
      var hadFocusIn = active && container.contains(active) ? active.closest('.pypx-card') : null;
      render();
      if (hadFocusIn) {
        var again = container.querySelector('[data-id="' + hadFocusIn.getAttribute('data-id') + '"] .pypx-front .pypx-btn:not(:disabled), [data-id="' + hadFocusIn.getAttribute('data-id') + '"] .pypx-front [data-flip]');
        if (again) again.focus();
      }
    });

    transport.inbox().then(function (d) { data = d; render(); });

    return {
      setFilter: function (fn, emptyText) { filter = fn; if (emptyText) options.emptyText = emptyText; render(); },
      destroy: function () { clearInterval(timer); unsubscribe(); container.innerHTML = ''; }
    };
  }

  root.PypInbox = { mount: mount, CSS: CSS };
})(typeof window !== 'undefined' ? window : globalThis);
