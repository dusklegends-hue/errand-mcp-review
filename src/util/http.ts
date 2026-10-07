/**
 * The one authenticated call path (build plan §2): retries, backoff, and
 * error normalization live here and nowhere else. Three upstreams share it;
 * none of them ever sees a raw 429.
 */

export class UpstreamError extends Error {
  constructor(
    public readonly upstream: string,
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(`${upstream}: ${message}`);
    this.name = "UpstreamError";
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

/**
 * Each upstream wraps its errors differently; this flattens both to one
 * machine CODE -- never the upstream's message text. Upstream messages can
 * quote what was sent (a Graph $search syntax error quotes the search,
 * which may be a member's name), and an error travels to the operator and
 * into the audit log. The code plus the HTTP status is enough to diagnose;
 * the prose is not worth the leak (customer IT review, 2026-10-07).
 *   Graph:  { error: { code: "ErrorItemNotFound", message } }
 *   Google: { error: { code: 404, status: "NOT_FOUND", errors: [{ reason: "notFound" }], message } }
 */
export function extractErrorCode(body: unknown): string {
  let code: unknown = "unknown";
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error: unknown }).error;
    if (e && typeof e === "object") {
      const err = e as Record<string, unknown>;
      const reason = Array.isArray(err.errors) ? (err.errors[0] as Record<string, unknown> | undefined)?.reason : undefined;
      code = reason ?? err.status ?? err.code ?? "unknown";
    } else if (typeof e === "string") {
      code = e; // OAuth token endpoints: { error: "invalid_grant" }
    }
  }
  // An enumeration-shaped token or nothing: never free text, not even squashed.
  const token = String(code);
  return /^[A-Za-z0-9_.-]{1,60}$/.test(token) ? token : "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | FormData;
  /** Set false for endpoints that return raw bytes (attachment $value). */
  expectJson?: boolean;
}

export async function request(
  upstream: string,
  url: string,
  opts: RequestOptions = {},
): Promise<{ status: number; json: unknown; bytes: Buffer | null; headers: Headers }> {
  let lastError: UpstreamError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: opts.method ?? "GET", headers: opts.headers, body: opts.body });
    } catch {
      // Network-level failure: no status to key on, retry with backoff.
      lastError = new UpstreamError(upstream, 0, "network", "network error (no response)", true);
      await sleep(500 * attempt);
      continue;
    }

    if (res.ok) {
      if (opts.expectJson === false) {
        return { status: res.status, json: null, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
      }
      // 204s and empty bodies are legal success shapes (events.delete).
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // A SyntaxError's message quotes the body it choked on.
        throw new UpstreamError(upstream, res.status, "invalid_json", `HTTP ${res.status} invalid_json`, false);
      }
      return { status: res.status, json, bytes: null, headers: res.headers };
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => "");
    }
    const code = extractErrorCode(body);
    const retryable = RETRYABLE_STATUS.has(res.status);
    lastError = new UpstreamError(upstream, res.status, code, `HTTP ${res.status} ${code}`, retryable);
    if (!retryable) throw lastError;

    // Honor Retry-After when the upstream names a wait; otherwise back off
    // linearly. Small and bounded: this is a single-operator tool, not a
    // high-throughput worker fighting for quota.
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * attempt);
  }

  throw lastError ?? new UpstreamError(upstream, 0, "unknown", "request failed with no error captured", false);
}
