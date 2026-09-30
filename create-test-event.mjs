// Smoke test: OAuth once against Google Calendar, then create one throwaway
// event on the TEST calendar (never your real one). Proves the credentials
// and the write path work before any real extraction logic sits on top.
//
// Reuses the refresh token in .tokens.json on later runs, so you only sign
// in through the browser once.
//
// Run:  node --env-file=.env create-test-event.mjs

import { OAuth2Client } from "google-auth-library";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const calendarId = process.env.GOOGLE_CALENDAR_ID;

for (const [name, value] of Object.entries({ GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_CALENDAR_ID: calendarId })) {
  if (!value) {
    console.error(`Missing ${name} -- fill in .env first.`);
    process.exit(1);
  }
}

const PORT = 3939;
// Google's docs specify the 127.0.0.1 literal, not the localhost hostname,
// for the loopback flow.
const redirectUri = `http://127.0.0.1:${PORT}`;
const TOKEN_FILE = new URL("./.tokens.json", import.meta.url);
const client = new OAuth2Client(clientId, clientSecret, redirectUri);

/** Browser sign-in. Only runs when there is no stored refresh token. */
async function authorizeInteractively() {
  // Binds the callback to THIS run: a code arriving without the state we
  // generated is not ours and is refused rather than exchanged.
  const expectedState = randomBytes(16).toString("hex");

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, redirectUri);
      const authCode = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      const finish = (message, err) => {
        res.end(message);
        server.close();
        if (err) reject(err);
        else resolve(authCode);
      };

      if (error) return finish(`Authorization failed: ${error}`, new Error(`Google returned "${error}"`));
      if (!authCode) return finish("No authorization code received.", new Error("no authorization code in callback"));
      if (state !== expectedState) return finish("State mismatch -- refused.", new Error("state mismatch: callback did not originate from this run"));
      finish("Authorized -- you can close this tab.");
    });

    server.on("error", reject);

    // 127.0.0.1 explicitly: without a host argument Node listens on all
    // interfaces, exposing this callback to the local network.
    server.listen(PORT, "127.0.0.1", () => {
      const authUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        state: expectedState,
        // events for booking, readonly for freebusy.query across the roster.
        scope: [
          "https://www.googleapis.com/auth/calendar.events",
          "https://www.googleapis.com/auth/calendar.readonly",
        ],
      });
      console.log(`\nOpen this URL and sign in:\n${authUrl}\n`);
    });
  });

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  if (tokens.refresh_token) {
    // The durable half of the grant. Without persisting it, access_type
    // "offline" buys nothing and every run needs the browser again.
    await writeFile(TOKEN_FILE, JSON.stringify({ refresh_token: tokens.refresh_token }, null, 2), "utf8");
    console.log("Authorized. Refresh token saved to .tokens.json.");
  } else {
    console.log("Authorized, but Google returned no refresh token -- next run will need the browser again.");
  }
}

// ─── 1. Reuse a stored grant if we have one, otherwise sign in ─────────────
let stored;
try {
  stored = JSON.parse(await readFile(TOKEN_FILE, "utf8"));
} catch {
  stored = null; // no token file yet, or it is unreadable -- just re-authorize
}

if (stored?.refresh_token) {
  client.setCredentials({ refresh_token: stored.refresh_token });
  console.log("Reusing stored refresh token -- no sign-in needed.");
} else {
  await authorizeInteractively();
}

// ─── 2. Create one test event, an hour from now ────────────────────────────
const start = new Date(Date.now() + 60 * 60 * 1000);
const end = new Date(start.getTime() + 30 * 60 * 1000);

// client.request refreshes the access token on demand from the refresh token.
let res;
try {
  res = await client.request({
    url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    method: "POST",
    data: {
      summary: "errand-mcp test event",
      description: "Proves the Calendar API write path works.",
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    },
  });
} catch (err) {
  console.error(`\nFailed: ${err.message}`);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
}

console.log(res.status, JSON.stringify(res.data, null, 2));
console.log(`\nCreated: ${res.data.htmlLink}`);
