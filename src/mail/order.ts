/**
 * Order-email parsing for PHI-blind operation (2026-09-01).
 *
 * The point of this module: the AI operator layer never receives member
 * data. `schedule` takes a mail id; the SERVER fetches the email and this
 * file extracts the fields. Pure functions, no I/O, no credentials -- the
 * repo's layout rule (parsing lives where it is testable without a token).
 *
 * The request email is expected to carry labeled lines, the format agreed
 * with the requester (their sending template):
 *
 *   Member's Name: Jane Doe
 *   Pick-Up: 100 Example St, Springfield 00005
 *   Destination: 410 Maple Ave, Springfield 00025
 *
 * Label synonyms are accepted (below); anything unlabeled is ignored.
 */

export interface ParsedOrder {
  member: string;
  pickupFrom: string;
  deliverTo: string;
}

export interface ParseResult {
  order: ParsedOrder | null;
  /** Field names that had no labeled line -- empty when `order` is set. */
  missing: string[];
}

/** Line-anchored label alternatives per field. Order of fields matters for masking. */
const FIELD_PATTERNS: Array<{ field: keyof ParsedOrder; re: RegExp }> = [
  { field: "member", re: /^\s*(?:member['’]?s? name|member|patient(?: name)?|name)\s*[:\-]\s*(.+)\s*$/i },
  { field: "pickupFrom", re: /^\s*(?:pick-?up(?: from| location| address)?|collect from)\s*[:\-]\s*(.+)\s*$/i },
  { field: "deliverTo", re: /^\s*(?:deliver(?: to)?|delivery address|destination(?: location| address)?|drop-?off|address)\s*[:\-]\s*(.+)\s*$/i },
];

export function parseOrder(bodyText: string): ParseResult {
  const found: Partial<ParsedOrder> = {};
  for (const line of bodyText.split(/\r?\n/)) {
    for (const { field, re } of FIELD_PATTERNS) {
      if (found[field]) continue; // first labeled line wins
      const m = re.exec(line);
      if (m) {
        found[field] = m[1].trim();
        break; // a line labels at most one field
      }
    }
  }
  const missing = FIELD_PATTERNS.map((f) => f.field).filter((f) => !found[f]);
  return missing.length > 0
    ? { order: null, missing }
    : { order: found as ParsedOrder, missing: [] };
}

/**
 * Masks the VALUES of labeled order fields so a mail-list preview can show
 * "there is an order here" without carrying the member data itself.
 * Unlabeled text passes through -- the subject/preview template agreed with
 * the requester must not put PHI outside labeled lines.
 */
export function maskOrderPii(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      for (const { re } of FIELD_PATTERNS) {
        const m = re.exec(line);
        if (m) return line.slice(0, line.length - m[1].trim().length - (line.length - line.trimEnd().length)).trimEnd() + " ▎▎▎";
      }
      return line;
    })
    .join("\n");
}

/**
 * Very small HTML-to-text: enough for Outlook order mails. Block-ish closers
 * become newlines so the labeled-line parser keeps its line structure.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<\s*(?:br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n");
}

/**
 * Derives the delivery zone from the parsed address using the instance's
 * region map (zone -> 5-digit ZIPs). Null when no map, no ZIP in the
 * address, or no zone claims it -- schedule then simply has no region
 * preference, which is a working answer, not an error.
 */
export function regionForAddress(
  deliverTo: string,
  regions: Record<string, string[]> | undefined,
): string | null {
  if (!regions) return null;
  const zips = deliverTo.match(/\b\d{5}\b/g) ?? [];
  for (const zip of zips) {
    for (const [zone, zoneZips] of Object.entries(regions)) {
      if (zoneZips.includes(zip)) return zone;
    }
  }
  return null;
}
