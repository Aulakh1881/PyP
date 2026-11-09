/* Pyp dashboard: My skills.
 *
 * Custom skills are specialists the merchant makes. Workflows are the merchant's
 * rules (a flowchart: they decide, Pyp follows). A skill is Pyp's judgment, their
 * way: it watches a list on its own schedule, keeps what passes their checks, and
 * Pyp decides each one with their playbook, tone and allowed actions.
 *
 *   Describe it   one sentence → Pyp drafts the form (POST /api/skills/draft)
 *   Try it        what Pyp would do for up to 3 of them; nothing saved or sent
 *   Run now       cards in the Inbox, like any run
 *
 * The server checks every skill (engine/custom-skills.ts) and runs it through the
 * same checks, dials, undo window and kill switch. Nothing here writes to PayPal.
 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  // Shown in the business's time zone, the same one the schedule uses ("Every Friday at 09:00").
  var zone = '';
  function when(iso) {
    var d = new Date(iso || '');
    if (!isFinite(d.getTime())) return '';
    var o = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    try { if (zone) return d.toLocaleString(undefined, Object.assign({ timeZone: zone }, o)); } catch (e) { /* unknown zone: the browser's */ }
    return d.toLocaleString(undefined, o);
  }

  var EMPTY = { watch: 'invoice_overdue', filters: [], schedule: { kind: 'weekly', weekday: 'Mon', time: '09:00' }, actions: [], playbook: '', tone: 'neutral' };

  // Ready-made skills to start from.
  var TEMPLATES = [
    {
      name: 'Friday cleanup',
      blurb: 'Every Friday: one last firm reminder on invoices 30+ days late; suggests cancelling the very old ones.',
      spec: {
        watch: 'invoice_overdue',
        filters: [{ field: 'days_overdue', op: 'gte', value: 30 }],
        schedule: { kind: 'weekly', weekday: 'Fri', time: '09:00' },
        actions: [{ action: 'remind', askFirst: false }, { action: 'cancel', askFirst: true }],
        playbook: 'Send one last firm reminder. If it is over 90 days late or they have ignored 3 reminders, suggest cancelling instead.',
        tone: 'firm'
      }
    },
    {
      name: 'Gentle collector',
      blurb: 'Every morning: soft check-ins on small overdue invoices. After two reminders, it asks you.',
      spec: {
        watch: 'invoice_overdue',
        filters: [{ field: 'amount', op: 'lt', value: '500' }],
        schedule: { kind: 'daily', time: '09:00' },
        actions: [{ action: 'remind', askFirst: false }, { action: 'follow_up', askFirst: false }],
        playbook: 'My clients are small studios and friends. Keep it light, never mention fees. After 2 reminders, ask me before anything else.',
        tone: 'warm'
      }
    },
    {
      name: 'Fast refunder',
      blurb: 'Small not-received disputes: offer a refund early, after asking you. Keeping the customer beats winning.',
      spec: {
        watch: 'dispute_opened',
        filters: [{ field: 'reason', op: 'is', value: 'not_received' }, { field: 'amount', op: 'lt', value: '100' }],
        schedule: { kind: 'daily', time: '10:00' },
        actions: [{ action: 'offer', askFirst: true }, { action: 'message', askFirst: false }],
        playbook: 'For small orders that did not arrive, I would rather refund than fight. Apologise, offer the refund, and keep it short.',
        tone: 'warm'
      }
    }
  ];

  function render(view, transport, helpers) {
    var toast = helpers.toast;
    var cleanup = helpers.cleanup;
    if (!transport.skills) {
      view.innerHTML = '<section class="panel"><h2>My skills</h2><p>Custom skills are saved on the Pyp server. Sign in to the live dashboard to make them.</p></section>';
      return;
    }

    var data = null;      // { skills, catalog, error }
    var editing = null;   // { id, name, enabled, spec, notes } while the editor is open
    var problems = [];
    var tried = null;     // the last Try it result for the open skill
    var busy = false;
    var alive = true;
    cleanup.push(function () { alive = false; });

    function load() {
      return transport.skills().then(function (d) { if (!alive) return; data = d; zone = d.timeZone || ''; if (!editing) drawList(); }, function (e) {
        if (alive) view.innerHTML = '<section class="panel"><h2>My skills</h2><p class="setup-error">' + esc(e.message) + '</p></section>';
      });
    }

    // ---------- catalog helpers ----------
    function cat() { return data.catalog; }
    function watch(id) { return cat().watches.filter(function (w) { return w.id === id; })[0]; }
    function fieldsFor(subject) { return cat().fields.filter(function (f) { return f.subject === subject; }); }
    function field(subject, id) { return fieldsFor(subject).filter(function (f) { return f.id === id; })[0]; }
    function actionsFor(subject) { return cat().actions.filter(function (a) { return a.subject === subject; }); }
    function opt(value, label, selected) { return '<option value="' + esc(value) + '"' + (selected ? ' selected' : '') + '>' + esc(label) + '</option>'; }

    // ---------- the list ----------
    function lastRunLine(s) {
      var o = s.lastOutcome;
      if (!o || !s.lastRunAt) return 'Hasn’t run yet';
      if (o.status === 'paused') return 'Last run ' + when(s.lastRunAt) + ': Pyp was paused';
      return 'Last run ' + when(s.lastRunAt) + ': ' + o.matched + ' of ' + o.found + ' matched, ' + (o.cardIds ? o.cardIds.length : 0) + ' card' + ((o.cardIds && o.cardIds.length === 1) ? '' : 's') + (o.failed && o.failed.length ? ', ' + o.failed.length + ' failed' : '');
    }

    function drawList() {
      editing = null;
      tried = null;
      var list = data.skills.map(function (s) {
        var draft = s.problems && s.problems.length;
        var status = s.enabled ? '<span class="chip chip-good">On</span>' : draft ? '<span class="chip chip-warn">Draft: ' + s.problems.length + ' to fix</span>' : '<span class="chip chip-muted">Off</span>';
        var next = s.enabled && s.nextRunAt ? ' · next ' + when(s.nextRunAt) : '';
        return '<article class="wf-item" data-skill="' + esc(s.id) + '">' +
          '<div class="wf-item-main"><h3>' + esc(s.name) + ' ' + status + '</h3><p>' + esc(s.summary) + '</p>' +
          '<p class="sk-when">' + esc(s.when + next) + '</p><p class="sk-last">' + esc(lastRunLine(s)) + '</p></div>' +
          '<div class="wf-item-actions">' +
          '<button type="button" class="bigswitch wf-switch" role="switch" aria-checked="' + s.enabled + '" aria-label="' + esc(s.name) + ' on or off" data-toggle' + (draft && !s.enabled ? ' disabled title="Finish it first"' : '') + '><span></span></button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-try' + (draft ? ' disabled' : '') + '>Try it</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-run' + (draft ? ' disabled' : '') + '>Run now</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-edit>Edit</button>' +
          '<button type="button" class="btn btn-danger btn-sm" data-del>Delete</button>' +
          '</div></article>';
      }).join('');
      view.innerHTML =
        '<section class="panel"><div class="activity-head"><div><h2>My skills</h2>' +
        '<p>Specialists you make. A skill watches what you pick, on your schedule, and <b>Pyp decides</b> each one your way: your playbook, your tone, only the actions you allow. Pyp still asks before anything goes out unless you set that action to Auto in Setup.</p>' +
        '<p class="note">Skills are Pyp’s judgment, your way. <a href="#/workflows">Workflows</a> are your rules: you decide, Pyp follows.</p></div>' +
        '<div class="activity-actions"><button class="btn" type="button" data-new>+ New skill</button></div></div>' +
        '<form class="sk-describe" data-describe><label class="wf-f"><span>Describe a skill in your own words, and Pyp drafts it</span>' +
        '<textarea data-description rows="2" maxlength="600" placeholder="Every Friday, chase anything 30+ days late with a firm reminder, and ask me before cancelling anything."></textarea></label>' +
        '<button class="btn" type="submit" data-draft>Draft it with Pyp</button></form>' +
        (data.error ? '<p class="setup-error">' + esc(data.error) + '</p>' : '') +
        (list ? '<div class="wf-list">' + list + '</div>' : '<div class="empty">No skills yet. Describe one above, or start from a template below.</div>') +
        '<div data-list-result></div>' +
        '</section>' +
        '<section class="panel"><h2>Start from a template</h2><div class="wf-templates">' +
        TEMPLATES.map(function (t, i) {
          return '<button type="button" class="wf-template" data-template="' + i + '"><b>' + esc(t.name) + '</b><span>' + esc(t.blurb) + '</span></button>';
        }).join('') + '</div></section>';
    }

    // ---------- the editor ----------
    function open(s) {
      editing = clone(s);
      editing.notes = s.notes || [];
      problems = s.problems || [];
      tried = null;
      drawEditor();
    }

    function filterRow(f, i, subject) {
      var fd = field(subject, f.field) || fieldsFor(subject)[0];
      var ops = (cat().ops[fd.type] || []);
      var valueHTML;
      if (fd.type === 'choice') valueHTML = '<select data-f="value" data-i="' + i + '">' + fd.options.map(function (o) { return opt(o.value, o.label, o.value === f.value); }).join('') + '</select>';
      else if (fd.type === 'yesno') valueHTML = '<select data-f="value" data-i="' + i + '">' + opt('yes', 'Yes', f.value === 'yes') + opt('no', 'No', f.value === 'no') + '</select>';
      else valueHTML = '<input data-f="value" data-i="' + i + '" ' + (fd.type === 'number' ? 'type="number" step="1"' : fd.type === 'money' ? 'inputmode="decimal" placeholder="500"' : '') + ' value="' + esc(f.value) + '">';
      return '<div class="sk-filter">' +
        '<select data-f="field" data-i="' + i + '" aria-label="Check">' + fieldsFor(subject).map(function (x) { return opt(x.id, x.label, x.id === fd.id); }).join('') + '</select>' +
        '<select data-f="op" data-i="' + i + '" aria-label="How to compare">' + ops.map(function (o) { return opt(o.value, o.label, o.value === f.op); }).join('') + '</select>' +
        valueHTML +
        (fd.type === 'money' ? '<em>dollars</em>' : fd.id.indexOf('days') >= 0 ? '<em>days</em>' : '') +
        '<button type="button" class="btn btn-ghost btn-sm" data-remove-filter="' + i + '" aria-label="Remove this check">✕</button></div>';
    }

    function scheduleHTML(s) {
      var k = s.kind;
      var parts = '<label class="wf-f"><span>Runs</span><select data-s="kind">' + cat().scheduleKinds.map(function (x) { return opt(x.value, x.label, x.value === k); }).join('') + '</select></label>';
      if (k === 'weekly') parts += '<label class="wf-f"><span>On</span><select data-s="weekday">' + cat().weekdays.map(function (d) { return opt(d, d, d === s.weekday); }).join('') + '</select></label>';
      if (k === 'monthly') parts += '<label class="wf-f"><span>Day of the month</span><input data-s="day" type="number" min="1" max="28" value="' + esc(s.day) + '"></label>';
      if (k === 'every') parts += '<label class="wf-f"><span>Every</span><input data-s="days" type="number" min="2" max="30" value="' + esc(s.days) + '"><em>days</em></label>';
      if (k !== 'manual') parts += '<label class="wf-f"><span>At</span><input data-s="time" type="time" value="' + esc(s.time) + '"></label>';
      return '<div class="sk-row">' + parts + '</div><p class="wf-hint">In your business’s time zone' + (data.timeZone ? ' (' + esc(data.timeZone) + ')' : '') + '. Run now and Try it work any time.</p>';
    }

    function drawEditor() {
      var sp = editing.spec;
      var w = watch(sp.watch) || cat().watches[0];
      var acts = actionsFor(w.subject);
      view.innerHTML =
        '<div class="wf-bar">' +
        '<button type="button" class="wf-back" data-back>← My skills</button>' +
        '<label class="wf-name"><span class="sr-label">Skill name</span><input data-name maxlength="60" value="' + esc(editing.name) + '" placeholder="Name this skill"></label>' +
        '<label class="wf-on"><span>On</span><button type="button" class="bigswitch wf-switch" role="switch" aria-checked="' + !!editing.enabled + '" aria-label="Skill on" data-on><span></span></button></label>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-try-open>Try it</button>' +
        '<button type="button" class="btn btn-sm" data-save>Save</button>' +
        '</div>' +
        (editing.notes && editing.notes.length ? '<div class="sk-notes" role="status"><b>From Pyp’s draft:</b><ul>' + editing.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></div>' : '') +
        (problems.length ? '<div class="wf-problems" role="status"><b>To finish this skill:</b><ul>' + problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></div>' : '') +
        '<div class="sk-grid">' +
        '<section class="panel sk-sec"><h3>1. What it watches</h3><div class="sk-row"><label class="wf-f"><span>Watch</span><select data-k="watch">' +
        cat().watches.map(function (x) { return opt(x.id, x.label, x.id === sp.watch); }).join('') + '</select></label>' +
        (sp.watch === 'invoice_due_soon' ? '<label class="wf-f"><span>Due within</span><input data-k="dueWithinDays" type="number" min="1" max="30" value="' + esc(sp.dueWithinDays || 3) + '"><em>days</em></label>' : '') +
        '</div><h4>Only when <span class="wf-hint">(optional; code checks these, not Pyp)</span></h4>' +
        (sp.filters.length ? sp.filters.map(function (f, i) { return filterRow(f, i, w.subject); }).join('') : '<p class="wf-hint">No checks: Pyp looks at every one.</p>') +
        (sp.filters.length < 5 ? '<button type="button" class="btn btn-ghost btn-sm" data-add-filter>+ Add a check</button>' : '') +
        '</section>' +
        '<section class="panel sk-sec"><h3>2. When it runs</h3>' + scheduleHTML(sp.schedule) + '</section>' +
        '<section class="panel sk-sec"><h3>3. What it may do</h3><p class="wf-hint">Pyp can always ask you instead. Nothing else is on its menu.</p><div class="sk-acts">' +
        acts.map(function (a) {
          var chosen = sp.actions.filter(function (x) { return x.action === a.id; })[0];
          return '<div class="sk-act"><label><input type="checkbox" data-act="' + a.id + '"' + (chosen ? ' checked' : '') + '> ' + esc(a.label) + '</label>' +
            (a.alwaysAsks ? '<span class="chip chip-info">Always asks you</span>' :
              '<label class="sk-ask"><input type="checkbox" data-ask="' + a.id + '"' + (chosen && chosen.askFirst ? ' checked' : '') + (chosen ? '' : ' disabled') + '> Ask me first</label>') +
            '</div>';
        }).join('') + '</div></section>' +
        '<section class="panel sk-sec"><h3>4. How Pyp should think</h3>' +
        '<label class="wf-f"><span>Your playbook, in your words</span><textarea data-k="playbook" rows="4" maxlength="600" placeholder="My clients are small studios. Be warm, never mention fees. After 2 reminders, ask me.">' + esc(sp.playbook) + '</textarea></label>' +
        '<div class="sk-row"><label class="wf-f"><span>Tone</span><select data-k="tone">' + cat().tones.map(function (t) { return opt(t.value, t.label, t.value === sp.tone); }).join('') + '</select></label></div>' +
        '<p class="wf-hint">Pyp’s own rules still win: it uses only facts from PayPal, never does sums on money, and every action goes through the checks.</p></section>' +
        '</div>' +
        '<div data-try-result>' + (tried ? triedHTML(tried) : '') + '</div>';
    }

    function triedHTML(r) {
      if (r.status === 'paused') return '<section class="panel"><p class="setup-error">' + esc(r.message || 'Pyp is paused (kill switch on).') + '</p></section>';
      if (r.status === 'waiting') return '<section class="panel"><p class="setup-error">' + esc(r.message) + '</p></section>';
      var head = '<p><b>Pyp looked at ' + r.found + ' and ' + r.matched + ' passed your checks.</b> ' + (r.skipped ? r.skipped + ' already had a card waiting. ' : '') + 'Nothing was saved or sent.</p>';
      var items = (r.previews || []).map(function (p) {
        return '<article class="sk-preview"><div class="sk-preview-head"><span class="chip chip-muted">' + esc(p.subject.kind + ' ' + p.subject.id) + '</span><b>' + esc(p.title || 'No decision') + '</b></div>' +
          (p.summary ? '<p>' + esc(p.summary) + '</p>' : '') +
          (p.failure ? '<p class="setup-error">' + esc(p.failure) + '</p>' : '') +
          (p.actions.length ? '<ul>' + p.actions.map(function (a) {
            var cls = a.outcome === 'would ask you' ? 'chip-info' : a.outcome.indexOf('Auto') >= 0 ? 'chip-good' : 'chip-warn';
            return '<li><span class="chip ' + cls + '">' + esc(a.outcome) + '</span> ' + esc(a.label) + (a.reason ? ' <span class="wf-hint">' + esc(a.reason) + '</span>' : '') + '</li>';
          }).join('') + '</ul>' : '<p class="wf-hint">Pyp chose to do nothing for this one.</p>') +
          '</article>';
      }).join('');
      return '<section class="panel"><h2>Try it: what Pyp would do</h2>' + head + (items || '<div class="empty">Nothing to do right now.</div>') +
        (r.failed && r.failed.length ? '<p class="setup-error">' + esc(r.failed.join(' · ')) + '</p>' : '') + '</section>';
    }

    // ---------- actions ----------
    function body() { return { name: (editing.name || '').trim() || 'My skill', enabled: !!editing.enabled, spec: editing.spec }; }

    function save() {
      return transport.saveSkill(body(), editing.id).then(function (r) {
        editing.id = r.skill.id;
        editing.enabled = r.skill.enabled;
        problems = r.problems || [];
        return r;
      });
    }

    function withBusy(btn, label, fn) {
      if (busy) return;
      busy = true;
      var old = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = label; }
      return Promise.resolve().then(fn).catch(function (e) { toast(e.message); }).then(function () {
        busy = false;
        if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = old; }
      });
    }

    function tryIt(id, slot) {
      return transport.trySkill(id).then(function (r) {
        if (!alive) return;
        tried = r;
        if (slot && slot.isConnected) { slot.innerHTML = triedHTML(r); slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
      });
    }

    function onClick(e) {
      var t = e.target.closest('button, a');
      if (!t || !data) return;
      var item = t.closest('[data-skill]');
      var s = item && data.skills.filter(function (x) { return x.id === item.getAttribute('data-skill'); })[0];

      if (t.hasAttribute('data-new')) return open({ id: null, name: '', enabled: false, spec: clone(EMPTY) });
      if (t.hasAttribute('data-template')) {
        var tpl = TEMPLATES[Number(t.getAttribute('data-template'))];
        return open({ id: null, name: tpl.name, enabled: false, spec: clone(tpl.spec) });
      }
      if (s && t.hasAttribute('data-edit')) return open(s);
      if (s && t.hasAttribute('data-del')) {
        return withBusy(t, 'Deleting…', function () {
          return transport.deleteSkill(s.id).then(function () { toast('Skill deleted'); return load(); });
        });
      }
      if (s && t.hasAttribute('data-toggle')) {
        return withBusy(null, '', function () {
          return transport.saveSkill({ name: s.name, enabled: !s.enabled, spec: s.spec }, s.id).then(function (r) {
            toast(r.skill.enabled ? s.name + ' is on · ' + (r.skill.nextRunAt ? 'next run ' + when(r.skill.nextRunAt) : 'runs when you run it') : s.name + ' is off');
            return load();
          });
        });
      }
      if (s && t.hasAttribute('data-run')) {
        return withBusy(t, 'Running…', function () {
          return transport.runSkill(s.id).then(function (r) {
            toast(r.cardIds.length ? r.cardIds.length + ' card' + (r.cardIds.length === 1 ? '' : 's') + ' in your Inbox' : r.matched ? 'Pyp looked at ' + r.matched + ' and had nothing to propose' : 'Nothing matched this skill right now');
            return load();
          });
        });
      }
      if (s && t.hasAttribute('data-try')) {
        var slot = view.querySelector('[data-list-result]');
        slot.innerHTML = '<div class="loading">Pyp is trying “' + esc(s.name) + '”… nothing will be saved or sent.</div>';
        return withBusy(t, 'Trying…', function () { return tryIt(s.id, slot); });
      }

      if (!editing) return;
      if (t.hasAttribute('data-back')) { load(); return drawList(); }
      if (t.hasAttribute('data-on')) { editing.enabled = !editing.enabled; t.setAttribute('aria-checked', String(editing.enabled)); return; }
      if (t.hasAttribute('data-add-filter')) {
        var subject = watch(editing.spec.watch).subject;
        var first = fieldsFor(subject)[0];
        editing.spec.filters.push({ field: first.id, op: cat().ops[first.type][0].value, value: '' });
        return drawEditor();
      }
      if (t.hasAttribute('data-remove-filter')) { editing.spec.filters.splice(Number(t.getAttribute('data-remove-filter')), 1); return drawEditor(); }
      if (t.hasAttribute('data-save')) {
        return withBusy(t, 'Saving…', function () {
          return save().then(function (r) {
            toast(r.problems.length ? 'Saved as a draft: ' + r.problems.length + ' thing' + (r.problems.length === 1 ? '' : 's') + ' to fix' : r.skill.enabled ? 'Saved · ' + (r.skill.nextRunAt ? 'next run ' + when(r.skill.nextRunAt) : 'runs when you run it') : 'Saved (off)');
            editing.notes = [];
            drawEditor();
          });
        });
      }
      if (t.hasAttribute('data-try-open')) {
        return withBusy(t, 'Trying…', function () {
          // Try it runs the saved skill, so save the form first.
          return save().then(function (r) {
            editing.notes = [];
            if (r.problems.length) { drawEditor(); throw new Error('Finish the skill first: ' + r.problems[0]); }
            var slot = view.querySelector('[data-try-result]');
            slot.innerHTML = '<section class="panel"><div class="loading">Pyp is trying it… nothing will be saved or sent.</div></section>';
            return tryIt(editing.id, slot);
          });
        });
      }
    }

    function onSubmit(e) {
      if (!e.target.matches('[data-describe]')) return;
      e.preventDefault();
      var text = (view.querySelector('[data-description]').value || '').trim();
      if (!text) return toast('Describe what the skill should do first');
      withBusy(view.querySelector('[data-draft]'), 'Pyp is drafting…', function () {
        return transport.draftSkill(text).then(function (d) {
          if (!alive) return;
          open({ id: null, name: d.name, enabled: false, spec: d.spec, problems: d.problems, notes: d.notes });
          toast('Pyp drafted it. Check it over, then Save.');
        });
      });
    }

    function onChange(e) {
      if (!editing) return;
      var el = e.target;
      // Checkboxes and menus fire both input and change; handle them once.
      if (e.type === 'input' && (el.type === 'checkbox' || el.tagName === 'SELECT')) return;
      var sp = editing.spec;
      if (el.hasAttribute('data-name')) { editing.name = el.value; return; }
      var k = el.getAttribute('data-k');
      if (k === 'watch') {
        var before = watch(sp.watch).subject;
        sp.watch = el.value;
        var after = watch(sp.watch).subject;
        if (before !== after) { sp.filters = []; sp.actions = []; }
        if (sp.watch === 'invoice_due_soon' && !sp.dueWithinDays) sp.dueWithinDays = 3;
        if (sp.watch !== 'invoice_due_soon') delete sp.dueWithinDays;
        return drawEditor();
      }
      if (k === 'dueWithinDays') { sp.dueWithinDays = Number(el.value) || 3; return; }
      if (k === 'playbook' || k === 'tone') { sp[k] = el.value; return; }

      var s = el.getAttribute('data-s');
      if (s) {
        if (s === 'kind') {
          var time = sp.schedule.time || '09:00';
          sp.schedule = el.value === 'manual' ? { kind: 'manual' } : el.value === 'weekly' ? { kind: 'weekly', weekday: 'Mon', time: time } : el.value === 'monthly' ? { kind: 'monthly', day: 1, time: time } : el.value === 'every' ? { kind: 'every', days: 3, time: time } : { kind: 'daily', time: time };
          return drawEditor();
        }
        sp.schedule[s] = s === 'day' || s === 'days' ? Number(el.value) : el.value;
        return;
      }

      var f = el.getAttribute('data-f');
      if (f) {
        var i = Number(el.getAttribute('data-i'));
        var row = sp.filters[i];
        var subject = watch(sp.watch).subject;
        if (f === 'field') {
          var fd = field(subject, el.value);
          sp.filters[i] = { field: fd.id, op: cat().ops[fd.type][0].value, value: fd.type === 'choice' ? fd.options[0].value : fd.type === 'yesno' ? 'yes' : '' };
          return drawEditor();
        }
        if (f === 'op') row.op = el.value;
        if (f === 'value') row.value = field(subject, row.field).type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
        return;
      }

      var act = el.getAttribute('data-act');
      if (act) {
        if (el.checked) sp.actions.push({ action: act, askFirst: false });
        else sp.actions = sp.actions.filter(function (x) { return x.action !== act; });
        return drawEditor();
      }
      var ask = el.getAttribute('data-ask');
      if (ask) {
        sp.actions.forEach(function (x) { if (x.action === ask) x.askFirst = el.checked; });
      }
    }

    view.addEventListener('click', onClick);
    view.addEventListener('submit', onSubmit);
    view.addEventListener('change', onChange);
    view.addEventListener('input', onChange);
    cleanup.push(function () {
      view.removeEventListener('click', onClick);
      view.removeEventListener('submit', onSubmit);
      view.removeEventListener('change', onChange);
      view.removeEventListener('input', onChange);
    });

    view.innerHTML = '<section class="panel"><h2>My skills</h2><div class="loading">Loading your skills…</div></section>';
    load();
  }

  root.PypSkills = { render: render, TEMPLATES: TEMPLATES };
})(typeof window !== 'undefined' ? window : globalThis);
