/* Pyp dashboard: Workflows.
 *
 * The merchant's own rules, drawn as blocks: When (something happens in PayPal,
 * or a day of the week) → If (a check) → Then (what Pyp should do). The same
 * workflow can be edited two ways, to try both:
 *   Guided  blocks snap into a top-to-bottom flow; + adds the next step, and an
 *           If splits into Yes and Otherwise lanes
 *   Canvas  drag blocks anywhere and draw arrows from a block's dots to another
 *
 * The server checks every workflow (engine/workflows.ts) and runs it: code walks
 * the diagram, and a Then only shapes what Pyp proposes. Nothing here writes to PayPal.
 */
(function (root) {
  'use strict';

  var VIEW_KEY = 'pyp.workflows.view';
  var NODE_W = 270;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function newId() { return 'n' + Math.random().toString(36).slice(2, 9); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function loadView() { try { return localStorage.getItem(VIEW_KEY) === 'canvas' ? 'canvas' : 'guided'; } catch (e) { return 'guided'; } }
  function saveView(v) { try { localStorage.setItem(VIEW_KEY, v); } catch (e) { /* blocked */ } }

  // Ready-made workflows to start from.
  var TEMPLATES = [
    {
      name: 'Big invoices: ask me first',
      blurb: 'Overdue and $500 or more? Pyp asks you. Smaller ones get a friendly reminder.',
      graph: {
        nodes: [
          { id: 'w', type: 'when', trigger: 'invoice_overdue' },
          { id: 'c', type: 'if', field: 'amount', op: 'gte', value: '500' },
          { id: 'a', type: 'then', action: 'ask_me' },
          { id: 'r', type: 'then', action: 'remind', params: { tone: 'friendly' } }
        ],
        edges: [{ from: 'w', to: 'c' }, { from: 'c', to: 'a', branch: 'yes' }, { from: 'c', to: 'r', branch: 'no' }]
      }
    },
    {
      name: 'No tracking? Offer a refund',
      blurb: 'A dispute with tracking gets it sent as proof; without, Pyp proposes a full refund.',
      graph: {
        nodes: [
          { id: 'w', type: 'when', trigger: 'dispute_opened' },
          { id: 'c', type: 'if', field: 'has_tracking', op: 'is', value: 'yes' },
          { id: 'p', type: 'then', action: 'send_proof' },
          { id: 'o', type: 'then', action: 'offer_refund' }
        ],
        edges: [{ from: 'w', to: 'c' }, { from: 'c', to: 'p', branch: 'yes' }, { from: 'c', to: 'o', branch: 'no' }]
      }
    },
    {
      name: 'Monday check-in',
      blurb: 'Every Monday: look at overdue invoices and make the weekly brief.',
      graph: {
        nodes: [
          { id: 'w', type: 'when', trigger: 'weekly', params: { weekday: 'Mon' } },
          { id: 'o', type: 'then', action: 'check_overdue' },
          { id: 'b', type: 'then', action: 'weekly_brief' }
        ],
        edges: [{ from: 'w', to: 'o' }, { from: 'w', to: 'b' }]
      }
    },
    {
      name: 'Heads-up before it’s due',
      blurb: 'Three days before an invoice is due, Pyp asks if you want to nudge them.',
      graph: {
        nodes: [
          { id: 'w', type: 'when', trigger: 'invoice_due_soon', params: { days: 3 } },
          { id: 'a', type: 'then', action: 'ask_me' }
        ],
        edges: [{ from: 'w', to: 'a' }]
      }
    },
    {
      name: 'Tell me about big payments',
      blurb: 'When an invoice of $1,000 or more is paid, a heads-up in your Inbox.',
      graph: {
        nodes: [
          { id: 'w', type: 'when', trigger: 'invoice_paid' },
          { id: 'c', type: 'if', field: 'amount', op: 'gte', value: '1000' },
          { id: 't', type: 'then', action: 'tell_me' }
        ],
        edges: [{ from: 'w', to: 'c' }, { from: 'c', to: 't', branch: 'yes' }]
      }
    }
  ];

  function render(view, transport, helpers) {
    var toast = helpers.toast;
    var cleanup = helpers.cleanup;
    if (!transport.workflows) {
      view.innerHTML = '<section class="panel"><h2>Workflows</h2><p>Workflows are saved on the Pyp server. Sign in to the live dashboard to build them.</p></section>';
      return;
    }

    var data = null;      // { workflows, catalog, error }
    var editing = null;   // { id, name, enabled, graph } while the editor is open
    var problems = [];    // from the last save
    var mode = loadView();
    var dirty = false;
    var drag = null;      // canvas: a block being moved, or an arrow being drawn

    function load() {
      return transport.workflows().then(function (d) { data = d; if (!editing) drawList(); }, function (e) {
        view.innerHTML = '<section class="panel"><h2>Workflows</h2><p class="setup-error">' + esc(e.message) + '</p></section>';
      });
    }

    // ---------- catalog helpers ----------
    function cat() { return data.catalog; }
    function trig(id) { return cat().triggers.filter(function (t) { return t.id === id; })[0]; }
    function act(id) { return cat().actions.filter(function (a) { return a.id === id; })[0]; }
    function whenNode(g) { return g.nodes.filter(function (n) { return n.type === 'when'; })[0]; }
    function subjectOf(g) { var w = whenNode(g); var t = w && trig(w.trigger); return t ? t.subject : null; }
    function fieldsFor(subject) { return cat().fields.filter(function (f) { return f.subject === subject; }); }
    function field(subject, id) { return fieldsFor(subject).filter(function (f) { return f.id === id; })[0]; }
    function actionsFor(triggerId) { return cat().actions.filter(function (a) { return a.triggers.indexOf(triggerId) >= 0; }); }
    function node(id) { return editing.graph.nodes.filter(function (n) { return n.id === id; })[0]; }
    function kids(id, branch) {
      return editing.graph.edges.filter(function (e) { return e.from === id && (e.branch || null) === (branch || null); }).map(function (e) { return node(e.to); }).filter(Boolean);
    }
    function defaults(params) {
      var out = {};
      (params || []).forEach(function (p) { out[p.key] = p.default; });
      return out;
    }

    // ---------- the list ----------
    function drawList() {
      editing = null;
      var list = data.workflows.map(function (w) {
        var draft = w.problems && w.problems.length;
        var status = w.enabled ? '<span class="chip chip-good">On</span>' : draft ? '<span class="chip chip-warn">Draft: ' + w.problems.length + ' to fix</span>' : '<span class="chip chip-muted">Off</span>';
        return '<article class="wf-item" data-wf="' + esc(w.id) + '">' +
          '<div class="wf-item-main"><h3>' + esc(w.name) + ' ' + status + '</h3><p>' + esc(w.summary) + '</p></div>' +
          '<div class="wf-item-actions">' +
          '<button type="button" class="bigswitch wf-switch" role="switch" aria-checked="' + w.enabled + '" aria-label="' + esc(w.name) + ' on or off" data-toggle' + (draft && !w.enabled ? ' disabled title="Finish it first"' : '') + '><span></span></button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-run>Run now</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-edit>Edit</button>' +
          '<button type="button" class="btn btn-danger btn-sm" data-del>Delete</button>' +
          '</div></article>';
      }).join('');
      view.innerHTML =
        '<section class="panel"><div class="activity-head"><div><h2>Your workflows</h2>' +
        '<p>Your own rules for how Pyp handles things: <b>when</b> something happens in PayPal, <b>check</b> it, then tell Pyp <b>what to do</b>. Pyp still asks before anything goes out, unless you set that action to Auto in Setup.</p></div>' +
        '<div class="activity-actions"><button class="btn" type="button" data-new>+ New workflow</button></div></div>' +
        (data.error ? '<p class="setup-error">' + esc(data.error) + '</p>' : '') +
        (list ? '<div class="wf-list">' + list + '</div>' : '<div class="empty">No workflows yet. Start from a template below, or make your own.</div>') +
        '</section>' +
        '<section class="panel"><h2>Start from a template</h2><div class="wf-templates">' +
        TEMPLATES.map(function (t, i) {
          return '<button type="button" class="wf-template" data-template="' + i + '"><b>' + esc(t.name) + '</b><span>' + esc(t.blurb) + '</span></button>';
        }).join('') + '</div></section>';
    }

    // ---------- the editor ----------
    function open(w) {
      editing = clone(w);
      problems = w.problems || [];
      dirty = false;
      drawEditor();
    }

    function drawEditor() {
      var keepScroll = view.querySelector('.wf-canvas-wrap');
      var scroll = keepScroll ? [keepScroll.scrollLeft, keepScroll.scrollTop] : null;
      view.innerHTML =
        '<div class="wf-bar">' +
        '<button type="button" class="wf-back" data-back>← Workflows</button>' +
        '<label class="wf-name"><span class="sr-label">Workflow name</span><input data-name maxlength="80" value="' + esc(editing.name) + '" placeholder="Name this workflow"></label>' +
        '<div class="inbox-seg" role="group" aria-label="How to edit"><button type="button" data-mode="guided" aria-pressed="' + (mode === 'guided') + '">Guided</button><button type="button" data-mode="canvas" aria-pressed="' + (mode === 'canvas') + '">Canvas</button></div>' +
        '<label class="wf-on"><span>On</span><button type="button" class="bigswitch wf-switch" role="switch" aria-checked="' + !!editing.enabled + '" aria-label="Workflow on" data-on><span></span></button></label>' +
        (editing.id ? '<button type="button" class="btn btn-ghost btn-sm" data-run-open>Run now</button>' : '') +
        '<button type="button" class="btn btn-sm" data-save>Save</button>' +
        '</div>' +
        (problems.length ? '<div class="wf-problems" role="status"><b>To finish this workflow:</b><ul>' + problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></div>' : '') +
        '<div class="wf-stage">' + (mode === 'canvas' ? canvasHTML() : guidedHTML()) + '</div>';
      if (mode === 'canvas') {
        drawEdges();
        var wrap = view.querySelector('.wf-canvas-wrap');
        if (wrap && scroll) { wrap.scrollLeft = scroll[0]; wrap.scrollTop = scroll[1]; }
      }
    }

    // One block's settings: the same in both views.
    function formHTML(n) {
      var g = editing.graph;
      if (n.type === 'when') {
        var t = trig(n.trigger);
        return '<label class="wf-f"><span>When</span><select data-k="trigger">' +
          cat().triggers.map(function (x) { return '<option value="' + x.id + '"' + (x.id === n.trigger ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('') + '</select></label>' +
          (t ? paramsHTML(t.params, n.params || {}) + '<p class="wf-hint">' + esc(t.when) + '</p>' : '');
      }
      var subject = subjectOf(g);
      if (n.type === 'if') {
        var fs = fieldsFor(subject);
        var f = field(subject, n.field) || fs[0];
        if (!f) return '<p class="wf-hint">Pick a When first: there’s nothing to check on a weekly schedule.</p>';
        var ops = cat().ops[f.type];
        return '<div class="wf-row"><label class="wf-f"><span>Check</span><select data-k="field">' +
          fs.map(function (x) { return '<option value="' + x.id + '"' + (x.id === f.id ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('') + '</select></label>' +
          '<label class="wf-f"><span>&nbsp;</span><select data-k="op">' + ops.map(function (o) { return '<option value="' + o.value + '"' + (o.value === n.op ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select></label></div>' +
          valueHTML(f, n.value);
      }
      var w = whenNode(g);
      var choices = w ? actionsFor(w.trigger) : [];
      var a = act(n.action);
      return '<label class="wf-f"><span>Pyp should</span><select data-k="action">' +
        (a && choices.indexOf(a) < 0 ? '<option value="' + esc(a.id) + '" selected>' + esc(a.label) + ' (doesn’t fit this When)</option>' : '') +
        choices.map(function (x) { return '<option value="' + x.id + '"' + (x.id === n.action ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('') + '</select></label>' +
        (a ? paramsHTML(a.params, n.params || {}) : '') +
        (a && a.run ? '<label class="wf-f"><span>Tell Pyp more (optional)</span><textarea data-k="note" maxlength="300" rows="2" placeholder="e.g. Mention the project name">' + esc(n.note || '') + '</textarea></label>' : '');
    }

    function paramsHTML(params, values) {
      return params.map(function (p) {
        var v = values[p.key] != null ? values[p.key] : p.default;
        if (p.type === 'number') {
          return '<label class="wf-f wf-f-inline"><span>' + esc(p.label) + '</span><input type="number" data-param="' + esc(p.key) + '" min="' + p.min + '" max="' + p.max + '" value="' + esc(v) + '">' + (p.unit ? '<em>' + esc(p.unit) + '</em>' : '') + '</label>';
        }
        return '<label class="wf-f wf-f-inline"><span>' + esc(p.label) + '</span><select data-param="' + esc(p.key) + '">' +
          p.options.map(function (o) { return '<option value="' + esc(o.value) + '"' + (o.value === v ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select></label>';
      }).join('');
    }

    function valueHTML(f, v) {
      if (f.type === 'money') return '<label class="wf-f wf-f-inline"><span>Amount</span><em>$</em><input data-k="value" inputmode="decimal" value="' + esc(v) + '" placeholder="500"></label>';
      if (f.type === 'number') return '<label class="wf-f wf-f-inline"><span>Number</span><input type="number" data-k="value" data-num value="' + esc(v) + '"></label>';
      if (f.type === 'text') return '<label class="wf-f"><span>Text</span><input data-k="value" maxlength="120" value="' + esc(v) + '" placeholder="e.g. Acme"></label>';
      var opts = f.type === 'yesno' ? [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] : f.options;
      return '<label class="wf-f"><span>&nbsp;</span><select data-k="value">' + opts.map(function (o) { return '<option value="' + esc(o.value) + '"' + (o.value === v ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select></label>';
    }

    var KIND = { when: 'When', if: 'If', then: 'Then' };

    function blockHead(n) {
      return '<div class="wf-head"><span class="wf-kind wf-kind-' + n.type + '">' + KIND[n.type] + '</span>' +
        (n.type === 'when' ? '' : '<button type="button" class="wf-x" data-remove="' + esc(n.id) + '" aria-label="Remove this block">×</button>') + '</div>';
    }

    // ---------- Guided ----------
    function guidedHTML() {
      var g = editing.graph;
      var w = whenNode(g);
      if (!w) return '<div class="empty">This workflow has no When block. <button type="button" class="btn btn-sm" data-add-when>Add one</button></div>';
      var shown = {};
      function block(n) {
        shown[n.id] = true;
        return '<div class="wf-block wf-' + n.type + '" data-node="' + esc(n.id) + '">' + blockHead(n) + '<div class="wf-body">' + formHTML(n) + '</div></div>';
      }
      function flow(parentId, branch) {
        var children = kids(parentId, branch);
        return '<div class="wf-flow">' + children.map(step).join('') +
          '<div class="wf-add"><button type="button" class="wf-plus" data-add="' + esc(parentId) + '" data-branch="' + (branch || '') + '">+ Add a step</button></div></div>';
      }
      function step(n) {
        if (shown[n.id]) return '';
        if (n.type === 'if') {
          return '<div class="wf-step">' + block(n) +
            '<div class="wf-lanes"><div class="wf-lane"><span class="wf-lane-label yes">Yes</span>' + flow(n.id, 'yes') + '</div>' +
            '<div class="wf-lane"><span class="wf-lane-label no">Otherwise</span>' + flow(n.id, 'no') + '</div></div></div>';
        }
        return '<div class="wf-step">' + block(n) + '</div>';
      }
      var tree = '<div class="wf-guided"><div class="wf-step">' + block(w) + '</div>' + flow(w.id, null) + '</div>';
      var loose = g.nodes.filter(function (n) { return !shown[n.id]; });
      return tree + (loose.length ? '<div class="wf-loose"><h3>Not connected</h3><p>These blocks aren’t part of the flow. Connect them in Canvas, or remove them.</p>' +
        loose.map(function (n) { return '<div class="wf-block wf-' + n.type + '" data-node="' + esc(n.id) + '">' + blockHead(n) + '<div class="wf-body">' + formHTML(n) + '</div></div>'; }).join('') + '</div>' : '');
    }

    // ---------- Canvas ----------
    function layout() {
      // A tidy tree: each step one row down, leaves spread left to right.
      var g = editing.graph;
      var w = whenNode(g);
      var col = 0;
      var placed = {};
      function place(n, depth) {
        if (placed[n.id]) return;
        placed[n.id] = true;
        var children = g.edges.filter(function (e) { return e.from === n.id; }).map(function (e) { return node(e.to); }).filter(Boolean);
        children.forEach(function (c) { place(c, depth + 1); });
        var xs = children.filter(function (c) { return placed[c.id] && c.x != null; }).map(function (c) { return c.x; });
        n.x = xs.length ? (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2 : 30 + (col++) * (NODE_W + 40);
        n.y = 30 + depth * 280;
      }
      if (w) place(w, 0);
      g.nodes.forEach(function (n) { if (!placed[n.id]) { n.x = 30 + (col++) * (NODE_W + 40); n.y = 30 + 3 * 280; } });
    }

    function canvasHTML() {
      var g = editing.graph;
      if (g.nodes.some(function (n) { return n.x == null || n.y == null; })) layout();
      var maxX = Math.max.apply(null, g.nodes.map(function (n) { return n.x; }).concat([0])) + NODE_W + 200;
      var maxY = Math.max.apply(null, g.nodes.map(function (n) { return n.y; }).concat([0])) + 500;
      return '<div class="wf-palette">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-palette="if">+ Check (If)</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-palette="then">+ Action (Then)</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-tidy>Tidy up</button>' +
        '<span class="wf-hint">Drag a block by its top. Drag from a dot to another block to draw an arrow. Click an arrow to remove it.</span></div>' +
        '<div class="wf-canvas-wrap"><div class="wf-canvas" style="width:' + Math.max(1400, maxX) + 'px;height:' + Math.max(900, maxY) + 'px">' +
        '<svg class="wf-edges" width="100%" height="100%"></svg>' +
        g.nodes.map(function (n) {
          var ports = (n.type !== 'when' ? '<span class="wf-port wf-in" data-in="' + esc(n.id) + '"></span>' : '') +
            (n.type === 'when' ? '<span class="wf-port wf-out" data-out="' + esc(n.id) + '" data-branch="" title="Drag to connect"></span>' : '') +
            (n.type === 'if' ? '<span class="wf-port wf-out wf-yes" data-out="' + esc(n.id) + '" data-branch="yes" title="Yes: drag to connect"><i>Yes</i></span>' +
              '<span class="wf-port wf-out wf-no" data-out="' + esc(n.id) + '" data-branch="no" title="Otherwise: drag to connect"><i>Otherwise</i></span>' : '');
          return '<div class="wf-block wf-node wf-' + n.type + '" data-node="' + esc(n.id) + '" style="left:' + n.x + 'px;top:' + n.y + 'px;width:' + NODE_W + 'px">' +
            '<div class="wf-grip" data-grip="' + esc(n.id) + '">' + blockHead(n) + '</div><div class="wf-body">' + formHTML(n) + '</div>' + ports + '</div>';
        }).join('') +
        '</div></div>';
    }

    function portXY(el) {
      var canvas = view.querySelector('.wf-canvas');
      var a = el.getBoundingClientRect();
      var c = canvas.getBoundingClientRect();
      return { x: a.left - c.left + a.width / 2, y: a.top - c.top + a.height / 2 };
    }

    function curve(a, b) {
      var dy = Math.max(40, Math.abs(b.y - a.y) / 2);
      return 'M' + a.x + ',' + a.y + ' C' + a.x + ',' + (a.y + dy) + ' ' + b.x + ',' + (b.y - dy) + ' ' + b.x + ',' + b.y;
    }

    function drawEdges(temp) {
      var svg = view.querySelector('.wf-edges');
      if (!svg) return;
      var html = '<defs><marker id="wf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7E93BC"/></marker></defs>';
      editing.graph.edges.forEach(function (e, i) {
        var from = view.querySelector('[data-out="' + e.from + '"][data-branch="' + (e.branch || '') + '"]');
        var to = view.querySelector('[data-in="' + e.to + '"]');
        if (!from || !to) return;
        var d = curve(portXY(from), portXY(to));
        var cls = e.branch === 'yes' ? 'yes' : e.branch === 'no' ? 'no' : '';
        html += '<path class="wf-edge ' + cls + '" d="' + d + '" marker-end="url(#wf-arrow)"/>' +
          '<path class="wf-edge-hit" d="' + d + '" data-edge="' + i + '"><title>Click to remove this arrow</title></path>';
      });
      if (temp) html += '<path class="wf-edge wf-edge-temp" d="' + curve(temp.a, temp.b) + '"/>';
      svg.innerHTML = html;
    }

    // ---------- changes ----------
    function addNode(type, parentId, branch, at) {
      var g = editing.graph;
      var subject = subjectOf(g);
      var w = whenNode(g);
      var n = { id: newId(), type: type };
      if (type === 'if') {
        var f = fieldsFor(subject)[0];
        if (!f) { toast('A weekly workflow has nothing to check. Add a Then instead.'); return null; }
        n.field = f.id; n.op = cat().ops[f.type][0].value;
        n.value = f.type === 'money' ? '500' : f.type === 'number' ? 1 : f.type === 'yesno' ? 'yes' : f.type === 'choice' ? f.options[0].value : '';
      } else {
        var a = (w ? actionsFor(w.trigger) : [])[0] || cat().actions[0];
        n.action = a.id; n.params = defaults(a.params);
      }
      if (at) { n.x = at.x; n.y = at.y; }
      g.nodes.push(n);
      if (parentId) g.edges.push(branch ? { from: parentId, to: n.id, branch: branch } : { from: parentId, to: n.id });
      dirty = true;
      return n;
    }

    function removeNode(id) {
      var g = editing.graph;
      if (mode === 'guided') {
        // Guided: a block takes the steps below it along.
        var gone = {};
        (function mark(x) { gone[x] = true; g.edges.forEach(function (e) { if (e.from === x && !gone[e.to]) mark(e.to); }); })(id);
        g.nodes = g.nodes.filter(function (n) { return !gone[n.id]; });
        g.edges = g.edges.filter(function (e) { return !gone[e.from] && !gone[e.to]; });
      } else {
        g.nodes = g.nodes.filter(function (n) { return n.id !== id; });
        g.edges = g.edges.filter(function (e) { return e.from !== id && e.to !== id; });
      }
      dirty = true;
    }

    function setField(n, key, el) {
      var v = el.value;
      if (key === 'trigger') {
        var t = trig(v);
        n.trigger = v; n.params = defaults(t.params);
        return true; // checks and actions depend on it: draw again
      }
      if (key === 'field') {
        var f = field(subjectOf(editing.graph), v);
        n.field = v; n.op = cat().ops[f.type][0].value;
        n.value = f.type === 'money' ? '500' : f.type === 'number' ? 1 : f.type === 'yesno' ? 'yes' : f.type === 'choice' ? f.options[0].value : '';
        return true;
      }
      if (key === 'action') { n.action = v; n.params = defaults(act(v).params); return true; }
      if (key === 'value') { n.value = el.hasAttribute('data-num') ? Number(v) : v; return false; }
      n[key] = v;
      return false;
    }

    function save(silent) {
      var body = { name: editing.name.trim() || 'Untitled workflow', enabled: !!editing.enabled, graph: editing.graph };
      return transport.saveWorkflow(body, editing.id).then(function (r) {
        var wantedOn = editing.enabled;
        editing = clone(r.workflow);
        problems = r.problems || [];
        dirty = false;
        if (!silent) toast(problems.length ? (wantedOn ? 'Saved as a draft: ' + problems.length + ' thing' + (problems.length > 1 ? 's' : '') + ' to finish before it can be on.' : 'Saved as a draft.') : 'Saved.' + (r.workflow.enabled ? ' It’s on.' : ''));
        return transport.workflows().then(function (d) { data = d; drawEditor(); });
      });
    }

    function runNow(id, label) {
      return transport.runWorkflow(id).then(function (o) {
        if (o.status === 'waiting') return toast(o.message || 'Nothing to run right now.');
        var made = (o.cardIds || []).length;
        toast(label + ': looked at ' + o.found + ', ' + o.matched + ' matched, ' + made + ' new card' + (made === 1 ? '' : 's') + ' in your Inbox' + (o.skipped ? ' (' + o.skipped + ' already in hand)' : '') + '.' +
          (!made && o.notes && o.notes.length ? ' Pyp: “' + o.notes[0] + '”' : ''));
      }, function (err) { toast(err.message); });
    }

    // ---------- events ----------
    function onClick(e) {
      if (!data) return;
      var b = e.target.closest('button, .wf-edge-hit');
      if (!b) return;
      if (!editing) {
        var item = b.closest('[data-wf]');
        var w = item && data.workflows.filter(function (x) { return x.id === item.getAttribute('data-wf'); })[0];
        if (b.hasAttribute('data-new')) open({ name: '', enabled: false, graph: { nodes: [{ id: 'w', type: 'when', trigger: 'invoice_overdue', params: {} }], edges: [] } });
        else if (b.hasAttribute('data-template')) { var t = TEMPLATES[Number(b.getAttribute('data-template'))]; open({ name: t.name, enabled: true, graph: clone(t.graph) }); dirty = true; }
        else if (w && b.hasAttribute('data-edit')) open(w);
        else if (w && b.hasAttribute('data-run')) { b.disabled = true; runNow(w.id, w.name).then(function () { b.disabled = false; }); }
        else if (w && b.hasAttribute('data-toggle')) {
          b.disabled = true;
          transport.saveWorkflow({ name: w.name, enabled: !w.enabled, graph: w.graph }, w.id).then(function (r) {
            toast(r.workflow.enabled ? w.name + ' is on.' : w.name + ' is off.');
            return load();
          }, function (err) { b.disabled = false; toast(err.message); });
        } else if (w && b.hasAttribute('data-del')) {
          b.disabled = true;
          transport.deleteWorkflow(w.id).then(function () { toast('Deleted ' + w.name + '. Cards it made stay in your Inbox.'); return load(); }, function (err) { b.disabled = false; toast(err.message); });
        }
        return;
      }
      if (b.hasAttribute('data-back')) {
        if (dirty && !b.hasAttribute('data-sure')) { b.setAttribute('data-sure', ''); b.textContent = 'Leave without saving?'; return; }
        editing = null; drawList(); return;
      }
      if (b.hasAttribute('data-mode')) { mode = b.getAttribute('data-mode'); saveView(mode); drawEditor(); return; }
      if (b.hasAttribute('data-on')) { editing.enabled = !editing.enabled; dirty = true; b.setAttribute('aria-checked', String(editing.enabled)); return; }
      if (b.hasAttribute('data-save')) { b.disabled = true; save().catch(function (err) { b.disabled = false; toast(err.message); }); return; }
      if (b.hasAttribute('data-run-open')) {
        b.disabled = true;
        (dirty ? save(true) : Promise.resolve()).then(function () { return runNow(editing.id, editing.name); }).catch(function (err) { toast(err.message); }).then(function () { var x = view.querySelector('[data-run-open]'); if (x) x.disabled = false; });
        return;
      }
      if (b.hasAttribute('data-add-when')) { editing.graph.nodes.push({ id: newId(), type: 'when', trigger: 'invoice_overdue', params: {} }); dirty = true; drawEditor(); return; }
      if (b.hasAttribute('data-remove')) { removeNode(b.getAttribute('data-remove')); drawEditor(); return; }
      if (b.hasAttribute('data-add')) { showAddMenu(b); return; }
      if (b.hasAttribute('data-add-type')) {
        var menu = b.closest('.wf-add');
        var parent = menu.querySelector('[data-add]');
        if (addNode(b.getAttribute('data-add-type'), parent.getAttribute('data-add'), parent.getAttribute('data-branch') || null)) drawEditor();
        return;
      }
      if (b.hasAttribute('data-palette')) {
        var wrap = view.querySelector('.wf-canvas-wrap');
        var right = Math.max.apply(null, editing.graph.nodes.map(function (n) { return (n.x || 0) + NODE_W; }).concat([0]));
        if (addNode(b.getAttribute('data-palette'), null, null, { x: right + 60, y: wrap.scrollTop + 30 })) {
          drawEditor();
          var w2 = view.querySelector('.wf-canvas-wrap');
          if (w2) w2.scrollLeft = Math.max(0, right + 60 - w2.clientWidth / 2);
        }
        return;
      }
      if (b.hasAttribute('data-tidy')) { layout(); drawEditor(); return; }
      if (b.hasAttribute('data-edge')) {
        editing.graph.edges.splice(Number(b.getAttribute('data-edge')), 1);
        dirty = true; drawEditor(); toast('Arrow removed.');
      }
    }

    function showAddMenu(b) {
      var box = b.closest('.wf-add');
      if (box.querySelector('.wf-addmenu')) { box.querySelector('.wf-addmenu').remove(); return; }
      var weekly = subjectOf(editing.graph) === 'week';
      var m = document.createElement('div');
      m.className = 'wf-addmenu';
      m.innerHTML = (weekly ? '' : '<button type="button" data-add-type="if"><b>Check something</b><span>If… then split into Yes and Otherwise</span></button>') +
        '<button type="button" data-add-type="then"><b>Do something</b><span>Tell Pyp what to do</span></button>';
      box.appendChild(m);
    }

    function onChange(e) {
      if (!editing) return;
      var el = e.target;
      if (el.matches('[data-name]')) { editing.name = el.value; dirty = true; return; }
      var host = el.closest('[data-node]');
      if (!host) return;
      var n = node(host.getAttribute('data-node'));
      if (!n) return;
      dirty = true;
      if (el.hasAttribute('data-param')) {
        n.params = n.params || {};
        n.params[el.getAttribute('data-param')] = el.type === 'number' ? Number(el.value) : el.value;
        return;
      }
      var key = el.getAttribute('data-k');
      if (key && setField(n, key, el) && e.type === 'change') drawEditor();
    }

    // Canvas: move blocks and draw arrows with the pointer.
    function onDown(e) {
      if (!editing || mode !== 'canvas') return;
      var out = e.target.closest('[data-out]');
      var grip = e.target.closest('[data-grip]');
      if (out) {
        e.preventDefault();
        drag = { kind: 'link', from: out.getAttribute('data-out'), branch: out.getAttribute('data-branch') || null, a: portXY(out) };
      } else if (grip && !e.target.closest('button')) {
        var n = node(grip.getAttribute('data-grip'));
        drag = { kind: 'move', n: n, el: grip.closest('.wf-node'), sx: e.clientX, sy: e.clientY, x: n.x, y: n.y };
      }
    }
    function onMove(e) {
      if (!drag) return;
      if (drag.kind === 'move') {
        drag.n.x = Math.max(0, Math.round(drag.x + e.clientX - drag.sx));
        drag.n.y = Math.max(0, Math.round(drag.y + e.clientY - drag.sy));
        drag.el.style.left = drag.n.x + 'px';
        drag.el.style.top = drag.n.y + 'px';
        dirty = true;
        drawEdges();
      } else {
        var c = view.querySelector('.wf-canvas').getBoundingClientRect();
        drawEdges({ a: drag.a, b: { x: e.clientX - c.left, y: e.clientY - c.top } });
      }
    }
    function onUp(e) {
      if (!drag) return;
      var d = drag;
      drag = null;
      if (d.kind !== 'link') return;
      var target = document.elementFromPoint(e.clientX, e.clientY);
      var host = target && target.closest('.wf-node');
      var to = host && node(host.getAttribute('data-node'));
      if (!to || to.id === d.from || to.type === 'when') { drawEdges(); return; }
      var g = editing.graph;
      // One arrow into a block, and one per Yes / Otherwise dot.
      g.edges = g.edges.filter(function (x) { return x.to !== to.id; });
      g.edges.push(d.branch ? { from: d.from, to: to.id, branch: d.branch } : { from: d.from, to: to.id });
      dirty = true;
      drawEdges();
    }

    view.addEventListener('click', onClick);
    view.addEventListener('change', onChange);
    view.addEventListener('input', onChange);
    view.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    var onResize = function () { if (editing && mode === 'canvas') drawEdges(); };
    window.addEventListener('resize', onResize);
    cleanup.push(function () {
      view.removeEventListener('click', onClick);
      view.removeEventListener('change', onChange);
      view.removeEventListener('input', onChange);
      view.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('resize', onResize);
    });

    view.innerHTML = '<section class="panel"><h2>Your workflows</h2><div class="loading">Loading workflows…</div></section>';
    load();
  }

  root.PypWorkflows = { render: render, TEMPLATES: TEMPLATES };
})(typeof window !== 'undefined' ? window : globalThis);
