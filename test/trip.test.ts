import { describe, expect, it } from "vitest";
import { assignFixedTrips, freeBusyRanges, isFree, pickDriverFor, tripWindow, type TripQuery } from "../src/calendar/trip.js";
import type { ParsedOrder } from "../src/mail/order.js";

// Mountain time is America/Denver: MDT (UTC-6) until 2026-11-01, MST (UTC-7) after.
const Q: TripQuery = {
  now: new Date("2026-10-07T18:00:00Z"),
  durationMinutes: 60,
  open: "07:00",
  close: "18:00",
  timeZone: "America/Denver",
};

const order = (over: Partial<ParsedOrder> = {}): ParsedOrder => ({
  member: "Rita Reyes",
  pickupFrom: "100 Example St 00002",
  deliverTo: "410 Maple Ave 00015",
  appointmentDate: "10/14/2026",
  appointmentTime: "10:00 AM",
  pickupTime: "9:15 AM",
  ...over,
});

describe("tripWindow", () => {
  it("runs from the request's pick-up time to its appointment time", () => {
    const w = tripWindow(order(), Q);
    expect(w).toEqual({
      ok: true,
      start: new Date("2026-10-14T15:15:00Z"),
      end: new Date("2026-10-14T16:00:00Z"),
      pickupFromRequest: true,
    });
  });

  it("starts durationMinutes before the appointment when no pick-up time is given", () => {
    const w = tripWindow(order({ pickupTime: undefined }), Q);
    expect(w.ok && w.start.toISOString()).toBe("2026-10-14T15:00:00.000Z");
    expect(w.ok && w.pickupFromRequest).toBe(false);
  });

  it("reads wall-clock time across the DST change", () => {
    const w = tripWindow(order({ appointmentDate: "11/04/2026", pickupTime: undefined }), Q);
    expect(w.ok && w.end.toISOString()).toBe("2026-11-04T17:00:00.000Z"); // 10:00 MST
  });

  it("refuses a trip whose time has passed", () => {
    expect(tripWindow(order({ appointmentDate: "10/01/2026" }), Q)).toEqual({
      ok: false,
      reason: "the trip time has already passed",
    });
  });

  it("refuses a pick-up at or after the appointment (an AM/PM slip)", () => {
    const w = tripWindow(order({ pickupTime: "10:30 AM" }), Q);
    expect(w.ok).toBe(false);
    expect(!w.ok && w.reason).toContain("not before the appointment");
  });

  it("refuses a trip outside service hours instead of moving it", () => {
    // A 6:30 AM appointment means a 5:30 pick-up; service opens at 7:00.
    const w = tripWindow(order({ appointmentTime: "6:30 AM", pickupTime: undefined }), Q);
    expect(w.ok).toBe(false);
    expect(!w.ok && w.reason).toContain("outside service hours");
  });

  it("refuses a time with no AM/PM rather than guessing", () => {
    const w = tripWindow(order({ appointmentTime: "2:00", pickupTime: undefined }), Q);
    expect(!w.ok && w.reason).toContain("not in a recognized format");
  });

  it("refuses a pick-up more than four hours before the appointment", () => {
    const w = tripWindow(order({ appointmentTime: "4:00 PM", pickupTime: "8:00 AM" }), Q);
    expect(!w.ok && w.reason).toContain("more than 4 hours");
  });

  it("refuses dates far enough out to be a typo", () => {
    const w = tripWindow(order({ appointmentDate: "10/14/2062" }), Q);
    expect(!w.ok && w.reason).toContain("more than 90 days out");
  });

  it("refuses a request with no appointment", () => {
    const w = tripWindow(order({ appointmentDate: undefined }), Q);
    expect(!w.ok && w.reason).toBe("the request has no appointment date and time");
  });

  it("never echoes a request value in a refusal reason (reasons reach the operator and the audit log)", () => {
    const cases: Partial<ParsedOrder>[] = [
      { appointmentDate: "Sept 14th 2026" },
      { appointmentTime: "ten-ish" },
      { pickupTime: "after lunch" },
    ];
    for (const c of cases) {
      const w = tripWindow(order(c), Q);
      expect(w.ok).toBe(false);
      for (const v of Object.values(c)) expect(!w.ok && w.reason).not.toContain(v);
    }
  });
});

describe("isFree", () => {
  const s = new Date("2026-10-14T15:15:00Z");
  const e = new Date("2026-10-14T16:00:00Z");

  it("is false when any busy block overlaps the window", () => {
    expect(isFree([{ start: "2026-10-14T15:30:00Z", end: "2026-10-14T16:30:00Z" }], s, e)).toBe(false);
    expect(isFree([{ start: "2026-10-14T14:00:00Z", end: "2026-10-14T17:00:00Z" }], s, e)).toBe(false);
  });

  it("treats back-to-back blocks as free", () => {
    expect(isFree([{ start: "2026-10-14T16:00:00Z", end: "2026-10-14T17:00:00Z" }], s, e)).toBe(true);
    expect(isFree([{ start: "2026-10-14T14:15:00Z", end: "2026-10-14T15:15:00Z" }], s, e)).toBe(true);
  });
});

