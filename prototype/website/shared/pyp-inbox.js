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
    '.pypx-grid{display:grid;gap:22px;grid-template-columns:repeat(3,minmax(0,1fr))}',
    '@media (max-width:1180px){.pypx-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}',
    '@media (max-width:720px){.pypx-grid{grid-template-columns:1fr}}',
    '.pypx.stack .pypx-head{margin-bottom:12px}.pypx.stack .pypx-hello h2{font-size:22px}.pypx.stack .pypx-sum{font-size:14px}',
    '.pypx.stack .pypx-grid{grid-template-columns:1fr;gap:12px}',
    '.pypx-card{perspective:1400px;min-height:280px}',
    '.pypx.stack .pypx-card{min-height:220px}',
    '.pypx-inner{position:relative;display:grid;width:100%;height:100%;min-height:inherit;transition:transform 520ms cubic-bezier(.3,.7,.3,1);transform-style:preserve-3d}',
    '.pypx-card.flipped .pypx-inner{transform:rotateY(180deg)}',
    '.pypx-face{position:relative;grid-area:1/1;min-width:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;background:#fff;border:1px solid var(--line);border-radius:22px;box-shadow:0 10px 30px rgba(11,31,77,.07);padding:22px;display:flex;flex-direction:column;gap:10px;overflow:hidden}',
    '.pypx.stack .pypx-face{padding:16px;border-radius:18px;gap:8px}',
    '.pypx-back{transform:rotateY(180deg);position:absolute;inset:0}',
    '.pypx-top{display:flex;align-items:center;gap:10px}',
    '.pypx-ico{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0}',
    '.pypx-label{font-size:13px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}',
    '.pypx-badge{margin-left:auto;font-size:13px;font-weight:800;padding:5px 11px;border-radius:999px;white-space:nowrap}',
    '.b-blue{background:#E6EFFF;color:#1747B8}.b-amber{background:#FFF0D6;color:#8A4B00}.b-green{background:#DDF5E9;color:#0B6B47}.b-done{background:#0E7A50;color:#fff}.b-gray{background:#EEF1F6;color:#4A5B7C}',
    '.pypx-title{margin:2px 0 0;font-size:22px;line-height:1.2;font-weight:800}',
    '.pypx.stack .pypx-title{font-size:18px}',
    '.pypx-meta{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:600;color:var(--muted)}.pypx-meta b{color:var(--ink);font-weight:800}',
    '.pypx-box{border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:4px;margin-top:4px;max-height:180px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}',
    '.pypx-box .e{font-size:13px;font-weight:800;letter-spacing:.09em;text-transform:uppercase}',
    '.pypx-box .t{font-size:17px;line-height:1.35;font-weight:800}.pypx-box .s{font-size:15px;line-height:1.45;font-weight:600;color:var(--muted)}.pypx-box .s:empty{display:none}',
    '.x-blue{background:#EAF1FF}.x-blue .e{color:#1747B8}.x-amber{background:#FFF4E2}.x-amber .e{color:#8A4B00}.x-green{background:#E3F6EC}.x-green .e{color:#0B6B47}.x-gray{background:#F2F4F8}.x-gray .e{color:#4A5B7C}',
    '.pypx-draft{display:flex;flex-direction:column;gap:6px;margin-top:4px}',
    '.pypx-draft label{font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#8A4B00}',
    '.pypx-draft textarea{width:100%;min-height:110px;resize:vertical;border:1.5px solid #EED796;border-radius:12px;padding:10px 12px;font:600 14px/1.45 inherit;font-family:inherit;color:var(--ink);background:#FFFBF2}',
    '.pypx-draft textarea:focus{outline:2px solid #1F6BFF;outline-offset:1px}',
    '.pypx-foot{margin-top:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:8px}',
    '.pypx-btn{min-height:40px;padding:0 16px;border-radius:10px;border:1.5px solid transparent;white-space:nowrap;font:800 14px/1 inherit;font-family:inherit;cursor:pointer;transition:transform 120ms,background 120ms,border-color 120ms}',
    '.pypx-btn:active{transform:scale(.97)}.pypx-btn:disabled{cursor:default;transform:none}.pypx-btn:disabled:not(.s-success){opacity:.5;cursor:not-allowed}',
    '.pypx-btn:focus-visible,.pypx-flip:focus-visible{outline:2px solid #1F6BFF;outline-offset:2px}',
    /* One look per role. primary: the one main action. secondary/outline: another step (Edit, Undo).
       quiet: a way out (Dismiss, Remove from Inbox). choice: an answer to Pyp's question. */
    '.s-primary{background:#1F5FE0;color:#fff}.s-primary:hover:not(:disabled){background:#1A52C4}',
    '.s-secondary,.s-outline{background:#fff;color:var(--ink);border-color:#D3DBE8}.s-secondary:hover:not(:disabled),.s-outline:hover:not(:disabled){border-color:#9FB2D4;background:#F7F9FD}',
    '.s-quiet{background:transparent;color:var(--muted);padding:0 10px}.s-quiet:hover:not(:disabled){background:#F1F4F9;color:var(--ink)}',
    '.s-success{background:#0E7A50;color:#fff}',
    '.pypx-choices{display:flex;flex-direction:column;gap:8px;margin-top:2px}',
    '.s-choice{width:100%;justify-content:flex-start;text-align:left;display:flex;align-items:center;gap:10px;min-height:44px;white-space:normal;line-height:1.3;padding:8px 14px;background:#fff;color:var(--ink);border-color:#D3DBE8;font-weight:700;font-size:15px}',
    '.s-choice::before{content:"";width:14px;height:14px;flex-shrink:0;border-radius:50%;border:2px solid #9FB2D4}',
    '.s-choice:hover:not(:disabled){border-color:#1F5FE0;background:#F3F7FF}.s-choice:hover:not(:disabled)::before{border-color:#1F5FE0}',
    '.pypx-flip{margin-left:auto;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:0 4px;background:none;border:0;color:#1747B8;font:800 14px/1 inherit;font-family:inherit;cursor:pointer}',
    '.pypx-flip:hover{text-decoration:underline}',
    '.pypx-bhead{display:flex;align-items:baseline;gap:10px}',
    '.pypx-bhead h3{margin:0;font-size:19px;font-weight:800}',
    '.pypx-run{margin-left:auto;font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);white-space:nowrap}',
    '.pypx-steps{list-style:none;margin:4px 0 0;padding:0 4px 0 0;display:flex;flex-direction:column;gap:9px;flex:1;min-height:0;overflow-y:auto}',
    '.pypx-steps li{display:grid;grid-template-columns:64px 12px 1fr;gap:8px;align-items:start;font-size:13.5px;line-height:1.4;font-weight:600}',
    '.pypx-steps time{font:600 11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}',
    '.pypx-steps .dot{width:10px;height:10px;border-radius:5px;border:2px solid #1F6BFF;margin-top:4px}',
    '.pypx-tag{display:inline-block;font:800 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;padding:3px 6px;border-radius:5px;margin-right:6px;background:#EEF1F6;color:#4A5B7C;vertical-align:1px}',
    '.t-ai{background:#EEE8FF;color:#5B3CC4}.t-safety{background:#FFF0D6;color:#8A4B00}.t-action{background:#DDF5E9;color:#0B6B47}.t-check,.t-policy{background:#E6EFFF;color:#1747B8}',
    '.d-ai{border-color:#7B5CFA!important}.d-safety{border-color:#E59A1A!important}.d-action{border-color:#0E7A50!important;background:#0E7A50}',
    '.pypx-bfoot{display:flex;align-items:center;gap:8px;border-top:1px solid var(--line);padding-top:6px;font-size:13px;font-weight:700;color:var(--muted)}',
    '.pypx-rnote{margin:6px 0 0;font-size:13px;font-weight:700;color:#8A4B00}',
    '.pypx-empty{margin:0;padding:28px;border:1.5px dashed var(--line);border-radius:18px;text-align:center;font-size:16px;font-weight:700;color:var(--muted);background:#fff}',
    '.pypx-paused{display:flex;align-items:center;gap:10px;margin:0 0 16px;padding:12px 16px;border-radius:14px;background:#FFF0D6;color:#6B3A00;font-size:15px;font-weight:800}',
    '@media (prefers-reduced-motion: reduce){.pypx-inner{transition:none}}'
  ].join('\n');

  var ICONS = {
    invoice: { bg: '#E6EFFF', fg: '#1747B8', path: '<path d="M7 3h7l4 4v14H7z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M10 11h5M10 15h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
    dispute: { bg: '#FFF0D6', fg: '#A35A00', path: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M12 8v4M12 15.5v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' },
    insight: { bg: '#EEE8FF', fg: '#5B3CC4', path: '<path d="M5 20V10M12 20V4M19 20v-7" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round"/>' },
    other: { bg: '#EEF1F6', fg: '#4A5B7C', path: '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 11v5M12 8v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' },
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
    function button(b) {
      var label = b.countdown && (item.undoEndsAt || item.pausedLeft != null) ? countdownLabel(item) : b.label;
      return '<button type="button" class="pypx-btn s-' + b.style + '" data-act="' + b.id + '"' + (b.disabled ? ' disabled' : '') +
        (b.countdown ? ' data-countdown="1"' : '') + '>' + esc(label) + '</button>';
    }
    // Answers to Pyp's question are a list of choices; everything else sits in the footer.
    var choices = item.buttons.filter(function (b) { return b.style === 'choice'; }).map(button).join('');
    var buttons = item.buttons.filter(function (b) { return b.style !== 'choice'; }).map(button).join('');

    var middle = item.reviewing
      ? '<div class="pypx-draft"><label for="d-' + item.id + '">Pyp’s draft · edit before sending</label>' +
        '<textarea id="d-' + item.id + '" data-draft>' + esc(draftValue != null ? draftValue : item.draft) + '</textarea>' +
        (item.reviewNote ? '<p class="pypx-rnote" role="status">' + esc(item.reviewNote) + '</p>' : '') + '</div>'
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
      (choices ? '<div class="pypx-choices" role="group" aria-label="Your answer">' + choices + '</div>' : '') +
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
        (transport.isPaused && transport.isPaused() ? '<p class="pypx-paused" role="status">' + (transport.isDemo ? 'Pyp is paused. Nothing will be sent to PayPal until you resume it in Setup.' : 'Pyp is paused (kill switch). Nothing goes to PayPal until you turn it off in Setup.') + '</p>' : '') +
        (function () {
          var shown = filter ? data.items.filter(filter) : data.items;
          if (!shown.length) return '<p class="pypx-empty">' + esc(options.emptyText || 'Nothing here right now.') + '</p>';
          return '<div class="pypx-grid">' + shown.map(function (it) { return cardHTML(it, !!flipped[it.id], drafts[it.id]); }).join('') + '</div>';
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
