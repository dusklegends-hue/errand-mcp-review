import { describe, expect, it } from "vitest";
import { hourSlotsByDay, planAhead, planDay, type DayCapacity, type DriverDay } from "../src/calendar/plan.js";

const hour = 3_600_000;
const t0 = Date.parse("2026-09-02T15:00:00Z"); // 9 AM MDT

const slots = (startMs: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ start: new Date(startMs + i * hour), end: new Date(startMs + (i + 1) * hour) }));

const driver = (name: string, homeRegion: string | undefined, n: number, startMs = t0): DriverDay => ({
  driver: name,
  calendarId: `cal-${name}`,
  homeRegion,
  slots: slots(startMs, n),
});

const order = (id: string, region: string | null) => ({ mailId: id, region });

describe("planDay", () => {
  it("gives each driver a side of town from where the orders cluster", () => {
    const days = [driver("A", "east", 4), driver("B", "central", 4)];
    const plan = planDay(
      [order("e1", "east"), order("e2", "east"), order("e3", "east"), order("c1", "central"), order("c2", "central")],
      days,
    );
    expect(plan.unassigned).toEqual([]);
    expect(plan.byDriver).toEqual([
      { driver: "A", regions: ["east"], count: 3 },
      { driver: "B", regions: ["central"], count: 2 },
    ]);
    expect(plan.assignments.every((a) => a.regionMatch)).toBe(true);
  });

  it("packs a driver's orders back-to-back in hour slots", () => {
    const days = [driver("A", "east", 4)];
    const plan = planDay([order("e1", "east"), order("e2", "east")], days);
    expect(plan.assignments[0].start.getTime()).toBe(t0);
    expect(plan.assignments[0].end.getTime()).toBe(t0 + hour);
    expect(plan.assignments[1].start.getTime()).toBe(t0 + hour);
  });

  it("spills a heavy zone across drivers when one day is not enough", () => {
    const days = [driver("A", "east", 2), driver("B", "central", 4)];
    const plan = planDay(
      [order("e1", "east"), order("e2", "east"), order("e3", "east"), order("e4", "east")],
      days,
    );
    const byDriver = Object.fromEntries(plan.byDriver.map((r) => [r.driver, r.count]));
    expect(byDriver).toEqual({ A: 2, B: 2 });
    expect(plan.assignments.filter((a) => a.driver === "B").every((a) => a.regionMatch)).toBe(false);
  });

  it("handles a light day by giving one driver several zones", () => {
    const days = [driver("A", "east", 8)];
    const plan = planDay([order("e1", "east"), order("c1", "central"), order("w1", "west")], days);
    expect(plan.byDriver).toEqual([{ driver: "A", regions: ["east", "central", "west"], count: 3 }]);
  });

  it("flags unzoned orders and routes them to the freest driver", () => {
    const days = [driver("A", "east", 1), driver("B", "central", 3)];
    const plan = planDay([order("e1", "east"), order("u1", null)], days);
    const u = plan.assignments.find((a) => a.mailId === "u1")!;
    expect(u.driver).toBe("B");
    expect(u.region).toBeNull();
    expect(u.regionMatch).toBe(false);
  });
});

describe("planAhead (the backlog run)", () => {
  const day = (date: string, drivers: DriverDay[]): DayCapacity => ({ date, drivers });

  it("fills the earliest day first and rolls overflow forward", () => {
    const plan = planAhead(
      [order("e1", "east"), order("e2", "east"), order("e3", "east")],
      [
        day("2026-09-02", [driver("A", "east", 2)]),
        day("2026-09-03", [driver("A", "east", 2, t0 + 24 * hour)]),
      ],
    );
    expect(plan.unassigned).toEqual([]);
    expect(plan.assignments.map((a) => a.date)).toEqual(["2026-09-02", "2026-09-02", "2026-09-03"]);
    expect(plan.boards).toEqual([
      { date: "2026-09-02", board: [{ driver: "A", regions: ["east"], count: 2 }] },
      { date: "2026-09-03", board: [{ driver: "A", regions: ["east"], count: 1 }] },
    ]);
  });

  it("reports what the whole horizon cannot hold, never drops it", () => {
    const plan = planAhead(
      [order("e1", "east"), order("e2", "east"), order("e3", "east")],
      [day("2026-09-02", [driver("A", "east", 1)]), day("2026-09-03", [driver("A", "east", 1, t0 + 24 * hour)])],
    );
    expect(plan.assignments).toHaveLength(2);
    expect(plan.unassigned).toEqual([
      { mailId: "e3", region: "east", reason: "no driver capacity within the planning horizon" },
    ]);
  });

  it("re-zones each day from that day's remaining orders", () => {
    // Day 1 only fits east; day 2's board is central -- zones follow the orders.
    const plan = planAhead(
      [order("e1", "east"), order("e2", "east"), order("c1", "central"), order("c2", "central")],
      [
        day("2026-09-02", [driver("A", "east", 2)]),
        day("2026-09-03", [driver("A", "east", 4, t0 + 24 * hour)]),
      ],
    );
    expect(plan.boards[0].board).toEqual([{ driver: "A", regions: ["east"], count: 2 }]);
    expect(plan.boards[1].board).toEqual([{ driver: "A", regions: ["central"], count: 2 }]);
  });
});

describe("hourSlotsByDay", () => {
  const q = {
    now: new Date("2026-09-02T21:00:00Z"), // 3 PM MDT on Sep 2
    durationMinutes: 60,
    horizonDays: 3,
    open: "09:00",
    close: "13:00",
    timeZone: "America/Denver",
  };

  it("future days get the full service window, unclipped by the current time", () => {
    const days = hourSlotsByDay([{ driver: "A", calendarId: "c", busy: [] }], q, 1, 2);
    // Planned at 3 PM: today (already past close) excluded, tomorrow + day after full.
    expect(days.map((d) => d.date)).toEqual(["2026-09-03", "2026-09-04"]);
    expect(days[0].drivers[0].slots).toHaveLength(4); // 9-1 = four hour slots
    expect(days[0].drivers[0].slots[0].start.toISOString()).toBe("2026-09-03T15:00:00.000Z");
  });

  it("skips busy time inside a future day", () => {
    const days = hourSlotsByDay(
      [{ driver: "A", calendarId: "c", busy: [{ start: "2026-09-03T16:00:00Z", end: "2026-09-03T17:00:00Z" }] }],
      q,
      1,
      1,
    );
    expect(days[0].drivers[0].slots.map((s) => s.start.toISOString())).toEqual([
      "2026-09-03T15:00:00.000Z",
      "2026-09-03T17:00:00.000Z",
      "2026-09-03T18:00:00.000Z",
    ]);
  });
});
