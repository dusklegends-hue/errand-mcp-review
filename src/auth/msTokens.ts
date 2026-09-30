import { readFile, writeFile } from "node:fs/promises";
import type { InstanceConfig } from "../config.js";
import { UpstreamError } from "../util/http.js";

/**
 * Microsoft refresh tokens ROTATE: every refresh may hand back a new one and
 * quietly retire the old. So the store is rewritten on every refresh that
 * carries a token, and the in-memory access token is cached until shortly
 * before expiry. Google's tokens do not behave like this -- see
 * googleTokens.ts -- which is exactly the "two token stores behave nothing
 * alike" trap from the build plan.
 */

// "consumers" because the mailbox is a personal Microsoft account.
const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const SCOPE = "https://graph.microsoft.com/Mail.Read offline_access";
/** Refresh a minute early so an in-flight call never carries a just-expired token. */
const EXPIRY_MARGIN_MS = 60_000;

interface CachedAccess {
  token: string;
  expiresAtMs: number;
}

const cache = new Map<string, CachedAccess>();

export async function getMsAccessToken(inst: InstanceConfig): Promise<string> {
  const cached = cache.get(inst.name);
  if (cached && cached.expiresAtMs - EXPIRY_MARGIN_MS > Date.now()) {
    return cached.token;
  }

  let stored: { refresh_token?: string };
  try {
    stored = JSON.parse(await readFile(inst.mailTokenPath, "utf8"));
  } catch {
    throw new UpstreamError(
      "Microsoft Graph",
      0,
      "no_token",
      `no stored sign-in for instance "${inst.name}" (${inst.mailTokenPath} missing) -- run get-token.mjs once to sign in`,
      false,
    );
  }
  if (!stored.refresh_token) {
    throw new UpstreamError("Microsoft Graph", 0, "no_token", `token file for "${inst.name}" holds no refresh_token`, false);
  }

  const res = await fetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: inst.secrets.msClientId,
      refresh_token: stored.refresh_token,
      scope: SCOPE,
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string") {
    // A refused refresh means the grant itself died (revoked, or 90 days
    // unused) -- the fix is a re-sign-in, and the error should say so.
    throw new UpstreamError(
      "Microsoft Graph",
      res.status,
      String(body.error ?? "refresh_failed"),
      `token refresh refused (${String(body.error_description ?? "no detail")}) -- re-run get-token.mjs to sign in again`,
      false,
    );
  }

  if (typeof body.refresh_token === "string") {
    await writeFile(inst.mailTokenPath, JSON.stringify({ refresh_token: body.refresh_token }, null, 2), "utf8");
  }

  const expiresInS = typeof body.expires_in === "number" ? body.expires_in : 3600;
  cache.set(inst.name, { token: body.access_token, expiresAtMs: Date.now() + expiresInS * 1000 });
  return body.access_token;
}
