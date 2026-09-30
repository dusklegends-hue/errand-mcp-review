// Smoke test: sign in to Outlook via the device-code flow, save the refresh
// token, and print the newest inbox message. Proves the Graph read path works
// before the real mail-reading logic gets built on top.
//
// Reuses the refresh token in .ms-tokens.json on later runs, so you only sign
// in through the browser once.
//
// Run:  node --env-file=.env get-token.mjs

import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const clientId = process.env.MS_CLIENT_ID;
if (!clientId) {
  console.error("Missing MS_CLIENT_ID -- fill in .env first.");
  process.exit(1);
}

// "consumers" because the mailbox is a personal Microsoft account.
const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const SCOPE = "https://graph.microsoft.com/Mail.Read offline_access";
const TOKEN_FILE = new URL("./.ms-tokens.json", import.meta.url);

const form = (params) =>
  fetch(params.url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params.body),
  }).then((r) => r.json());

/** Browser sign-in. Only runs when there is no stored refresh token. */
async function authorizeInteractively() {
  const dc = await form({
    url: `${AUTHORITY}/devicecode`,
    body: { client_id: clientId, scope: SCOPE },
  });
  if (!dc.device_code) {
    console.error("Device code request failed:", JSON.stringify(dc, null, 2));
    process.exit(1);
  }

  console.log(`\nSign in at ${dc.verification_uri} with code: ${dc.user_code}\n`);
  exec(`start ${dc.verification_uri}`); // open the browser onto the sign-in page

  // Poll until the sign-in completes. "authorization_pending" means keep
  // waiting; every other error is real and ends the run.
  while (true) {
    await new Promise((r) => setTimeout(r, (dc.interval ?? 5) * 1000));
    const tok = await form({
      url: `${AUTHORITY}/token`,
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: dc.device_code,
      },
    });
    if (tok.access_token) return tok;
    if (tok.error !== "authorization_pending") {
      console.error("Sign-in failed:", JSON.stringify(tok, null, 2));
      process.exit(1);
    }
  }
}

// ─── 1. Reuse a stored grant if we have one, otherwise sign in ─────────────
let tokens;
let stored;
try {
  stored = JSON.parse(await readFile(TOKEN_FILE, "utf8"));
} catch {
  stored = null; // no token file yet, or unreadable -- just re-authorize
}

if (stored?.refresh_token) {
  tokens = await form({
    url: `${AUTHORITY}/token`,
    body: {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: stored.refresh_token,
      scope: SCOPE,
    },
  });
  if (!tokens.access_token) {
    console.log("Stored refresh token was refused -- signing in again.");
    tokens = await authorizeInteractively();
  } else {
    console.log("Reusing stored refresh token -- no sign-in needed.");
  }
} else {
  tokens = await authorizeInteractively();
}

// Refresh tokens rotate on use: always store the newest one.
if (tokens.refresh_token) {
  await writeFile(TOKEN_FILE, JSON.stringify({ refresh_token: tokens.refresh_token }, null, 2), "utf8");
}

// ─── 2. Read the newest inbox message ──────────────────────────────────────
const res = await fetch(
  "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=1&$select=subject,from,receivedDateTime,hasAttachments",
  { headers: { Authorization: `Bearer ${tokens.access_token}` } },
);
const body = await res.json();

if (!res.ok) {
  console.error(res.status, JSON.stringify(body, null, 2));
  process.exit(1);
}

const m = body.value?.[0];
if (!m) {
  console.log("Signed in, but the inbox is empty.");
} else {
  console.log(`\nNewest message:`);
  console.log(`  From:        ${m.from?.emailAddress?.address}`);
  console.log(`  Subject:     ${m.subject}`);
  console.log(`  Received:    ${m.receivedDateTime}`);
  console.log(`  Attachments: ${m.hasAttachments ? "yes" : "no"}`);
}
