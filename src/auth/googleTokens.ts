import { readFile } from "node:fs/promises";
import type { InstanceConfig } from "../config.js";
import { UpstreamError } from "../util/http.js";

/**
 * The opposite discipline from msTokens.ts: Google issues ONE refresh token
 * (on the first consent, or any consent with prompt=consent) and it does not
 * rotate. We hold it in the token file the smoke test wrote and only ever
 * read it; what gets cached here is the short-lived access token.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EXPIRY_MARGIN_MS = 60_000;

interface CachedAccess {
  token: string;
  expiresAtMs: number;
}

const cache = new Map<string, CachedAccess>();

export async function getGoogleAccessToken(inst: InstanceConfig): Promise<string> {
  const cached = cache.get(inst.name);
  if (cached && cached.expiresAtMs - EXPIRY_MARGIN_MS > Date.now()) {
    return cached.token;
  }

  let stored: { refresh_token?: string };
  try {
    stored = JSON.parse(await readFile(inst.googleTokenPath, "utf8"));
  } catch {
    throw new UpstreamError(
      "Google Calendar",
      0,
      "no_token",
      `no stored sign-in for instance "${inst.name}" (${inst.googleTokenPath} missing) -- run create-test-event.mjs once to sign in`,
      false,
    );
  }
  if (!stored.refresh_token) {
    throw new UpstreamError("Google Calendar", 0, "no_token", `token file for "${inst.name}" holds no refresh_token`, false);
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: inst.secrets.googleClientId,
      client_secret: inst.secrets.googleClientSecret,
      refresh_token: stored.refresh_token,
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string") {
    throw new UpstreamError(
      "Google Calendar",
      res.status,
      String(body.error ?? "refresh_failed"),
      `token refresh refused (${String(body.error_description ?? "no detail")}) -- re-run the consent flow`,
      false,
    );
  }

  const expiresInS = typeof body.expires_in === "number" ? body.expires_in : 3600;
  cache.set(inst.name, { token: body.access_token, expiresAtMs: Date.now() + expiresInS * 1000 });
  return body.access_token;
}
