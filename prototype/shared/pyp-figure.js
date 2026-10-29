/*
 * Pyp figure: draws Pyp as an SVG string.
 * Used by the chat widget, the inbox, the website and the extension popup.
 *
 *   PypFigure.svg({ size: 72, mode: 'idle', body: '#1F6BFF', leaf: '#FFB020', hat: 'none', className: '' })
 *
 * modes: idle | perk (hover: bigger eyes) | happy (closed ^ ^ eyes) | avatar (bigger dot eyes, no glints)
 * hats:  none | beanie | cap | party | crown | tophat | bow
 */
(function (root) {
  'use strict';

  var VIEWBOX = '40 -24 320 380';
  var RATIO = 380 / 320;

  var LEAF = 'M196 126 C186 90 206 56 254 44 C242 70 244 100 220 126 Z';
  var LEAF_UP = 'M196 126 C182 86 210 50 262 40 C246 68 246 100 220 126 Z';
  var BODY = 'M200 118 C292 118 332 180 332 250 C332 316 290 346 200 346 C110 346 68 316 68 250 C68 180 108 118 200 118 Z';
  var INK = '#0B1F4D';

  var FACES = {
    idle:
      '<g class="pyp-eyes"><ellipse cx="168" cy="236" rx="14" ry="19" fill="' + INK + '"/><ellipse cx="232" cy="236" rx="14" ry="19" fill="' + INK + '"/>' +
      '<circle cx="172" cy="229" r="5" fill="#fff"/><circle cx="236" cy="229" r="5" fill="#fff"/></g>',
    perk:
      '<g class="pyp-eyes"><ellipse cx="168" cy="232" rx="17" ry="22" fill="' + INK + '"/><ellipse cx="232" cy="232" rx="17" ry="22" fill="' + INK + '"/>' +
      '<circle cx="174" cy="223" r="6.5" fill="#fff"/><circle cx="238" cy="223" r="6.5" fill="#fff"/>' +
      '<circle cx="163" cy="240" r="2.5" fill="#fff"/><circle cx="227" cy="240" r="2.5" fill="#fff"/></g>',
    happy:
      '<path d="M150 242 Q168 222 186 242 M214 242 Q232 222 250 242" stroke="' + INK + '" stroke-width="13" fill="none" stroke-linecap="round"/>',
    avatar:
      '<g class="pyp-eyes"><ellipse cx="168" cy="236" rx="18" ry="24" fill="' + INK + '"/><ellipse cx="232" cy="236" rx="18" ry="24" fill="' + INK + '"/></g>'
  };

  var HATS = {
    beanie: '<path d="M106 168 C100 62 300 62 294 168 Z" fill="#E8505B"/><rect x="94" y="146" width="212" height="36" rx="18" fill="#C63F4A"/><circle cx="200" cy="60" r="22" fill="#FFF3F0"/>',
    cap: '<path d="M112 160 C112 72 288 72 288 160 Z" fill="#13306B"/><path d="M262 150 C306 146 344 152 356 166 C330 174 290 172 262 166 Z" fill="#0B1F4D"/><circle cx="200" cy="80" r="9" fill="#fff"/>',
    party: '<g transform="rotate(-10 200 140)"><path d="M146 146 L200 -6 L254 146 Z" fill="#FF6B8A"/><circle cx="188" cy="92" r="8" fill="#FFD86B"/><circle cx="216" cy="120" r="8" fill="#FFD86B"/><circle cx="200" cy="52" r="7" fill="#FFD86B"/><circle cx="200" cy="-8" r="15" fill="#FFD86B"/></g>',
    crown: '<path d="M126 154 L116 66 L160 106 L200 44 L240 106 L284 66 L274 154 Z" fill="#FFC83D" stroke="#E0A419" stroke-width="6" stroke-linejoin="round"/><circle cx="200" cy="128" r="10" fill="#FF6B8A"/><circle cx="156" cy="132" r="7" fill="#2ECC8F"/><circle cx="244" cy="132" r="7" fill="#2ECC8F"/>',
    tophat: '<rect x="138" y="20" width="124" height="120" rx="10" fill="#1A1F2E"/><rect x="138" y="104" width="124" height="20" fill="#E8505B"/><ellipse cx="200" cy="142" rx="104" ry="18" fill="#1A1F2E"/>',
    bow: '<g transform="rotate(-20 130 150)"><path d="M130 150 L92 124 L96 178 Z" fill="#FF6B8A"/><path d="M130 150 L168 124 L164 178 Z" fill="#FF6B8A"/><circle cx="130" cy="150" r="13" fill="#E04A6E"/></g>'
  };

  var HAT_LIST = [
    { id: 'none', label: 'None' },
    { id: 'beanie', label: 'Beanie' },
    { id: 'cap', label: 'Cap' },
    { id: 'party', label: 'Party' },
    { id: 'crown', label: 'Crown' },
    { id: 'tophat', label: 'Top hat' },
    { id: 'bow', label: 'Bow' }
  ];

  function heightFor(size) {
    return Math.round(size * RATIO);
  }

  function svg(opts) {
    opts = opts || {};
    var size = opts.size || 72;
    var mode = FACES[opts.mode] ? opts.mode : 'idle';
    var hat = HATS[opts.hat] ? opts.hat : 'none';
    var body = opts.body || '#1F6BFF';
    var leafColor = opts.leaf || '#FFB020';
    var showLeaf = hat === 'none' || hat === 'bow';
    var leafUp = mode === 'perk' || mode === 'happy';
    var label = opts.label === undefined ? 'Pyp' : opts.label;
    var a11y = label ? ' role="img" aria-label="' + label + '"' : ' aria-hidden="true"';
    return (
      '<svg class="' + (opts.className || '') + '" width="' + size + '" height="' + heightFor(size) + '" viewBox="' + VIEWBOX + '"' + a11y +
      ' style="display:block;overflow:visible">' +
      (showLeaf ? '<path d="' + (leafUp ? LEAF_UP : LEAF) + '" fill="' + leafColor + '"/>' : '') +
      '<path d="' + BODY + '" fill="' + body + '"/>' +
      FACES[mode] +
      (hat === 'none' ? '' : HATS[hat]) +
      '</svg>'
    );
  }

  root.PypFigure = { svg: svg, heightFor: heightFor, HATS: HAT_LIST };
})(typeof window !== 'undefined' ? window : globalThis);
