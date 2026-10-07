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
  /** Raw labeled values, read in the service time zone by calendar/trip.ts. */
  appointmentDate?: string;
  appointmentTime?: string;
  /** The request's own "Pick-up Time", when the requester states one. */
  pickupTime?: string;
}

export interface ParseResult {
  order: ParsedOrder | null;
  /** Required field names that had no labeled line -- empty when `order` is set. */
  missing: string[];
  /** How many labeled fields were found at all; 0 means "not a request". */
  found: number;
}

type Field = keyof ParsedOrder;

/**
 * Line-anchored label alternatives per field. The time and date labels come
 * FIRST: "Pick-up Time" must never be read as a pick-up address, and a line
 * labels at most one field.
 */
const FIELD_PATTERNS: Array<{ field: Field; re: RegExp }> = [
  { field: "pickupTime", re: /^\s*pick-?up time\s*[:\-]\s*(.+)\s*$/i },
  { field: "appointmentDate", re: /^\s*(?:date of (?:the )?appointment|appointment date|appt\.? date)\s*[:\-]\s*(.+)\s*$/i },
  { field: "appointmentTime", re: /^\s*(?:time of (?:the )?appointment|appointment time|appt\.? time)\s*[:\-]\s*(.+)\s*$/i },
  { field: "member", re: /^\s*(?:member['’]?s? name|member|patient(?: name)?|name)\s*[:\-]\s*(.+)\s*$/i },
  { field: "pickupFrom", re: /^\s*(?:pick-?up(?: from| location| address)?|collect from)\s*[:\-]\s*(.+)\s*$/i },
  { field: "deliverTo", re: /^\s*(?:deliver(?: to)?|delivery address|destination(?: location| address)?|drop-?off|address)\s*[:\-]\s*(.+)\s*$/i },
];

/** "Appointment: 09/02/2026 10:00 AM" -- one line carrying both halves. */
const COMBINED_APPOINTMENT = /^\s*(?:appointment(?: date\s*(?:\/|and|&)\s*time)?|appt\.?)\s*[:\-]\s*(.+)\s*$/i;
const DATE_THEN_TIME = /^(\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4})\s*(?:at|@|,)?\s*(.+)$/i;

const BASE_REQUIRED: Field[] = ["member", "pickupFrom", "deliverTo"];
const APPOINTMENT_REQUIRED: Field[] = ["appointmentDate", "appointmentTime"];

/**
 * `requireAppointment` makes the appointment date and time required fields,
 * which is how an instance that books by appointment time treats a request
 * without them: incomplete, not bookable.
 */
export function parseOrder(bodyText: string, opts: { requireAppointment?: boolean } = {}): ParseResult {
  const found: Partial<ParsedOrder> = {};
  for (const line of bodyText.split(/\r?\n/)) {
    let labeled = false;
    for (const { field, re } of FIELD_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        if (!found[field]) found[field] = m[1].trim(); // first labeled line wins
        labeled = true;
        break; // a line labels at most one field
      }
    }
    if (labeled) continue;
    const c = COMBINED_APPOINTMENT.exec(line);
    if (c && !found.appointmentDate) {
      const split = DATE_THEN_TIME.exec(c[1].trim());
      found.appointmentDate = split ? split[1] : c[1].trim();
      if (split && !found.appointmentTime) found.appointmentTime = split[2].trim();
    }
  }
  const required = opts.requireAppointment ? [...BASE_REQUIRED, ...APPOINTMENT_REQUIRED] : BASE_REQUIRED;
  const missing = required.filter((f) => !found[f]);
  const count = Object.values(found).filter(Boolean).length;
  return missing.length > 0
    ? { order: null, missing, found: count }
    : { order: found as ParsedOrder, missing: [], found: count };
}

/**
 * US request dates: MM/DD/YYYY (also M/D/YY, dashes or dots) or ISO
 * YYYY-MM-DD. Null for anything else or an impossible date -- the caller
 * reports "unreadable" rather than guessing.
 */
export function parseDateValue(s: string): { year: number; month: number; day: number } | null {
  const t = s.trim();
  let year: number;
  let month: number;
  let day: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) {
    [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/.exec(t))) {
    [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[3].length === 2) year += 2000;
  } else {
    return null;
  }
  // Round-trip through Date.UTC rejects 02/30 and 13/01.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/**
 * "10:00 AM", "9:15am", "2 p.m.", or unambiguous 24-hour "14:30" / "00:30".
 * Anything that could be either AM or PM -- "10", "2:00", "6:00" -- is
 * refused: a missing AM/PM fails safe instead of booking a plausible-looking
 * wrong time (customer IT review, 2026-10-07).
 */
export function parseTimeValue(s: string): { hour: number; minute: number } | null {
  const t = s.trim().toLowerCase().replace(/\./g, "");
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (minute > 59) return null;
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (m[3] === "pm") hour += 12;
  } else {
    // Without AM/PM only 24-hour readings that cannot be 12-hour pass.
    if (!m[2] || hour > 23 || (hour >= 1 && hour <= 12)) return null;
  }
  return { hour, minute };
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
