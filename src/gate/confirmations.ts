import { createHash, randomUUID } from "node:crypto";

interface StoredConfirmation {
  fingerprint: string;
  expiresAt: number;
}

// Plain in-memory store: this is a single-process stdio-local server, so a
// restart invalidating any pending confirmation is the correct safe failure
// mode, not a gap that needs persistence.
const store = new Map<string, StoredConfirmation>();

// Deliberately not read from config.ts at import time: the gate package has
// zero dependency on config/env by design, so its tests run with no .env and
// no network access at all. The real server calls configureConfirmTtl() once
// at startup instead.
const DEFAULT_TTL_MS = 300_000;
let ttlMs = DEFAULT_TTL_MS;

export function configureConfirmTtl(ms: number): void {
  ttlMs = ms;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/**
 * Binds a confirmation to the EXACT call it was issued for. Instance and
 * mode are part of the fingerprint, not just the arguments: without them a
 * token issued for a test-mode dispatch would also authorize the same
 * dispatch in live mode, which is precisely the one-typo-from-production
 * failure the whole instance/mode design exists to prevent.
 */
export function fingerprint(
  tool: string,
  action: string,
  instance: string,
  mode: string,
  params: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(`${tool}:${action}:${instance}:${mode}:${canonicalize(params)}`)
    .digest("hex");
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [token, entry] of store) {
    if (entry.expiresAt < now) store.delete(token);
  }
}

export function issueToken(fp: string): { token: string; expiresAt: string } {
  sweepExpired();
  const token = `c_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const expiresAtMs = Date.now() + ttlMs;
  store.set(token, { fingerprint: fp, expiresAt: expiresAtMs });
  return { token, expiresAt: new Date(expiresAtMs).toISOString() };
}

/**
 * Single-use + fingerprint-bound: a token issued for one
 * (tool, action, instance, mode, params) tuple cannot be replayed against a
 * different one by changing any part of it while keeping the token, and
 * cannot be reused after success. Burned on ANY presentation, including a
 * fingerprint mismatch -- a mismatched attempt invalidates the pending
 * confirmation rather than staying live for repeated guesses.
 */
export function consumeToken(token: string, fp: string): boolean {
  const entry = store.get(token);
  if (!entry) return false;
  store.delete(token);
  if (entry.expiresAt < Date.now()) return false;
  return entry.fingerprint === fp;
}

/** Test-only escape hatch to guarantee isolation between test cases. */
export function _resetForTests(): void {
  store.clear();
}
