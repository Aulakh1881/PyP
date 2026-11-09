// Prints the Slack app manifest for Pyp, filled in for one Pyp address.
//
//   node scripts/slack-manifest.mjs https://your-pyp.example.com
//
// At api.slack.com/apps → Create New App → From an app manifest → pick the
// workspace → paste this (JSON tab). It sets the bot's scopes, the events it
// listens to, the buttons' URL and /pyp. Then Install to Workspace, and put the
// Bot User OAuth Token in SLACK_BOT_TOKEN and Basic Information → Signing Secret
// in SLACK_SIGNING_SECRET. With a new address (a new tunnel, or Render), update
// the three URLs in the app (or paste a fresh manifest).

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!/^https:\/\/[^/]+$/.test(base)) {
  console.error("Usage: node scripts/slack-manifest.mjs https://your-pyp-address (https, no path)");
  process.exit(1);
}

const manifest = {
  display_information: {
    name: "Pyp",
    description: "Your PayPal back office: Pyp proposes, you approve.",
    background_color: "#1747b8",
  },
  features: {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: "Pyp", always_online: true },
    slash_commands: [
      {
        command: "/pyp",
        url: `${base}/api/slack/commands`,
        description: "Talk to Pyp, or run one of your skills",
        usage_hint: "invoice Acme $450 for product photos · run Friday cleanup · connect CODE",
        should_escape: false,
      },
    ],
  },
  oauth_config: {
    scopes: { bot: ["chat:write", "im:write", "im:history", "app_mentions:read", "commands", "incoming-webhook"] },
  },
  settings: {
    event_subscriptions: { request_url: `${base}/api/slack/events`, bot_events: ["message.im", "app_mention"] },
    interactivity: { is_enabled: true, request_url: `${base}/api/slack/interactions` },
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false,
  },
};

console.log(JSON.stringify(manifest, null, 2));
