/**
 * Appointment-time booking (2026-10-07, the customer IT's go-live
 * requirement): a trip is booked at the time the REQUEST states, never at
 * the next opening. The Transportation Request form carries "Date of the
 * Appointment", "Time of the Appointment" and usually its own "Pick-up
 * Time"; the trip on the driver's calendar runs from that pick-up to the
 * appointment. When the form gives no pick-up time, the trip starts
 * `durationMinutes` before the appointment.
 *
 * If no driver is free for that exact window the answer is "not booked --
 * needs a human call". It never slides the trip to a different time: a
 * 2:00 PM appointment booked as a 10:52 AM trip is the failure this module
 * exists to prevent.
 *
 * Pure functions, same discipline as slots.ts and plan.ts: `now` is an
 * argument, no I/O. Every refusal reason names a rule or a format, never a
 * value from the request -- reasons reach the operator and the audit log,
 * and request values are PHI.
 */
import { parseDateValue, parseTimeValue, type ParsedOrder } from "../mail/order.js";
import { zonedTimeToUtc } from "../util/tz.js";
import { localDate } from "./plan.js";
import { mergeBusy, type DriverAvailability } from "./slots.js";

export interface TripQuery {
  now: Date;
  /** Trip length used only when the request states no pick-up time. */
  durationMinutes: number;
  /** Service wall-clock hours, HH:MM in `timeZone`. */
  open: string;
  close: string;
  timeZone: string;
}

export type TripWindow =
  | { ok: true; start: Date; end: Date; pickupFromRequest: boolean }
  | { ok: false; reason: string };

/** A date further out than this is far likelier a typo than a real booking. */
const MAX_DAYS_AHEAD = 90;
/** A local trip longer than this means the pick-up or appointment time is wrong. */
const MAX_TRIP_MINUTES = 240;

function hhmm(s: string): { h: number; m: number } {
  const [h, m] = s.split(":").map(Number);
  return { h: h!, m: m! };
}

export function tripWindow(order: ParsedOrder, q: TripQuery): TripWindow {
  if (!order.appointmentDate || !order.appointmentTime) {
    return { ok: false, reason: "the request has no appointment date and time" };
  }
  const date = parseDateValue(order.appointmentDate);
  if (!date) return { ok: false, reason: "the appointment date is not in a recognized format (MM/DD/YYYY)" };
  const appt = parseTimeValue(order.appointmentTime);
  if (!appt) return { ok: false, reason: "the appointment time is not in a recognized format (e.g. 10:00 AM)" };

  const at = (h: number, m: number) => zonedTimeToUtc(date.year, date.month, date.day, h, m, q.timeZone);
  const end = at(appt.hour, appt.minute);

  let start: Date;
  let pickupFromRequest = false;
  if (order.pickupTime) {
    const p = parseTimeValue(order.pickupTime);
    if (!p) return { ok: false, reason: "the pick-up time is not in a recognized format (e.g. 9:15 AM)" };
    start = at(p.hour, p.minute);
    if (start.getTime() >= end.getTime()) {
      return { ok: false, reason: "the pick-up time is not before the appointment time (check AM/PM on the request)" };
    }
    if (end.getTime() - start.getTime() > MAX_TRIP_MINUTES * 60_000) {
      return { ok: false, reason: `the pick-up time is more than ${MAX_TRIP_MINUTES / 60} hours before the appointment (check the times on the request)` };
    }
    pickupFromRequest = true;
  } else {
    start = new Date(end.getTime() - q.durationMinutes * 60_000);
  }

  if (start.getTime() < q.now.getTime()) return { ok: false, reason: "the trip time has already passed" };
  if (start.getTime() - q.now.getTime() > MAX_DAYS_AHEAD * 86_400_000) {
    return { ok: false, reason: `the appointment is more than ${MAX_DAYS_AHEAD} days out (check the date on the request)` };
  }

  const open = hhmm(q.open);
  const close = hhmm(q.close);
  if (start.getTime() < at(open.h, open.m).getTime() || end.getTime() > at(close.h, close.m).getTime()) {
    return {
      ok: false,
      reason: `the trip falls outside service hours (${q.open}-${q.close}) -- check AM/PM on the request, or book it by hand`,
    };
  }
  return { ok: true, start, end, pickupFromRequest };
}

/** True when none of the busy blocks overlaps [start, end). Touching edges are free. */
export function isFree(busy: { start: string; end: string }[], start: Date, end: Date): boolean {
  const s = start.getTime();
  const e = end.getTime();
  return mergeBusy(busy).every((b) => b.end <= s || b.start >= e);
}

