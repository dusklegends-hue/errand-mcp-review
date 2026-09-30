import { zonedDateParts, zonedTimeToUtc } from "../util/tz.js";

/**
 * The one real algorithm in the server (build plan, stage 2), kept as a pure
 * function over busy-block input so it is tested against fixtures before it
 * ever touches the network. No Date.now() in here: `now` is an argument.
 */

export interface DriverAvailability {
  driver: string;
  /** Zone this driver covers ("central", "east", ...). Optional. */
  region?: string;
  calendarId: string;
  /** Live data from freebusy -- never cached (roster is shape; busy is data). */
  busy: { start: string; end: string }[];
}

export interface SlotQuery {
  now: Date;
  durationMinutes: number;
  horizonDays: number;
  /** Service wall-clock hours, HH:MM in `timeZone`. */
  open: string;
  close: string;
  timeZone: string;
}

export interface FoundSlot {
  driver: string;
  region?: string;
  calendarId: string;
  start: Date;
  end: Date;
}

interface Interval {
  start: number;
  end: number;
}

function parseHHMM(s: string): { h: number; m: number } {
  const [h, m] = s.split(":").map(Number);
  return { h: h!, m: m! };
}

/** Service-hours windows across the horizon, as UTC intervals, clipped to start no earlier than `now`. */
export function serviceWindows(q: SlotQuery): Interval[] {
  const open = parseHHMM(q.open);
  const close = parseHHMM(q.close);
  const windows: Interval[] = [];
  for (let d = 0; d <= q.horizonDays; d++) {
    // Walk days in the service's own calendar, not by adding 24h to a UTC
    // instant -- DST days are 23 or 25 hours long and drift otherwise.
    const probe = new Date(q.now.getTime() + d * 86_400_000);
    const { year, month, day } = zonedDateParts(probe, q.timeZone);
    const startMs = zonedTimeToUtc(year, month, day, open.h, open.m, q.timeZone).getTime();
    const endMs = zonedTimeToUtc(year, month, day, close.h, close.m, q.timeZone).getTime();
    const clippedStart = Math.max(startMs, q.now.getTime());
    if (endMs - clippedStart >= q.durationMinutes * 60_000) {
      windows.push({ start: clippedStart, end: endMs });
    }
  }
  return windows;
}

export function mergeBusy(busy: { start: string; end: string }[]): Interval[] {
  const sorted = busy
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const b of sorted) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) {
      last.end = Math.max(last.end, b.end);
    } else {
      merged.push({ ...b });
    }
  }
  return merged;
}

/** Subtract merged busy intervals from one window; return the free remainder. */
function subtract(window: Interval, busy: Interval[]): Interval[] {
  const free: Interval[] = [];
  let cursor = window.start;
  for (const b of busy) {
    if (b.end <= cursor || b.start >= window.end) continue;
    if (b.start > cursor) free.push({ start: cursor, end: Math.min(b.start, window.end) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= window.end) break;
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });
  return free;
}

/**
 * Earliest slot of `durationMinutes` inside service hours, across the whole
 * roster. Ties (two drivers free at the same instant) go to roster order, so
 * the roster doubles as a priority list. Null means nobody is free inside
 * the horizon -- a real answer, distinct from an error.
 */
export function findSoonestSlot(drivers: DriverAvailability[], q: SlotQuery): FoundSlot | null {
  const windows = serviceWindows(q);
  const durationMs = q.durationMinutes * 60_000;

  let best: FoundSlot | null = null;
  for (const driver of drivers) {
    const busy = mergeBusy(driver.busy);
    for (const window of windows) {
      for (const free of subtract(window, busy)) {
        if (free.end - free.start < durationMs) continue;
        if (best === null || free.start < best.start.getTime()) {
          best = {
            driver: driver.driver,
            calendarId: driver.calendarId,
            region: driver.region,
            start: new Date(free.start),
            end: new Date(free.start + durationMs),
          };
        }
        break; // earliest free interval in this window is the only candidate
      }
      if (best && best.start.getTime() <= window.start) break;
    }
  }
  return best;
}

/** Free sub-intervals of `window` after removing a driver's raw busy blocks. */
export function freeIntervals(
  window: { start: number; end: number },
  busy: { start: string; end: string }[],
): { start: number; end: number }[] {
  return subtract(window, mergeBusy(busy));
}
