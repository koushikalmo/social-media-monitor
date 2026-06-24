// gate check: which channel does the current OAuth token actually bind to?
// the analytics token is only usable if this prints the channel you want
// (Eagle 3D Streaming / UCA_NxRFfbYSG3kOeHak0BjQ). an empty list means the token
// is bound to a Google identity with no channel, and analytics will 403.
//
// reads YT_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN (+ optional YT_CHANNEL)
// from the environment.
//   mac:      set -a && source .env && set +a && node whoami.mjs
//   windows:  use whoami.bat (sets the vars, then calls this)

const need = ["YT_OAUTH_CLIENT_ID", "YT_OAUTH_CLIENT_SECRET", "YT_OAUTH_REFRESH_TOKEN"];
for (const n of need) {
  if (!process.env[n]) {
    console.error(`missing ${n} in env`);
    process.exit(1);
  }
}

const tok = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: process.env.YT_OAUTH_CLIENT_ID,
    client_secret: process.env.YT_OAUTH_CLIENT_SECRET,
    refresh_token: process.env.YT_OAUTH_REFRESH_TOKEN,
    grant_type: "refresh_token",
  }),
}).then((r) => r.json());

if (!tok.access_token) {
  console.log("TOKEN ERROR:", JSON.stringify(tok));
  process.exit(1);
}
console.log("token refresh: OK");

const me = await fetch(
  "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
  { headers: { Authorization: `Bearer ${tok.access_token}` } }
).then((r) => r.json());

const items = (me.items ?? []).map((i) => ({ id: i.id, title: i.snippet.title }));
if (items.length === 0) {
  console.log("WHOAMI: [] — this token owns NO channel. analytics will 403.");
  console.log("        re-mint and select the brand channel at the 'Choose a channel' step.");
} else {
  console.log("WHOAMI — channels this token can act as:");
  for (const c of items) console.log(`  ${c.id}  ${c.title}`);
  const want = process.env.YT_CHANNEL?.trim();
  if (want && items.some((c) => c.id === want)) {
    console.log(`\nOK: token includes ${want} — analytics should work.`);
  } else if (want) {
    console.log(`\nNOT FOUND: ${want} is not in the list above — analytics will 403.`);
  }
}
