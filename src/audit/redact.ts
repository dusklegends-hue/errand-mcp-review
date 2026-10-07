/**
 * Config-free on purpose so it is testable without an env file, and because
 * redaction rules are policy, not plumbing.
 *
 * Two categories, redacted differently. Credentials never belong in a log at
 * all. This pipeline's sensitive values, though, are mostly NOT credentials:
 * they are member names, trip addresses, and phone numbers sitting in
 * ordinary fields -- health information in transit (build plan, "the slip is
 * health information"). Those are masked but keyed, so the audit line still
 * shows THAT a member name/address was present and which call carried it, without
 * becoming a second copy of the data.
 */
const SECRET_KEY_PATTERN = /token|password|secret|authorization|credential/i;
// One entry per field the IT brief's "data in scope" list names, plus the
// legacy shapes. Matching is deliberately greedy: a new PHI-shaped key
// should default to redacted, and over-redaction costs nothing but detail
// in a log line. `query`/`search` (2026-10-07): a free-text mailbox search
// is typed by the operator and can be a member's name.
const PII_KEY_PATTERN =
  /patient|member|name|pickup|deliver|dest|address|phone|whatsapp|recipient|passenger|special|impair|appointment|mileage|query|search/i;
const MAX_STRING_LEN = 200;

export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = "<redacted>";
      continue;
    }
    if (PII_KEY_PATTERN.test(key)) {
      out[key] = "<redacted:pii>";
      continue;
    }
    if (typeof value === "string" && value.length > MAX_STRING_LEN) {
      out[key] = `${value.slice(0, MAX_STRING_LEN)}...(${value.length - MAX_STRING_LEN} more chars)`;
      continue;
    }
    out[key] = value;
  }
  return out;
}