const driver = (name: string, region: string, busy: { start: string; end: string }[] = []) => ({
  driver: name,
  calendarId: `${name.toLowerCase()}@cal`,
  region,
  busy,
});
const trip = (id: string, region: string | null, start: string, end: string) => ({
  mailId: id,
  region,
  start: new Date(start),
  end: new Date(end),
});
const TZ = "America/Denver";

describe("pickDriverFor", () => {
  const t = trip("m1", "east", "2026-10-14T15:15:00Z", "2026-10-14T16:00:00Z");

  it("prefers a free driver whose home zone matches", () => {
    const pick = pickDriverFor(t, [driver("Ana", "central"), driver("Ben", "east")], [], TZ);
    expect(pick?.driver).toBe("Ben");
  });

  it("falls back to any free driver when the in-zone driver is busy", () => {
    const busyBen = driver("Ben", "east", [{ start: "2026-10-14T15:00:00Z", end: "2026-10-14T16:00:00Z" }]);
    expect(pickDriverFor(t, [driver("Ana", "central"), busyBen], [], TZ)?.driver).toBe("Ana");
  });

  it("returns null when nobody is free for the exact window", () => {
    const busy = [{ start: "2026-10-14T15:00:00Z", end: "2026-10-14T15:30:00Z" }];
    expect(pickDriverFor(t, [driver("Ana", "central", busy), driver("Ben", "east", busy)], [], TZ)).toBeNull();
  });

  it("ties go to roster order", () => {
    expect(pickDriverFor(t, [driver("Ana", "west"), driver("Cy", "west")], [], TZ)?.driver).toBe("Ana");
  });
});

describe("assignFixedTrips", () => {
  it("keeps a driver on the side of town they are already working that day", () => {
    const plan = assignFixedTrips(
      [
        trip("m1", "east", "2026-10-14T15:00:00Z", "2026-10-14T16:00:00Z"),
        trip("m2", "east", "2026-10-14T17:00:00Z", "2026-10-14T18:00:00Z"),
      ],
      [driver("Ana", "central"), driver("Ben", "central")],
      TZ,
    );
    // Neither is home-east; m1 goes to Ana by roster order, and m2 follows
    // her to the east side rather than splitting the zone across drivers.
    expect(plan.assignments.map((a) => a.driver)).toEqual(["Ana", "Ana"]);
  });

  it("never double-books a driver within one run, and reports what it could not place", () => {
    const plan = assignFixedTrips(
      [
        trip("late", "central", "2026-10-14T15:30:00Z", "2026-10-14T16:30:00Z"),
        trip("early", "central", "2026-10-14T15:00:00Z", "2026-10-14T16:00:00Z"),
      ],
      [driver("Ana", "central")],
      TZ,
    );
    expect(plan.assignments.map((a) => a.mailId)).toEqual(["early"]); // time order, not mailbox order
    expect(plan.unassigned).toEqual([
      { mailId: "late", region: "central", reason: "no driver is free for the requested trip time" },
    ]);
  });

  it("builds a per-date board of drivers, zones, and counts", () => {
    const plan = assignFixedTrips(
      [
        trip("m1", "east", "2026-10-14T15:00:00Z", "2026-10-14T16:00:00Z"),
        trip("m2", "west", "2026-10-15T15:00:00Z", "2026-10-15T16:00:00Z"),
      ],
      [driver("Ana", "east"), driver("Ben", "west")],
      TZ,
    );
    expect(plan.boards).toEqual([
      { date: "2026-10-14", board: [{ driver: "Ana", regions: ["east"], count: 1 }] },
      { date: "2026-10-15", board: [{ driver: "Ben", regions: ["west"], count: 1 }] },
    ]);
    expect(plan.assignments.every((a) => a.regionMatch)).toBe(true);
  });
});

describe("freeBusyRanges", () => {
  it("asks about one span per service day", () => {
    const ranges = freeBusyRanges(
      [
        trip("a", null, "2026-10-14T15:00:00Z", "2026-10-14T16:00:00Z"),
        trip("b", null, "2026-10-14T20:00:00Z", "2026-10-14T21:00:00Z"),
        trip("c", null, "2026-10-20T15:00:00Z", "2026-10-20T16:00:00Z"),
      ],
      TZ,
    );
    expect(ranges.map((r) => [r.from.toISOString(), r.to.toISOString()])).toEqual([
      ["2026-10-14T15:00:00.000Z", "2026-10-14T21:00:00.000Z"],
      ["2026-10-20T15:00:00.000Z", "2026-10-20T16:00:00.000Z"],
    ]);
  });
});