export interface FixedTrip {
  mailId: string;
  /** Zone derived from the request's ZIP server-side; null = unzoned. */
  region: string | null;
  start: Date;
  end: Date;
}

export interface TripAssignment extends FixedTrip {
  driver: string;
  calendarId: string;
  /** True when the trip's zone matched the driver's home zone. */
  regionMatch: boolean;
  /** Service-local YYYY-MM-DD of the trip. */
  date: string;
}

/**
 * Chooses a driver for one fixed-time trip. Only drivers free for the whole
 * window are candidates -- free on their calendar AND not already given an
 * overlapping trip earlier in this same run. Among those, in order:
 *   1. a driver whose home zone is the trip's zone;
 *   2. a driver already working that zone that day (keeps a side of town
 *      per driver per day, the backlog planner's rule);
 *   3. the driver with the fewest trips that day;
 *   4. roster order -- the roster doubles as a priority list.
 * Null means nobody is free for that window.
 */
export function pickDriverFor(
  trip: FixedTrip,
  drivers: DriverAvailability[],
  booked: TripAssignment[],
  timeZone: string,
): DriverAvailability | null {
  const day = localDate(trip.start.getTime(), timeZone);
  const zone = trip.region?.trim().toLowerCase() ?? null;
  const sameDay = (d: DriverAvailability) => booked.filter((b) => b.driver === d.driver && b.date === day);

  const free = drivers.filter((d) => {
    if (!isFree(d.busy, trip.start, trip.end)) return false;
    return sameDay(d).every((b) => b.end.getTime() <= trip.start.getTime() || b.start.getTime() >= trip.end.getTime());
  });
  if (free.length === 0) return null;

  const score = (d: DriverAvailability) => {
    const home = zone !== null && d.region?.trim().toLowerCase() === zone ? 0 : 1;
    const working = zone !== null && sameDay(d).some((b) => b.region?.trim().toLowerCase() === zone) ? 0 : 1;
    return [home, working, sameDay(d).length];
  };
  // Array.prototype.sort is stable, so equal scores keep roster order.
  return [...free].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i]! - sb[i]!;
    return 0;
  })[0]!;
}

/**
 * Availability windows to ask the calendar about for a set of trips: one
 * range per service-local day, from that day's first pick-up to its last
 * appointment. Keeps each freebusy query a single day wide, however far
 * apart the appointments are.
 */
export function freeBusyRanges(trips: FixedTrip[], timeZone: string): { from: Date; to: Date }[] {
  const byDay = new Map<string, { from: Date; to: Date }>();
  for (const t of trips) {
    const day = localDate(t.start.getTime(), timeZone);
    const r = byDay.get(day);
    if (!r) byDay.set(day, { from: t.start, to: t.end });
    else {
      if (t.start < r.from) r.from = t.start;
      if (t.end > r.to) r.to = t.end;
    }
  }
  return [...byDay.values()];
}

export interface FixedPlan {
  assignments: TripAssignment[];
  unassigned: { mailId: string; region: string | null; reason: string }[];
  boards: { date: string; board: { driver: string; regions: string[]; count: number }[] }[];
}

/**
 * The backlog run under appointment-time booking: trips in time order, each
 * given to the best free driver, nothing moved off its stated time. Whatever
 * cannot be placed comes back for a human call.
 */
export function assignFixedTrips(trips: FixedTrip[], drivers: DriverAvailability[], timeZone: string): FixedPlan {
  const assignments: TripAssignment[] = [];
  const unassigned: FixedPlan["unassigned"] = [];
  const ordered = [...trips].sort((a, b) => a.start.getTime() - b.start.getTime());

  for (const trip of ordered) {
    const d = pickDriverFor(trip, drivers, assignments, timeZone);
    if (!d) {
      unassigned.push({ mailId: trip.mailId, region: trip.region, reason: "no driver is free for the requested trip time" });
      continue;
    }
    const zone = trip.region?.trim().toLowerCase() ?? null;
    assignments.push({
      ...trip,
      driver: d.driver,
      calendarId: d.calendarId,
      regionMatch: zone !== null && d.region?.trim().toLowerCase() === zone,
      date: localDate(trip.start.getTime(), timeZone),
    });
  }

  const dates = [...new Set(assignments.map((a) => a.date))].sort();
  const boards = dates.map((date) => {
    const mine = assignments.filter((a) => a.date === date);
    const board = drivers
      .map((d) => {
        const own = mine.filter((a) => a.driver === d.driver);
        return { driver: d.driver, regions: [...new Set(own.map((a) => a.region ?? "unzoned"))], count: own.length };
      })
      .filter((row) => row.count > 0);
    return { date, board };
  });

  return { assignments, unassigned, boards };
}
