/* Pyp dashboard: Setup → Connections.
 *
 * Pyp in the apps the merchant already uses. When a card needs them, Pyp posts it
 * to Slack or Discord, or sends signed JSON to any app (n8n, Zapier, Make). In
 * Slack, /pyp talks to Pyp like the chat does. Messages link back to Pyp:
 * approving always happens in Pyp. The server keeps the URLs and secrets
 * (jobs/connections.ts); this page only ever sees them masked.
 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ago(iso) {
    var t = new Date(iso || '').getTime();
    if (!isFinite(t)) return '';
    var m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : new Date(t).toLocaleDateString();
  }

  var KINDS = [
    { id: 'slack', name: 'Slack', blurb: 'Optional: also post cards that need you to a team channel (an incoming webhook).', placeholder: 'https://hooks.slack.com/services/…',
      how: 'In Pyp’s Slack app: Incoming Webhooks → On → Add New Webhook to Workspace → pick a channel → copy the URL.' },
    { id: 'discord', name: 'Discord', blurb: 'Cards that need you, posted to a Discord channel.', placeholder: 'https://discord.com/api/webhooks/…',
      how: 'In Discord: Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.' },
    { id: 'webhook', name: 'Any app (n8n, Zapier, Make)', blurb: 'Every new card as signed JSON, so your own automations can do anything with it.', placeholder: 'https://your-n8n.example.com/webhook/…',
      how: 'In n8n add a Webhook node (POST), in Zapier “Webhooks by Zapier → Catch Hook”, in Make a “Custom webhook”, and paste its URL here.' }
  ];

  // Kept outside mount: Setup redraws (a dial, the kill switch) mount this panel again,
  // and a secret shown once or a fresh link code must survive that.
  var secret = null;  // { kind, value } shown once after adding "Any app"
  var code = null;    // { code, expiresAt } for /pyp connect

  function mount(el, transport, helpers) {
    var toast = helpers.toast;
    if (!transport.connections) { el.innerHTML = ''; return; }
    var data = null;
    var editing = {};   // kind -> true while its URL box is open

    function load() {
      return transport.connections().then(function (d) { data = d; draw(); }, function (e) {
        el.innerHTML = '<h2>Connections</h2><p class="setup-error">' + esc(e.message) + '</p>';
      });
    }

    function row(k) {
      var c = (data.connections || []).filter(function (x) { return x.kind === k.id; })[0];
      var open = editing[k.id] || !c;
      var status = !c ? '<span class="chip chip-muted">Not connected</span>'
        : !c.enabled ? '<span class="chip chip-muted">Off</span>'
        : c.lastStatus && /^Failed/.test(c.lastStatus) ? '<span class="chip chip-warn">' + esc(c.lastStatus) + '</span>'
        : '<span class="chip chip-good">On' + (c.lastSentAt ? ' · ' + esc((c.lastStatus || 'Sent').toLowerCase()) + ' ' + esc(ago(c.lastSentAt)) : '') + '</span>';
      var html = '<article class="cx-item" data-kind="' + k.id + '"><div class="cx-head"><h3>' + esc(k.name) + ' ' + status + '</h3>' +
        (c ? '<div class="cx-actions">' +
          '<button type="button" class="bigswitch wf-switch" role="switch" aria-checked="' + c.enabled + '" aria-label="' + esc(k.name) + ' on or off" data-cx-toggle><span></span></button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-cx-test>Send a test</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-cx-edit>Change</button>' +
          '<button type="button" class="btn btn-danger btn-sm" data-cx-remove>Remove</button></div>' : '') +
        '</div><p class="cx-blurb">' + esc(k.blurb) + (c ? ' <span class="wf-hint">Posting to ' + esc(c.where) + '</span>' : '') + '</p>';
      if (open) {
        html += '<form class="cx-form" data-cx-form><label class="wf-f"><span>Webhook URL</span><input data-cx-url type="url" required placeholder="' + esc(k.placeholder) + '" autocomplete="off"></label>' +
          '<button class="btn btn-sm" type="submit">' + (c ? 'Save' : 'Connect') + '</button>' + (c ? '<button class="btn btn-ghost btn-sm" type="button" data-cx-cancel>Cancel</button>' : '') +
          '</form><p class="wf-hint">' + esc(k.how) + '</p>';
      }
      if (secret && secret.kind === k.id) {
        html += '<div class="cx-secret" role="status"><b>Your signing secret (shown once, copy it now):</b><code>' + esc(secret.value) + '</code>' +
          '<p class="wf-hint">Each request has <code>X-Pyp-Timestamp</code> and <code>X-Pyp-Signature: sha256=…</code>, the HMAC-SHA256 of “timestamp.body” with this secret. Check it to know the request came from Pyp.</p></div>';
      }
      return html + '</article>';
    }

    function slashHTML() {
      var s = data.slack;
      var what = '<ul class="cx-bot"><li><b>Cards come to you as a DM</b> with buttons. Reminders, follow-ups and questions can be approved or answered right in Slack. Anything that moves money or answers a dispute says “Review in Pyp”.</li>' +
        '<li><b>Talk to Pyp</b>: DM it or @mention it, like “invoice Acme $450 for product photos”. Follow-ups in the thread work like the chat here.</li>' +
        '<li><b>/pyp</b> works too, and <code>/pyp run Friday cleanup</code> runs one of your skills.</li></ul>';
      var body = s
        ? '<p>Linked to <b>' + esc(s.teamName) + '</b>' + (s.userName ? ' as <b>@' + esc(s.userName) + '</b>' : '') + '. Only they can talk to Pyp or use its buttons there.</p>' + what + '<button type="button" class="btn btn-ghost btn-sm" data-slack-unlink>Unlink Slack</button>'
        : code
          ? '<p>In Slack, type <code>/pyp connect ' + esc(code.code) + '</code> (works for 15 minutes).</p><button type="button" class="btn btn-ghost btn-sm" data-slack-code>New code</button>'
          : what + '<button type="button" class="btn btn-sm" data-slack-code>Link Slack</button>';
      return '<div class="cx-slash"><h4>Pyp in Slack</h4>' + body +
        (data.botReady ? '' : '<p class="wf-hint">This Pyp server isn’t set up for Slack yet: it needs <code>SLACK_SIGNING_SECRET</code> and <code>SLACK_BOT_TOKEN</code> from Pyp’s Slack app (steps below).</p>') +
        '<details class="cx-howto"><summary>Set up Pyp’s Slack app (once per Pyp server, about 10 minutes)</summary><ol>' +
        '<li>Go to api.slack.com/apps → <b>Create New App</b> → From scratch → name it “Pyp”, pick your workspace.</li>' +
        '<li><b>OAuth &amp; Permissions</b> → Bot Token Scopes: <code>chat:write</code>, <code>im:write</code>, <code>im:history</code>, <code>app_mentions:read</code>, <code>commands</code>, <code>incoming-webhook</code>.</li>' +
        '<li><b>Event Subscriptions</b> → On → Request URL <code>https://&lt;your Pyp address&gt;/api/slack/events</code> → bot events <code>message.im</code> and <code>app_mention</code>.</li>' +
        '<li><b>Interactivity &amp; Shortcuts</b> → On → Request URL <code>https://&lt;your Pyp address&gt;/api/slack/interactions</code>.</li>' +
        '<li><b>Slash Commands</b> → <code>/pyp</code>, Request URL <code>https://&lt;your Pyp address&gt;/api/slack/commands</code>.</li>' +
        '<li><b>App Home</b> → Messages Tab on, and allow people to send messages.</li>' +
        '<li><b>Install to Workspace</b>. Put the Bot User OAuth Token in <code>SLACK_BOT_TOKEN</code> and Basic Information → Signing Secret in <code>SLACK_SIGNING_SECRET</code>, then restart Pyp.</li>' +
        '<li>Back here, tap <b>Link Slack</b> and type the code in Slack.</li></ol>' +
        '<p class="wf-hint">One Slack app serves this Pyp server. Slack needs a public address to reach Pyp, so this works once Pyp is deployed (or through a tunnel).</p></details></div>';
    }

    function draw() {
      el.innerHTML = '<h2>Connections</h2><p>Pyp in the apps you already use. When something needs you, Pyp tells you there. Messages link back to Pyp: approving, editing and undoing always happen here.</p>' +
        '<div class="cx-list"><article class="cx-item">' + slashHTML() + '</article>' + KINDS.map(row).join('') + '</div>';
    }

    function busy(b, label, p) {
      var old = b.textContent;
      b.disabled = true;
      if (label) b.textContent = label;
      return p.then(function (x) { return x; }, function (err) { toast(err.message); }).then(function (x) {
        if (b.isConnected) { b.disabled = false; b.textContent = old; }
        return x;
      });
    }

    el.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || b.disabled || !data) return;
      var item = b.closest('[data-kind]');
      var kind = item && item.getAttribute('data-kind');
      var name = kind && KINDS.filter(function (k) { return k.id === kind; })[0].name;
      if (b.hasAttribute('data-cx-edit')) { editing[kind] = true; return draw(); }
      if (b.hasAttribute('data-cx-cancel')) { editing[kind] = false; return draw(); }
      if (b.hasAttribute('data-cx-test')) {
        return busy(b, 'Sending…', transport.testConnection(kind).then(function () { toast('Test sent to ' + name + '. Check the channel.'); return load(); }));
      }
      if (b.hasAttribute('data-cx-toggle')) {
        var on = b.getAttribute('aria-checked') !== 'true';
        return busy(b, '', transport.setConnection(kind, on).then(function () { toast(name + (on ? ' is on' : ' is off')); return load(); }));
      }
      if (b.hasAttribute('data-cx-remove')) {
        return busy(b, 'Removing…', transport.deleteConnection(kind).then(function () { toast(name + ' removed'); if (secret && secret.kind === kind) secret = null; return load(); }));
      }
      if (b.hasAttribute('data-slack-code')) {
        return busy(b, 'Making a code…', transport.slackCode().then(function (c) { code = c; draw(); }));
      }
      if (b.hasAttribute('data-slack-unlink')) {
        return busy(b, 'Unlinking…', transport.slackUnlink().then(function () { code = null; toast('Slack unlinked'); return load(); }));
      }
    });
    el.addEventListener('submit', function (e) {
      var form = e.target.closest('[data-cx-form]');
      if (!form) return;
      e.preventDefault();
      var kind = form.closest('[data-kind]').getAttribute('data-kind');
      var url = form.querySelector('[data-cx-url]').value.trim();
      var btn = form.querySelector('button[type="submit"]');
      busy(btn, 'Saving…', transport.saveConnection(kind, url).then(function (r) {
        editing[kind] = false;
        secret = r.secret ? { kind: kind, value: r.secret } : secret;
        toast('Connected. Tap “Send a test” to see a message.');
        return load();
      }));
    });

    el.innerHTML = '<h2>Connections</h2><div class="loading">Loading…</div>';
    load();
  }

  root.PypConnections = { mount: mount };
})(typeof window !== 'undefined' ? window : globalThis);
