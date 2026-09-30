import { describe, expect, it } from "vitest";
import { findSoonestSlot, serviceWindows, type DriverAvailability, type SlotQuery } from "../src/calendar/slots.js";

// All fixtures use America/Denver (MDT, UTC-6, on 2026-08-22). 15:00Z = 9am local.
const TZ = "America/Denver";

function q(overrides: Partial<SlotQuery> = {}): SlotQuery {
  return {
    now: new Date("2026-08-22T15:00:00Z"), // exactly 9:00 AM local Saturday
    durationMinutes: 60,
    horizonDays: 2,
    open: "09:00",
    close: "18:00",
    timeZone: TZ,
    ...overrides,
  };
}

function driver(name: string, busy: { start: string; end: string }[]): DriverAvailability {
  return { driver: name, calendarId: `${name}@cal`, whatsapp: "15550000000", busy };
}

describe("serviceWindows", () => {
  it("clips today's window to now and keeps full future days", () => {
    const windows = serviceWindows(q({ now: new Date("2026-08-22T17:30:00Z") })); // 11:30 local
    expect(windows[0]!.start).toBe(Date.parse("2026-08-22T17:30:00Z"));
    expect(windows[0]!.end).toBe(Date.parse("2026-08-23T00:00:00Z")); // 6pm local
    expect(new Date(windows[1]!.start).toISOString()).toBe("2026-08-23T15:00:00.000Z"); // 9am next day
  });

  it("drops a day whose remaining window is shorter than the duration", () => {
    // 17:30 local -- 30 minutes left today, need 60.
    const windows = serviceWindows(q({ now: new Date("2026-08-22T23:30:00Z") }));
    expect(new Date(windows[0]!.start).toISOString()).toBe("2026-08-23T15:00:00.000Z");
  });
});

describe("findSoonestSlot", () => {
  it("returns the earliest free slot for an idle roster: right now", () => {
    const slot = findSoonestSlot([driver("A", [])], q());
    expect(slot!.driver).toBe("A");
    expect(slot!.start.toISOString()).toBe("2026-08-22T15:00:00.000Z");
    expect(slot!.end.toISOString()).toBe("2026-08-22T16:00:00.000Z");
  });

  it("skips past a busy block that leaves too little room", () => {
    // Busy 9:00-9:30 local; a 60-min slot fits only from 9:30.
    const slot = findSoonestSlot(
      [driver("A", [{ start: "2026-08-22T15:00:00Z", end: "2026-08-22T15:30:00Z" }])],
      q(),
    );
    expect(slot!.start.toISOString()).toBe("2026-08-22T15:30:00.000Z");
  });

  it("picks the driver who is free soonest, not the first in the roster", () => {
    const slot = findSoonestSlot(
      [
        driver("A", [{ start: "2026-08-22T14:00:00Z", end: "2026-08-22T20:00:00Z" }]), // busy till 2pm local
        driver("B", [{ start: "2026-08-22T14:00:00Z", end: "2026-08-22T16:00:00Z" }]), // busy till 10am local
      ],
      q(),
    );
    expect(slot!.driver).toBe("B");
    expect(slot!.start.toISOString()).toBe("2026-08-22T16:00:00.000Z");
  });

  it("ties go to roster order, making the roster a priority list", () => {
    const slot = findSoonestSlot([driver("A", []), driver("B", [])], q());
    expect(slot!.driver).toBe("A");
  });

  it("rolls to the next day when everyone is busy until close", () => {
    const busyAllDay = [{ start: "2026-08-22T14:00:00Z", end: "2026-08-23T01:00:00Z" }];
    const slot = findSoonestSlot([driver("A", busyAllDay)], q());
    expect(slot!.start.toISOString()).toBe("2026-08-23T15:00:00.000Z"); // 9am Sunday local
  });

  it("returns null, not an error, when nobody is free inside the horizon", () => {
    const busyForever = [{ start: "2026-08-01T00:00:00Z", end: "2026-09-01T00:00:00Z" }];
    expect(findSoonestSlot([driver("A", busyForever)], q())).toBeNull();
  });

  it("merges overlapping busy blocks instead of double-counting the gap between them", () => {
    const slot = findSoonestSlot(
      [
        driver("A", [
          { start: "2026-08-22T15:00:00Z", end: "2026-08-22T16:30:00Z" },
          { start: "2026-08-22T16:00:00Z", end: "2026-08-22T17:00:00Z" },
        ]),
      ],
      q(),
    );
    expect(slot!.start.toISOString()).toBe("2026-08-22T17:00:00.000Z");
  });

  it("handles the DST fall-back day without drifting the open hour", () => {
    // US DST ends 2026-11-01 (clocks back). 9am MST = 16:00Z from then on.
    const slot = findSoonestSlot(
      [driver("A", [])],
      q({ now: new Date("2026-11-01T02:00:00Z"), horizonDays: 1 }),
    );
    // 2026-11-01 02:00Z is still Oct 31 local (8pm MDT); service hours over, so
    // the slot lands at 9am on Nov 1 -- which after fall-back is 16:00Z.
    expect(slot!.start.toISOString()).toBe("2026-11-01T16:00:00.000Z");
  });
});
