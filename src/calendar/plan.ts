/**
 * Backlog planner (Josh's spec, 2026-09-01):
 *
 *   Orders accumulate as a BACKLOG and get scheduled in advance -- days
 *   ahead, not live. One planning run lays the backlog out across the
 *   coming days: each day, every working driver gets a "side of town"
 *   computed from where that day's orders cluster, an hour per order,
 *   packed back-to-back inside service hours. Overflow rolls to the next
 *   day; whatever the horizon can't hold comes back unassigned for a human
 *   call -- nothing is dropped silently.
 *
 * Pure functions over precomputed availability, same discipline as slots.ts:
 * no Date.now(), no I/O, fully testable against fixtures.
 */
import {
  freeIntervals,
  serviceWindows,
  type DriverAvailability,
  type SlotQuery,
} from "./slots.js";

export interface HourSlot {
  start: Date;
  end: Date;
}

export interface DriverDay {
  driver: string;
  calendarId: string;
  /** The driver's usual zone -- a PREFERENCE for assignment, not a wall. */
  homeRegion?: string;
  /** Free duration-length slots for the day, earliest first. */
  slots: HourSlot[];
}

export interface DayCapacity {
  /** Service-local YYYY-MM-DD. */
  date: string;
  drivers: DriverDay[];
}

export function localDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/**
 * Free hour-slots per driver per day, `fromDay` (0 = today, clipped to now)
 * through `toDay` days ahead. Days where the service window is too small
 * are simply absent.
 */
export function hourSlotsByDay(
  drivers: DriverAvailability[],
  q: SlotQuery,
  fromDay: number,
  toDay: number,
): DayCapacity[] {
  const durationMs = q.durationMinutes * 60_000;
  const fromDate = localDate(q.now.getTime() + fromDay * 86_400_000, q.timeZone);
  const result: DayCapacity[] = [];
  for (const window of serviceWindows({ ...q, horizonDays: toDay })) {
    const date = localDate(window.start, q.timeZone);
    if (date < fromDate) continue; // YYYY-MM-DD compares correctly as a string
    result.push({
      date,
      drivers: drivers.map((d) => {
        const slots: HourSlot[] = [];
        for (const free of freeIntervals(window, d.busy)) {
          let cursor = free.start;
          while (cursor + durationMs <= free.end) {
            slots.push({ start: new Date(cursor), end: new Date(cursor + durationMs) });
            cursor += durationMs;
          }
        }
        return { driver: d.driver, calendarId: d.calendarId, homeRegion: d.region, slots };
      }),
    });
  }
  return result;
}

export interface PlanOrder {
  mailId: string;
  /** Zone derived from the delivery ZIP server-side; null = unzoned. */
  region: string | null;
}

export interface Assignment {
  mailId: string;
  driver: string;
  calendarId: string;
  region: string | null;
  /** True when the order's zone matched the assigned driver's home zone. */
  regionMatch: boolean;
  start: Date;
  end: Date;
}

export interface DayPlan {
  assignments: Assignment[];
  unassigned: { mailId: string; region: string | null; reason: string }[];
  /** The day's board: which side(s) of town each driver owns. */
  byDriver: { driver: string; regions: string[]; count: number }[];
}

/**
 * One day's assignment rule, in order:
 *   - Zones are handled heaviest-first, so the busiest side of town gets the
 *     freest driver.
 *   - A zone goes to a driver whose home region matches when that driver has
 *     room; otherwise to the driver with the most remaining capacity (ties
 *     fall to roster order).
 *   - A zone bigger than one driver's day SPILLS to the next driver; a light
 *     day can hand one driver several zones. That is "a side of town for the
 *     day", derived from the orders.
 *   - Unzoned orders go wherever there is most room, flagged.
 */
export function planDay(orders: PlanOrder[], days: DriverDay[]): DayPlan {
  const cursors = days.map(() => 0); // next unused slot index per driver
  const capacity = (i: number) => days[i].slots.length - cursors[i];
  const assignments: Assignment[] = [];
  const unassigned: DayPlan["unassigned"] = [];

  const take = (i: number, order: PlanOrder, regionMatch: boolean) => {
    const slot = days[i].slots[cursors[i]++];
    assignments.push({
      mailId: order.mailId,
      driver: days[i].driver,
      calendarId: days[i].calendarId,
      region: order.region,
      regionMatch,
      start: slot.start,
      end: slot.end,
    });
  };

  const pickDriver = (region: string | null): number | null => {
    if (region) {
      const home = days.findIndex((d, i) => d.homeRegion?.toLowerCase() === region.toLowerCase() && capacity(i) > 0);
      if (home !== -1) return home;
    }
    let best: number | null = null;
    for (let i = 0; i < days.length; i++) {
      if (capacity(i) > 0 && (best === null || capacity(i) > capacity(best))) best = i;
    }
    return best;
  };

  // Group by zone, heaviest zone first; unzoned last.
  const groups = new Map<string | null, PlanOrder[]>();
  for (const o of orders) {
    const key = o.region ? o.region.toLowerCase() : null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(o);
  }
  const zones = [...groups.entries()]
    .filter(([k]) => k !== null)
    .sort((a, b) => b[1].length - a[1].length);
  if (groups.has(null)) zones.push([null, groups.get(null)!]);

  for (const [zone, zoneOrders] of zones) {
    for (const order of zoneOrders) {
      const i = pickDriver(zone);
      if (i === null) {
        unassigned.push({ mailId: order.mailId, region: order.region, reason: "no driver capacity left today" });
        continue;
      }
      take(i, order, zone !== null && days[i].homeRegion?.toLowerCase() === zone);
    }
  }

  const byDriver = days
    .map((d) => {
      const mine = assignments.filter((a) => a.driver === d.driver);
      const regions = [...new Set(mine.map((a) => a.region ?? "unzoned"))];
      return { driver: d.driver, regions, count: mine.length };
    })
    .filter((row) => row.count > 0);

  return { assignments, unassigned, byDriver };
}

export interface AheadPlan {
  assignments: (Assignment & { date: string })[];
  /** Backlog the whole horizon could not hold. */
  unassigned: { mailId: string; region: string | null; reason: string }[];
  boards: { date: string; board: DayPlan["byDriver"] }[];
}

/**
 * The backlog run: fill the earliest day first, roll what doesn't fit to the
 * next, stop when the backlog is placed or the horizon ends.
 */
export function planAhead(orders: PlanOrder[], daysAhead: DayCapacity[]): AheadPlan {
  let remaining = orders;
  const assignments: AheadPlan["assignments"] = [];
  const boards: AheadPlan["boards"] = [];

  for (const day of daysAhead) {
    if (remaining.length === 0) break;
    const plan = planDay(remaining, day.drivers);
    for (const a of plan.assignments) assignments.push({ ...a, date: day.date });
    if (plan.byDriver.length > 0) boards.push({ date: day.date, board: plan.byDriver });
    remaining = plan.unassigned.map((u) => ({ mailId: u.mailId, region: u.region }));
  }

  return {
    assignments,
    unassigned: remaining.map((o) => ({ mailId: o.mailId, region: o.region, reason: "no driver capacity within the planning horizon" })),
    boards,
  };
}
