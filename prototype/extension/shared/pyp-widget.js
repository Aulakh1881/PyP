/*
 * Pyp widget: the chat button in the corner and everything it opens.
 *
 *   PypWidget.mount({
 *     transport,                 // see demo-data.js for the interface
 *     prefs: { load, save },     // optional: where Pyp's look is remembered
 *     right: 24, bottom: 24,     // distance from the corner, px
 *     zIndex: 2147483000
 *   })
 *
 * Everything lives inside a shadow root, so the host page's CSS (e.g. paypal.com)
 * can't leak in and ours can't leak out.
 */
(function (root) {
  'use strict';

  var Fig = root.PypFigure;

  var PIP_COLORS = [
    { hex: '#1F6BFF', leaf: '#FFB020', label: 'Blue' },
    { hex: '#3BA7F5', leaf: '#FFB020', label: 'Sky' },
    { hex: '#7B5CFA', leaf: '#FFB020', label: 'Grape' },
    { hex: '#2DBE8C', leaf: '#FFB020', label: 'Mint' },
    { hex: '#FF7A6B', leaf: '#2DBE8C', label: 'Coral' },
    { hex: '#FFC23D', leaf: '#2DBE8C', label: 'Sunny' }
  ];
  var CHAT_COLORS = [
    { hex: '#1F5FE0', label: 'Blue' },
    { hex: '#0B1F4D', label: 'Midnight' },
    { hex: '#6A4CF0', label: 'Purple' },
    { hex: '#0F8F7E', label: 'Teal' },
    { hex: '#D9432F', label: 'Tomato' },
    { hex: '#C2336E', label: 'Berry' }
  ];
  var BOX_COLORS = [
    { id: 'mist', label: 'Mist', bg: '#F7F9FC', fg: '#0B1F4D', bd: '#C9D1DE' },
    { id: 'white', label: 'White', bg: '#FFFFFF', fg: '#0B1F4D', bd: '#C9D1DE' },
    { id: 'sky', label: 'Sky', bg: '#E6EFFF', fg: '#0B1F4D', bd: '#B7CBF2' },
    { id: 'butter', label: 'Butter', bg: '#FFF3D1', fg: '#4A3A0B', bd: '#EED796' },
    { id: 'mint', label: 'Mint', bg: '#DDF5E9', fg: '#0B3D2A', bd: '#A9DEC4' },
    { id: 'night', label: 'Night', bg: '#13234A', fg: '#FFFFFF', bd: '#13234A' }
  ];
  var DEFAULT_PREFS = { pip: '#1F6BFF', hat: 'none', chat: '#1F5FE0', box: 'mist' };

  var ICON = {
    palette: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.7-.8 1.7-1.6 0-.9-.7-1.3-.7-2.1 0-.9.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4C21 6.9 17 3 12 3z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><circle cx="7.5" cy="11.5" r="1.4" fill="currentColor"/><circle cx="10" cy="7.5" r="1.4" fill="currentColor"/><circle cx="15" cy="7.8" r="1.4" fill="currentColor"/></svg>',
    chevron: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
    send: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
    shot: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/><rect x="8" y="9" width="8" height="6" rx="1" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
    upload: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>',
    file: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg>',
    track: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.2" fill="none"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>',
    refund: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7L4 12l5 5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 12h11a5 5 0 0 1 0 10h-2" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>',
    money: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    other: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linejoin="round"/><circle cx="8.5" cy="10.5" r="1.2" fill="currentColor"/><circle cx="12" cy="10.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="10.5" r="1.2" fill="currentColor"/></svg>'
  };

  var QUICK = [
    { icon: 'track', label: 'Track a payment' },
    { icon: 'refund', label: 'Refund status' },
    { icon: 'money', label: 'Send money' },
    { icon: 'other', label: 'Something else' }
  ];

  var CSS = [
    ':host{all:initial}',
    '.w{--chat:#1F5FE0;--boxbg:#F7F9FC;--boxfg:#0B1F4D;--boxbd:#C9D1DE;--ink:#0B1F4D;--muted:#4A5B7C;font-family:Nunito,ui-rounded,"SF Pro Rounded","Segoe UI",system-ui,sans-serif;color:var(--ink);font-size:15px;line-height:1.4;-webkit-font-smoothing:antialiased}',
    '.w *{box-sizing:border-box}',
    '.w [hidden]{display:none!important}',
    'button{font-family:inherit;color:inherit}',
    'button:focus-visible,input:focus-visible,textarea:focus-visible,label:focus-within{outline:2px solid #1F6BFF;outline-offset:2px}',
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    /* launcher */
    '.launcher{position:fixed;width:72px;height:86px;border:0;padding:0;background:transparent;cursor:pointer;display:flex;align-items:flex-end;justify-content:center;transform-origin:50% 100%}',
    '.launcher .fig{filter:drop-shadow(0 6px 10px rgba(11,31,77,.22))}',
    '.launcher.hover .fig{animation:squish 260ms cubic-bezier(.3,.7,.4,1) both;filter:drop-shadow(0 10px 14px rgba(11,31,77,.28))}',
    '.launcher.drop .fig{animation:dropIn 420ms cubic-bezier(.2,.9,.3,1) both}',
    '.launcher .closebtn{width:60px;height:60px;margin-bottom:4px;border-radius:30px;background:var(--ink);color:#fff;box-shadow:0 6px 14px rgba(11,31,77,.28);display:flex;align-items:center;justify-content:center;animation:pop 220ms cubic-bezier(.2,.9,.3,1.3) 140ms both}',
    '.badge{position:absolute;top:10px;right:0;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:#FF7A2E;color:#fff;font:800 12px/22px inherit;font-family:inherit;text-align:center;box-shadow:0 0 0 2px #fff;pointer-events:none}',
    '.tip{position:fixed;background:var(--ink);color:#fff;font-size:14px;font-weight:700;padding:8px 12px;border-radius:10px;white-space:nowrap;pointer-events:none;animation:rise 160ms ease-out both}',
    '.flyer{position:fixed;width:72px;height:86px;pointer-events:none;filter:drop-shadow(0 8px 12px rgba(11,31,77,.25));transform-origin:50% 50%}',
    '.flash{position:fixed;inset:0;background:#fff;pointer-events:none;animation:flash 420ms ease-out both}',
    /* panel */
    '.panel{position:fixed;width:380px;height:min(580px,calc(100vh - 140px));background:#fff;border-radius:20px;box-shadow:0 20px 48px rgba(11,31,77,.24),0 0 0 1px rgba(11,31,77,.06);display:flex;flex-direction:column;overflow:hidden;transform-origin:92% 100%}',
    '.panel.in{animation:panelIn 440ms cubic-bezier(.2,.9,.3,1) both}.panel.out{animation:panelOut 180ms cubic-bezier(.4,0,1,1) both}',
    '.hdr{flex-shrink:0;background:var(--chat);color:#fff;padding:14px 12px 0 18px;transition:background 250ms}',
    '.hrow{display:flex;align-items:center;gap:6px}',
    '.ttl{flex:1;display:flex;flex-direction:column;gap:2px}',
    '.ttl b{font-family:"Baloo 2",Nunito,system-ui,sans-serif;font-weight:800;font-size:20px;line-height:1.1}',
    '.ttl span{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700}',
    '.ttl i{width:8px;height:8px;border-radius:4px;background:#7CF0B8;display:inline-block}',
    '.hb{width:44px;height:44px;border:0;border-radius:12px;background:rgba(255,255,255,.16);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer}',
    '.hb:hover,.hb[aria-pressed=true]{background:rgba(255,255,255,.3)}',
    '.tabs{display:flex;gap:4px;margin-top:10px}',
    '.tab{min-height:40px;padding:0 14px;border:0;border-radius:10px 10px 0 0;background:transparent;color:rgba(255,255,255,.85);font-weight:800;font-size:14px;cursor:pointer;display:flex;align-items:center;gap:6px}',
    '.tab[aria-selected=true]{background:#fff;color:var(--ink)}',
    '.tab .n{min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#FF7A2E;color:#fff;font-size:12px;line-height:20px}',
    '.tab .n:empty{display:none}',
    '.view{flex:1;min-height:0;display:flex;flex-direction:column}',
    '.view[hidden]{display:none}',
    /* chat */
    '.feed{flex:1;overflow-y:auto;scrollbar-width:thin;padding:16px;display:flex;flex-direction:column;gap:10px;background:#F7F9FC}',
    '.today{align-self:center;flex-shrink:0;font-size:12px;font-weight:800;color:var(--muted);background:#E9EEF6;padding:4px 10px;border-radius:999px}',
    '.row{display:flex;gap:8px;align-items:flex-start;flex-shrink:0}',
    '.av{width:32px;height:38px;flex-shrink:0}',
    '.av.hop{animation:hopIn 480ms cubic-bezier(.3,.7,.4,1) both}',
    '.col{display:flex;flex-direction:column;gap:3px;max-width:270px;min-width:0}',
    '.who{font-size:12px;font-weight:800;color:var(--muted)}',
    '.bub{background:#fff;border:1px solid #DCE2EC;border-radius:4px 16px 16px 16px;padding:10px 14px;font-weight:600;white-space:pre-wrap;overflow-wrap:anywhere;animation:rise 280ms ease-out both}',
    '.dots{display:flex;gap:5px;padding:13px 16px}.dots i{width:8px;height:8px;border-radius:4px;background:var(--muted);animation:dot 1s infinite}.dots i:nth-child(2){animation-delay:150ms}.dots i:nth-child(3){animation-delay:300ms}',
    '.mine{align-self:flex-end;flex-shrink:0;max-width:260px;display:flex;flex-direction:column;align-items:flex-end;gap:4px;animation:rise 220ms ease-out both}',
    '.me{background:var(--chat);color:#fff;border-radius:16px 16px 4px 16px;padding:10px 14px;font-weight:700;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.meimg{display:block;max-width:220px;max-height:180px;border-radius:16px 16px 4px 16px;border:3px solid var(--chat);object-fit:cover;background:#fff}',
    '.mefile{display:flex;align-items:center;gap:10px;background:#fff;border:1.5px solid var(--chat);border-radius:14px 14px 4px 14px;padding:10px 12px;font-size:14px;font-weight:700;color:var(--chat)}',
    '.mefile span{color:var(--ink);max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mockshot{width:200px;height:124px;border-radius:16px 16px 4px 16px;border:3px solid var(--chat);background:#F3F5F9;overflow:hidden;position:relative}',
    '.mockshot .bar{height:12px;background:#E6EAF2}.mockshot .ln{height:5px;border-radius:3px;background:#DCE2EC;margin:8px 10px 0}',
    '.tag{position:absolute;left:6px;bottom:6px;background:rgba(11,31,77,.82);color:#fff;font-size:11px;font-weight:800;padding:2px 7px;border-radius:6px}',
    '.acts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:4px 0 0 40px;flex-shrink:0}',
    '.act{display:flex;flex-direction:column;align-items:flex-start;gap:6px;text-align:left;background:#fff;border:1.5px solid #DCE2EC;border-radius:14px;padding:10px 12px;min-height:68px;cursor:pointer;font-weight:700;font-size:14px;animation:rise 260ms ease-out both}',
    '.act svg{color:var(--chat)}.act:hover{border-color:var(--chat);background:#F3F7FF}',
    '.foot{position:relative;flex-shrink:0;padding:10px 12px 8px;border-top:1px solid #E6EAF2;display:flex;flex-direction:column;gap:6px;background:#fff}',
    '.inrow{display:flex;gap:6px;align-items:center}',
    '.plus{width:44px;height:44px;flex-shrink:0;border:0;border-radius:22px;background:#F0F3F8;color:var(--chat);display:flex;align-items:center;justify-content:center;cursor:pointer}',
    '.plus svg{transition:transform 180ms}.plus[aria-expanded=true]{background:var(--chat);color:#fff}.plus[aria-expanded=true] svg{transform:rotate(45deg)}',
    '.inp{flex:1;min-width:0;height:44px;border:1.5px solid var(--boxbd);border-radius:22px;padding:0 16px;font:600 15px inherit;font-family:inherit;color:var(--boxfg);background:var(--boxbg);transition:background 250ms,color 250ms,border-color 250ms}',
    '.inp::placeholder{color:var(--boxfg);opacity:.6}',
    '.send{width:44px;height:44px;flex-shrink:0;border:0;border-radius:22px;background:var(--chat);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer}',
    '.disc{font-size:12px;font-weight:600;color:var(--muted);text-align:center}',
    '.menu{position:absolute;left:10px;bottom:calc(100% - 4px);width:240px;background:#fff;border:1px solid #DCE2EC;border-radius:16px;box-shadow:0 12px 30px rgba(11,31,77,.18);padding:6px;display:flex;flex-direction:column;gap:2px;transform-origin:10% 100%;animation:menu 180ms cubic-bezier(.2,.9,.3,1.1) both}',
    '.menu[hidden]{display:none}',
    '.mi{position:relative;display:flex;align-items:center;gap:12px;min-height:44px;padding:0 10px;border:0;border-radius:10px;background:transparent;cursor:pointer;text-align:left;font-weight:700;font-size:15px;color:var(--ink)}',
    '.mi svg{color:var(--chat)}.mi:hover{background:#F3F6FC}',
    '.chip{display:flex;align-items:center;gap:10px;background:#F3F6FC;border-radius:14px;padding:6px 6px 6px 8px;animation:rise 200ms ease-out both}',
    '.chip[hidden]{display:none}',
    '.chip .th{width:40px;height:40px;border-radius:10px;overflow:hidden;flex-shrink:0;background:#fff;border:1px solid #DCE2EC;display:flex;align-items:center;justify-content:center;color:var(--chat)}',
    '.chip .th img{width:100%;height:100%;object-fit:cover;display:block}',
    '.chip .nm{font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chip .rd{font-size:12px;font-weight:600;color:var(--muted)}',
    '.x{width:44px;height:44px;border:0;border-radius:12px;background:transparent;color:var(--muted);display:flex;align-items:center;justify-content:center;cursor:pointer}',
    /* inbox */
    '.ibx{flex:1;overflow-y:auto;padding:16px;background:#F7F9FC}',
    /* customize */
    '.cs{flex:1;overflow-y:auto;padding:16px 16px 8px;display:flex;flex-direction:column;gap:16px}',
    '.prev{display:flex;gap:14px;align-items:center;background:#F3F6FC;border-radius:16px;padding:10px 14px}',
    '.prev b{display:block;font-family:"Baloo 2",Nunito,system-ui,sans-serif;font-weight:800;font-size:20px;line-height:1.1}.prev span{font-size:13px;font-weight:600;color:var(--muted)}',
    '.sec{display:flex;flex-direction:column;gap:10px}',
    '.lab{font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}',
    '.sw{display:flex;gap:10px;flex-wrap:wrap}',
    '.c{width:36px;height:36px;border-radius:18px;border:0;padding:0;cursor:pointer}',
    '.c.sq{border-radius:10px}.c.bx{width:52px;border-radius:18px;border:1.5px solid;font-weight:800;font-size:13px}',
    '.c[aria-pressed=true]{box-shadow:0 0 0 3px #fff,0 0 0 5.5px var(--ink)}',
    '.hats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}',
    '.hat{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;min-height:84px;padding:8px 4px;border-radius:14px;background:#fff;border:2px solid #DCE2EC;font-weight:700;font-size:12px;cursor:pointer}',
    '.hat[aria-pressed=true]{background:#EEF3FF;border-color:var(--chat)}',
    '.boxprev{height:40px;border-radius:20px;border:1.5px solid var(--boxbd);background:var(--boxbg);color:var(--boxfg);display:flex;align-items:center;padding:0 16px;font-size:14px;font-weight:600}',
    '.reset{align-self:flex-start;background:none;border:0;padding:10px 0;min-height:44px;cursor:pointer;font-weight:700;font-size:14px;color:#1747B8;text-decoration:underline}',
    '.done{flex-shrink:0;padding:10px 16px 14px;border-top:1px solid #E6EAF2}',
    '.donebtn{width:100%;height:48px;border:0;border-radius:14px;background:var(--chat);color:#fff;font-weight:800;font-size:16px;cursor:pointer}',
    /* pyp eyes */
    '.pyp-eyes{transform-box:fill-box;transform-origin:center}',
    '.blink .pyp-eyes{animation:blink 4.6s ease-in-out infinite}',
    '.perk .pyp-eyes{animation:perk 460ms cubic-bezier(.3,.7,.4,1) both}',
    '@keyframes blink{0%,90%,96%,100%{transform:scaleY(1)}93%{transform:scaleY(.08)}}',
    '@keyframes perk{0%{transform:scale(1)}28%{transform:scale(1,.08)}55%{transform:scale(1)}75%{transform:scale(1.1)}100%{transform:scale(1)}}',
    '@keyframes squish{0%{transform:none}50%{transform:translateY(-2px) scale(1.08,.9)}100%{transform:translateY(-3px)}}',
    '@keyframes panelIn{0%{opacity:0;transform:translateY(18px) scale(.55)}60%{opacity:1;transform:translateY(-4px) scale(1.02)}100%{opacity:1;transform:none}}',
    '@keyframes panelOut{from{opacity:1;transform:none}to{opacity:0;transform:translateY(14px) scale(.6)}}',
    '@keyframes hopIn{0%{opacity:0;transform:translateY(-56px)}55%{opacity:1;transform:translateY(3px) scale(1.1,.88)}80%{transform:translateY(-3px) scale(.96,1.04)}100%{transform:none}}',
    '@keyframes dropIn{0%{opacity:0;transform:translateY(-44px) scale(.6)}60%{opacity:1;transform:translateY(4px) scale(1.06,.94)}100%{opacity:1;transform:none}}',
    '@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
    '@keyframes pop{from{opacity:0;transform:scale(.5)}to{opacity:1;transform:none}}',
    '@keyframes menu{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:none}}',
    '@keyframes dot{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}',
    '@keyframes flash{0%{opacity:0}15%{opacity:.9}100%{opacity:0}}',
    '@media (max-width:480px){.panel{width:calc(100vw - 24px)}}',
    '@media (prefers-reduced-motion: reduce){.w *{animation-duration:1ms!important;animation-delay:0ms!important;transition:none!important}}'
  ].join('\n');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function frame() { return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); }); }
  var reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function mount(options) {
    options = options || {};
    var transport = options.transport || root.PypDemo.createTransport();
    var prefsStore = options.prefs || {
      load: function () { try { return Promise.resolve(JSON.parse(localStorage.getItem('pyp-prefs') || '{}')); } catch (e) { return Promise.resolve({}); } },
      save: function (p) { try { localStorage.setItem('pyp-prefs', JSON.stringify(p)); } catch (e) { /* storage blocked */ } }
    };
    var right = options.right == null ? 24 : options.right;
    var bottom = options.bottom == null ? 24 : options.bottom;

    var host = document.createElement('div');
    host.setAttribute('data-pyp', '');
    host.style.cssText = 'all:initial;position:fixed;z-index:' + (options.zIndex || 2147483000) + ';top:0;left:0;width:0;height:0;';
    (options.container || document.body).appendChild(host);
    var shadow = host.attachShadow({ mode: 'open' });

    var prefs = Object.assign({}, DEFAULT_PREFS);
    var state = { open: false, view: 'chat', hover: false, started: false, attach: null, inboxCount: 0, busy: false };
    var lastAvatarRow = null;
    var typingRow = null;
    var inboxMounted = false;

    shadow.innerHTML =
      '<style>' + CSS + '</style>' +
      '<div class="w">' +
      '<div class="panel" role="dialog" aria-label="Chat with Pyp" hidden>' +
      '<header class="hdr"><div class="hrow"><div class="ttl"><b data-title>Chat with Pyp</b><span><i></i>AI assistant · ' + (transport.isDemo ? 'demo data' : 'online') + '</span></div>' +
      '<button class="hb" data-palette aria-label="Customize Pyp" aria-pressed="false">' + ICON.palette + '</button>' +
      '<button class="hb" data-min aria-label="Minimize chat">' + ICON.chevron + '</button></div>' +
      '<div class="tabs" role="tablist"><button class="tab" role="tab" data-tab="chat" aria-selected="true">Chat</button>' +
      '<button class="tab" role="tab" data-tab="inbox" aria-selected="false">Inbox <span class="n" data-count></span></button></div></header>' +
      '<section class="view" data-view="chat">' +
      '<div class="feed" aria-live="polite"><div class="today">Today</div></div>' +
      '<div class="foot">' +
      '<div class="menu" role="menu" aria-label="Add to message" hidden>' +
      '<button class="mi" role="menuitem" data-shot>' + ICON.shot + 'Screenshot this page</button>' +
      '<label class="mi" role="menuitem" tabindex="0">' + ICON.upload + 'Upload photos or files<input class="sr" type="file" data-file accept="image/*,.pdf,.txt,.csv,.doc,.docx,.xls,.xlsx"></label>' +
      '</div>' +
      '<div class="chip" hidden><div class="th" data-th></div><div style="flex:1;min-width:0"><div class="nm" data-nm></div><div class="rd">Ready to send</div></div><button class="x" data-unattach aria-label="Remove attachment">' + ICON.close + '</button></div>' +
      '<form class="inrow" data-form><button type="button" class="plus" data-plus aria-label="Add a screenshot, photo or file" aria-expanded="false" aria-haspopup="menu">' + ICON.plus + '</button>' +
      '<label class="sr" for="pyp-in">Message Pyp</label><input id="pyp-in" class="inp" data-input type="text" autocomplete="off" placeholder="Ask Pyp anything…">' +
      '<button type="submit" class="send" aria-label="Send message">' + ICON.send + '</button></form>' +
      '<div class="disc">Pyp is an AI and can make mistakes.</div>' +
      '</div></section>' +
      '<section class="view" data-view="inbox" hidden><div class="ibx"><div data-inbox></div></div></section>' +
      '<section class="view" data-view="custom" hidden><div class="cs" data-cs></div><div class="done"><button class="donebtn" data-done>Done</button></div></section>' +
      '</div>' +
      '<button class="launcher" data-launcher aria-label="Chat with Pyp" aria-expanded="false"></button>' +
      '</div>';

    var $ = function (sel) { return shadow.querySelector(sel); };
    var w = $('.w');
    var panel = $('.panel');
    var feed = $('.feed');
    var launcher = $('[data-launcher]');
    var input = $('[data-input]');
    var menu = $('.menu');
    var plus = $('[data-plus]');
    var chip = $('.chip');

    launcher.style.right = right + 'px';
    launcher.style.bottom = bottom + 'px';
    panel.style.right = right + 'px';
    panel.style.bottom = (bottom + 86 + 8) + 'px';

    function leafFor(hex) {
      for (var i = 0; i < PIP_COLORS.length; i++) if (PIP_COLORS[i].hex === hex) return PIP_COLORS[i].leaf;
      return '#FFB020';
    }
    function pip(size, mode, cls, hat, label) {
      return Fig.svg({ size: size, mode: mode, body: prefs.pip, leaf: leafFor(prefs.pip), hat: hat === undefined ? prefs.hat : hat, className: cls || '', label: label });
    }
    function box() {
      for (var i = 0; i < BOX_COLORS.length; i++) if (BOX_COLORS[i].id === prefs.box) return BOX_COLORS[i];
      return BOX_COLORS[0];
    }
    function applyTheme() {
      w.style.setProperty('--chat', prefs.chat);
      var b = box();
      w.style.setProperty('--boxbg', b.bg);
      w.style.setProperty('--boxfg', b.fg);
      w.style.setProperty('--boxbd', b.bd);
    }

    /* ---------- launcher ---------- */
    function badgeHTML() {
      return state.inboxCount ? '<span class="badge" aria-hidden="true">' + state.inboxCount + '</span>' : '';
    }
    function renderLauncher(anim) {
      if (state.open) {
        launcher.className = 'launcher';
        launcher.innerHTML = '<span class="closebtn">' + ICON.chevron + '</span>';
        launcher.setAttribute('aria-label', 'Close chat with Pyp');
        launcher.setAttribute('aria-expanded', 'true');
        return;
      }
      launcher.className = 'launcher' + (state.hover ? ' hover' : '') + (anim ? ' ' + anim : '');
      launcher.innerHTML = '<span class="fig">' + (state.hover ? pip(72, 'perk', 'perk', undefined, '') : pip(72, 'idle', 'blink', undefined, '')) + '</span>' + badgeHTML();
      launcher.setAttribute('aria-label', 'Chat with Pyp' + (state.inboxCount ? ', ' + state.inboxCount + ' things need a look' : ''));
      launcher.setAttribute('aria-expanded', 'false');
    }
    var tip = null;
    function showTip(on) {
      if (on && !tip) {
        tip = document.createElement('div');
        tip.className = 'tip';
        tip.textContent = 'Ask Pyp';
        tip.style.right = (right + 84) + 'px';
        tip.style.bottom = (bottom + 30) + 'px';
        w.appendChild(tip);
      } else if (!on && tip) {
        tip.remove();
        tip = null;
      }
    }
    function setHover(on) {
      if (state.open || state.hover === on) return;
      state.hover = on;
      renderLauncher();
      showTip(on);
    }
    launcher.addEventListener('mouseenter', function () { setHover(true); });
    launcher.addEventListener('mouseleave', function () { setHover(false); });
    launcher.addEventListener('focus', function () { if (launcher.matches(':focus-visible')) setHover(true); });
    launcher.addEventListener('blur', function () { setHover(false); });
    launcher.addEventListener('click', function () { state.open ? closePanel() : openPanel(); });

    /* ---------- flight ---------- */
    function flyTo(targetEl) {
      if (reduced || !targetEl) return Promise.resolve();
      var from = launcher.getBoundingClientRect();
      var to = targetEl.getBoundingClientRect();
      var flyer = document.createElement('div');
      flyer.className = 'flyer';
      flyer.innerHTML = pip(72, 'happy', '', undefined, '');
      flyer.style.left = (from.left + from.width / 2 - 36) + 'px';
      flyer.style.top = (from.bottom - 86) + 'px';
      w.appendChild(flyer);
      var dx = (to.left + to.width / 2) - (from.left + from.width / 2);
      var dy = (to.top + to.height / 2) - (from.bottom - 43);
      var s = to.width / 72;
      var anim = flyer.animate([
        { transform: 'none' },
        { transform: 'translate(0,6px) scale(1.12,.84)', offset: 0.15 },
        { transform: 'translate(' + dx * 0.08 + 'px,' + (-80) + 'px) scale(.92,1.06) rotate(-6deg)', offset: 0.32 },
        { transform: 'translate(' + dx * 0.8 + 'px,' + (dy - 24) + 'px) scale(' + (0.4 + s * 0.4) + ') rotate(-14deg)', offset: 0.72 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + s + ')' }
      ], { duration: 700, easing: 'cubic-bezier(.45,0,.3,1)', fill: 'forwards' });
      return anim.finished.then(function () { flyer.remove(); }, function () { flyer.remove(); });
    }

    /* ---------- panel ---------- */
    async function openPanel() {
      if (state.open) return;
      state.open = true;
      state.hover = false;
      showTip(false);
      panel.hidden = false;
      panel.classList.remove('out');
      panel.classList.add('in');
      renderLauncher();
      if (!state.started) {
        state.started = true;
        showView('chat');
        var row = addTyping(false);
        var av = row.querySelector('.av');
        av.style.visibility = 'hidden';
        await frame();
        await flyTo(av);
        av.style.visibility = '';
        var greeting = await Promise.all([transport.greet(), wait(900)]).then(function (r) { return r[0]; });
        pypSays(greeting);
        addQuickActions();
      } else if (state.view === 'chat' && lastAvatarRow) {
        var av2 = lastAvatarRow.querySelector('.av');
        av2.style.visibility = 'hidden';
        await frame();
        await flyTo(av2);
        av2.style.visibility = '';
      }
      if (state.view === 'chat') input.focus({ preventScroll: true });
    }

    function closePanel() {
      if (!state.open) return;
      state.open = false;
      closeMenu();
      panel.classList.remove('in');
      panel.classList.add('out');
      setTimeout(function () {
        if (!state.open) panel.hidden = true;
      }, 180);
      setTimeout(function () { renderLauncher('drop'); }, 180);
      launcher.focus({ preventScroll: true });
    }

    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!menu.hidden) closeMenu();
        else closePanel();
      }
    });
    $('[data-min]').addEventListener('click', closePanel);

    /* ---------- views ---------- */
    function showView(name) {
      state.view = name;
      shadow.querySelectorAll('.view').forEach(function (v) { v.hidden = v.getAttribute('data-view') !== name; });
      shadow.querySelectorAll('.tab').forEach(function (t) { t.setAttribute('aria-selected', String(t.getAttribute('data-tab') === name)); });
      $('.tabs').style.visibility = name === 'custom' ? 'hidden' : '';
      $('[data-title]').textContent = name === 'custom' ? 'Customize Pyp' : name === 'inbox' ? 'Pyp’s inbox' : 'Chat with Pyp';
      $('[data-palette]').setAttribute('aria-pressed', String(name === 'custom'));
      if (name === 'inbox' && !inboxMounted) {
        inboxMounted = true;
        root.PypInbox.mount($('[data-inbox]'), transport, { layout: 'stack', styleRoot: shadow, onCount: setCount });
      }
      if (name === 'custom') renderCustom();
      if (name === 'chat') scrollDown();
    }
    shadow.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { showView(t.getAttribute('data-tab')); });
    });
    $('[data-palette]').addEventListener('click', function () {
      showView(state.view === 'custom' ? 'chat' : 'custom');
      if (state.view === 'chat') input.focus({ preventScroll: true });
    });
    $('[data-done]').addEventListener('click', function () { showView('chat'); input.focus({ preventScroll: true }); });

    function setCount(n) {
      state.inboxCount = n;
      $('[data-count]').textContent = n ? String(n) : '';
      if (!state.open) renderLauncher();
    }

    /* ---------- chat ---------- */
    function scrollDown() {
      setTimeout(function () { feed.scrollTo({ top: feed.scrollHeight, behavior: reduced ? 'auto' : 'smooth' }); }, 30);
    }
    function hideLastAvatar() {
      if (!lastAvatarRow) return;
      lastAvatarRow.querySelector('.av').innerHTML = '';
      var who = lastAvatarRow.querySelector('.who');
      if (who) who.remove();
    }
    function addTyping(hop) {
      hideLastAvatar();
      typingRow = document.createElement('div');
      typingRow.className = 'row';
      typingRow.setAttribute('aria-label', 'Pyp is typing');
      typingRow.innerHTML = '<div class="av' + (hop ? ' hop' : '') + '" data-pipav>' + pip(32, 'avatar', 'blink', undefined, '') + '</div>' +
        '<div class="col"><div class="who">Pyp</div><div class="bub dots"><i></i><i></i><i></i></div></div>';
      feed.appendChild(typingRow);
      scrollDown();
      return typingRow;
    }
    function pypSays(text) {
      if (typingRow) { typingRow.remove(); typingRow = null; }
      var row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<div class="av" data-pipav>' + pip(32, 'avatar', 'blink', undefined, '') + '</div><div class="col"><div class="who">Pyp</div><div class="bub"></div></div>';
      row.querySelector('.bub').textContent = text;
      feed.appendChild(row);
      lastAvatarRow = row;
      scrollDown();
    }
    var quickEl = null;
    function addQuickActions() {
      quickEl = document.createElement('div');
      quickEl.className = 'acts';
      quickEl.innerHTML = QUICK.map(function (q, i) {
        return '<button class="act" style="animation-delay:' + (80 + i * 60) + 'ms" data-q="' + esc(q.label) + '">' + ICON[q.icon] + esc(q.label) + '</button>';
      }).join('');
      quickEl.addEventListener('click', function (e) {
        var b = e.target.closest('[data-q]');
        if (b) send(b.getAttribute('data-q'), null);
      });
      feed.appendChild(quickEl);
      scrollDown();
    }
    function mySays(text, att) {
      var d = document.createElement('div');
      d.className = 'mine';
      if (att) {
        if (att.kind === 'screenshot' && att.url) d.insertAdjacentHTML('beforeend', '<img class="meimg" alt="Screenshot of this page">');
        else if (att.kind === 'screenshot') d.insertAdjacentHTML('beforeend', '<div class="mockshot" role="img" aria-label="Screenshot of this page"><div class="bar"></div><div class="ln" style="width:50%"></div><div class="ln" style="width:76%"></div><div class="ln" style="width:64%"></div><span class="tag">Screenshot</span></div>');
        else if (att.kind === 'image') d.insertAdjacentHTML('beforeend', '<img class="meimg" alt="">');
        else d.insertAdjacentHTML('beforeend', '<div class="mefile">' + ICON.file + '<span></span></div>');
        var img = d.querySelector('img');
        if (img) { img.src = att.url; if (att.kind === 'image') img.alt = att.name; }
        var span = d.querySelector('.mefile span');
        if (span) span.textContent = att.name;
      }
      if (text) {
        var me = document.createElement('div');
        me.className = 'me';
        me.textContent = text;
        d.appendChild(me);
      }
      feed.appendChild(d);
      scrollDown();
    }

    async function send(text, att) {
      text = (text || '').trim();
      if (!text && !att) return;
      if (quickEl) { quickEl.remove(); quickEl = null; }
      mySays(text, att);
      await wait(320);
      addTyping(true);
      var reply;
      try {
        var r = await Promise.all([transport.chat({ text: text, attachment: att ? { kind: att.kind, name: att.name } : null }), wait(700)]);
        reply = r[0].text;
      } catch (err) {
        reply = 'Sorry, I couldn’t reach my brain just now. Try again in a moment.';
      }
      pypSays(reply);
    }

    $('[data-form]').addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value;
      var att = state.attach;
      input.value = '';
      setAttach(null);
      closeMenu();
      send(text, att);
    });

    /* ---------- + menu, screenshot, upload ---------- */
    function openMenu() { menu.hidden = false; plus.setAttribute('aria-expanded', 'true'); var f = menu.querySelector('.mi'); if (f) f.focus(); }
    function closeMenu() { menu.hidden = true; plus.setAttribute('aria-expanded', 'false'); }
    plus.addEventListener('click', function () { menu.hidden ? openMenu() : closeMenu(); });
    menu.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.matches('label.mi')) { e.preventDefault(); e.target.querySelector('input').click(); }
    });

    function setAttach(att) {
      state.attach = att;
      chip.hidden = !att;
      if (!att) return;
      var th = $('[data-th]');
      th.innerHTML = '';
      if (att.url) {
        var img = document.createElement('img');
        img.src = att.url;
        img.alt = '';
        th.appendChild(img);
      } else {
        th.innerHTML = att.kind === 'screenshot' ? ICON.shot : ICON.file;
      }
      $('[data-nm]').textContent = att.name;
    }
    $('[data-unattach]').addEventListener('click', function () { setAttach(null); input.focus(); });

    $('[data-shot]').addEventListener('click', async function () {
      closeMenu();
      var url = null;
      var failed = false;
      if (typeof transport.capture === 'function') {
        w.style.visibility = 'hidden';
        await frame();
        try { url = await transport.capture(); } catch (e) { failed = true; }
        w.style.visibility = '';
      }
      var flash = document.createElement('div');
      flash.className = 'flash';
      w.appendChild(flash);
      setTimeout(function () { flash.remove(); }, 450);
      if (failed) {
        pypSays('I couldn’t take a screenshot of this page. Click the Pyp button in your browser toolbar once to allow it, then try again.');
        return;
      }
      setAttach({ kind: 'screenshot', name: 'Screenshot of this page', url: url });
      input.focus();
    });

    $('[data-file]').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      closeMenu();
      if (!file) return;
      var isImage = /^image\//.test(file.type);
      setAttach({ kind: isImage ? 'image' : 'file', name: file.name, url: isImage ? URL.createObjectURL(file) : null });
      input.focus();
    });

    /* ---------- customize ---------- */
    function renderCustom() {
      var b = box();
      $('[data-cs]').innerHTML =
        '<div class="prev">' + pip(64, 'happy', '', undefined, '') + '<div><b>Make Pyp yours</b><span>Your picks show up everywhere Pyp does.</span></div></div>' +
        '<div class="sec"><div class="lab" id="pyp-lc">Pyp color</div><div class="sw" role="group" aria-labelledby="pyp-lc">' +
        PIP_COLORS.map(function (c) { return '<button class="c" data-pip="' + c.hex + '" aria-label="' + c.label + '" aria-pressed="' + (c.hex === prefs.pip) + '" style="background:' + c.hex + '"></button>'; }).join('') + '</div></div>' +
        '<div class="sec"><div class="lab" id="pyp-lh">Hat</div><div class="hats" role="group" aria-labelledby="pyp-lh">' +
        Fig.HATS.map(function (h) { return '<button class="hat" data-hat="' + h.id + '" aria-pressed="' + (h.id === prefs.hat) + '">' + pip(38, 'idle', '', h.id, '') + esc(h.label) + '</button>'; }).join('') + '</div></div>' +
        '<div class="sec"><div class="lab" id="pyp-lt">Chat color</div><div class="sw" role="group" aria-labelledby="pyp-lt">' +
        CHAT_COLORS.map(function (c) { return '<button class="c sq" data-chat="' + c.hex + '" aria-label="' + c.label + '" aria-pressed="' + (c.hex === prefs.chat) + '" style="background:' + c.hex + '"></button>'; }).join('') + '</div></div>' +
        '<div class="sec"><div class="lab" id="pyp-lb">Message box</div><div class="sw" role="group" aria-labelledby="pyp-lb">' +
        BOX_COLORS.map(function (c) { return '<button class="c bx" data-box="' + c.id + '" aria-label="' + c.label + '" aria-pressed="' + (c.id === b.id) + '" style="background:' + c.bg + ';color:' + c.fg + ';border-color:' + c.bd + '">Aa</button>'; }).join('') + '</div>' +
        '<div class="boxprev">Ask Pyp anything…</div></div>' +
        '<button class="reset" data-reset>Reset to classic Pyp</button>';
    }
    $('[data-cs]').addEventListener('click', function (e) {
      var t = e.target.closest('button');
      if (!t) return;
      if (t.hasAttribute('data-pip')) prefs.pip = t.getAttribute('data-pip');
      else if (t.hasAttribute('data-hat')) prefs.hat = t.getAttribute('data-hat');
      else if (t.hasAttribute('data-chat')) prefs.chat = t.getAttribute('data-chat');
      else if (t.hasAttribute('data-box')) prefs.box = t.getAttribute('data-box');
      else if (t.hasAttribute('data-reset')) prefs = Object.assign({}, DEFAULT_PREFS);
      else return;
      var focusKey = ['data-pip', 'data-hat', 'data-chat', 'data-box'].filter(function (k) { return t.hasAttribute(k); })[0];
      var focusVal = focusKey ? t.getAttribute(focusKey) : null;
      prefsChanged();
      if (focusKey) {
        var again = $('[' + focusKey + '="' + focusVal + '"]');
        if (again) again.focus();
      }
    });

    function prefsChanged() {
      applyTheme();
      renderCustom();
      shadow.querySelectorAll('[data-pipav]').forEach(function (el) {
        if (el.innerHTML) el.innerHTML = pip(32, 'avatar', 'blink', undefined, '');
      });
      renderLauncher();
      prefsStore.save(prefs);
    }

    /* ---------- start ---------- */
    function start(saved) {
      prefs = Object.assign({}, DEFAULT_PREFS, saved || {});
      applyTheme();
      renderLauncher();
      transport.inbox().then(function (d) {
        setCount(d.items.filter(function (i) { return i.state === 'open' || i.state === 'auto'; }).length);
      });
      transport.subscribe(function (items) {
        setCount(items.filter(function (i) { return i.state === 'open' || i.state === 'auto'; }).length);
      });
    }
    Promise.resolve(prefsStore.load()).then(start, function () { start({}); });

    return {
      open: openPanel,
      close: closePanel,
      showView: showView,
      setPrefs: function (p) { prefs = Object.assign({}, prefs, p); prefsChanged(); },
      destroy: function () { host.remove(); },
      host: host
    };
  }

  root.PypWidget = { mount: mount };
})(typeof window !== 'undefined' ? window : globalThis);
