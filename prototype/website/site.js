// Website glue: draws the Pyp figures on the page, mounts the live inbox demo,
// and puts the real Pyp widget in the corner of this page (on demo data).
(function () {
  'use strict';

  var Fig = window.PypFigure;
  var draw = function (sel, opts) {
    document.querySelectorAll('[data-fig="' + sel + '"]').forEach(function (el) {
      el.innerHTML = Fig.svg(Object.assign({ label: '' }, opts));
    });
  };

  draw('brand', { size: 30, mode: 'idle' });
  draw('foot', { size: 26, mode: 'idle' });
  draw('hero', { size: 230, mode: 'idle', className: 'blink' });
  draw('install', { size: 56, mode: 'happy', hat: 'cap' });
  draw('tile-chat', { size: 90, mode: 'happy' });

  var hats = document.querySelector('[data-fig="tile-hats"]');
  if (hats) {
    hats.innerHTML = [
      { body: '#1F6BFF', hat: 'beanie' },
      { body: '#7B5CFA', hat: 'crown', mode: 'happy' },
      { body: '#2DBE8C', hat: 'cap' },
      { body: '#FF7A6B', hat: 'party', leaf: '#2DBE8C', mode: 'happy' },
      { body: '#FFC23D', hat: 'tophat', leaf: '#2DBE8C' }
    ].map(function (o) { return Fig.svg(Object.assign({ size: 52, mode: 'idle', label: '' }, o)); }).join('');
  }

  // Blink for the big hero Pyp (the widget has its own styles in its shadow root).
  var st = document.createElement('style');
  st.textContent =
    '.pyp-eyes{transform-box:fill-box;transform-origin:center}' +
    '.blink .pyp-eyes{animation:siteBlink 4.2s ease-in-out infinite}' +
    '@keyframes siteBlink{0%,90%,96%,100%{transform:scaleY(1)}93%{transform:scaleY(.08)}}' +
    '@media (prefers-reduced-motion: reduce){.blink .pyp-eyes{animation:none}}';
  document.head.appendChild(st);

  // The inbox section and the corner widget share one demo transport,
  // so approving a card in one shows up in the other.
  // The landing page is public: always demo data, even on :3001.
  var transport = window.PypDemo.createTransport({ persist: window.PypDemo.localPersist() });
  window.PypInbox.mount(document.getElementById('inbox-demo'), transport, { layout: 'grid' });
  var widget = window.PypWidget.mount({ transport: transport, right: 24, bottom: 24 });

  document.querySelectorAll('[data-try]').forEach(function (b) {
    b.addEventListener('click', function () { widget.open(); });
  });
})();
