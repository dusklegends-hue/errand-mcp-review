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
 * Each upstream wraps its errors differently; this flattens all three to one
 * (code, message) pair so a failure in the transcript names the real cause.
 *   Graph:  { error: { code, message } }
 *   Google: { error: { code, message, errors } }
 *   Meta:   { error: { code, message, error_subcode } }
 */
function extractError(body: unknown): { code: string; message: string } {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error: unknown }).error;
    if (e && typeof e === "object") {
      const err = e as Record<string, unknown>;
      return {
        code: String(err.code ?? "unknown"),
        message: String(err.message ?? JSON.stringify(err)),
      };
    }
    return { code: "unknown", message: String(e) };
  }
  return { code: "unknown", message: typeof body === "string" ? body : JSON.stringify(body) };
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
    } catch (err) {
      // Network-level failure: no status to key on, retry with backoff.
      lastError = new UpstreamError(upstream, 0, "network", (err as Error).message, true);
      await sleep(500 * attempt);
      continue;
    }

    if (res.ok) {
      if (opts.expectJson === false) {
        return { status: res.status, json: null, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
      }
      // 204s and empty bodies are legal success shapes (events.delete).
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null, bytes: null, headers: res.headers };
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => "");
    }
    const { code, message } = extractError(body);
    const retryable = RETRYABLE_STATUS.has(res.status);
    lastError = new UpstreamError(upstream, res.status, code, message, retryable);
    if (!retryable) throw lastError;

    // Honor Retry-After when the upstream names a wait; otherwise back off
    // linearly. Small and bounded: this is a single-operator tool, not a
    // high-throughput worker fighting for quota.
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * attempt);
  }

  throw lastError ?? new UpstreamError(upstream, 0, "unknown", "request failed with no error captured", false);
}
