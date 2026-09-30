/**
 * The three-clocks trap (build plan): Graph hands over UTC, Google hands over
 * each calendar's own zone, drivers think in local wall-clock, and US DST
 * shifts on its own dates. The rule applied here: normalize to UTC instants
 * on entry, compare there, format to local only at the edge. Never do date
 * arithmetic on a local-time string.
 *
 * No timezone library: Intl already knows every zone's rules, and the two
 * helpers below are the only conversions this server needs.
 */

function tzOffsetMs(utcMs: number, timeZone: string): number {
  // What wall-clock does `utcMs` show in `timeZone`? Read it back through
  // Intl, reinterpret those parts as if they were UTC, and the difference is
  // the zone's offset at that instant.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!, parts.second!);
  return asUtc - utcMs;
}

/**
 * The UTC instant at which `timeZone` shows the given local wall-clock time.
 * Two-pass: guess the offset at the naive instant, then re-check it at the
 * corrected instant so a DST boundary between the two does not skew the
 * result.
 */
export function zonedTimeToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let offset = tzOffsetMs(naive, timeZone);
  offset = tzOffsetMs(naive - offset, timeZone);
  return new Date(naive - offset);
}

/** The calendar date (y, m, d) that `timeZone` shows at the given instant. */
export function zonedDateParts(instant: Date, timeZone: string): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { year: parts.year!, month: parts.month!, day: parts.day! };
}

/** Format an instant as local wall-clock for a human -- the one edge where local time is allowed. */
export function formatLocal(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(instant);
}
