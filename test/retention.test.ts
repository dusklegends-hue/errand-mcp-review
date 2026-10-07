import { describe, expect, it } from "vitest";
import { expiredAuditRotations, expiredDateDirs } from "../src/util/retention.js";
import { localDateParts, orderRef, safeName, slipExt, slipRelPath } from "../src/slips/slips.js";

describe("expiredDateDirs", () => {
  const names = ["2026-08-15", "2026-08-20", "2026-09-01", "Bob", "notes.txt"];

  it("deletes only dated dirs outside the window", () => {
    expect(expiredDateDirs(names, 14, "2026-09-01")).toEqual(["2026-08-15"]);
  });

  it("retention of 1 keeps only today", () => {
    expect(expiredDateDirs(names, 1, "2026-09-01")).toEqual(["2026-08-15", "2026-08-20"]);
  });

  it("never touches non-date names", () => {
    expect(expiredDateDirs(["Bob", "handles", "2026-13-99x"], 1, "2026-09-01")).toEqual([]);
  });
});

describe("expiredAuditRotations", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const names = [
    "audit.jsonl", // the live log -- never a candidate
    "audit.jsonl.2019-01-01T00-00-00-000Z",
    "audit.jsonl.2026-01-01T00-00-00-000Z",
    "audit.jsonl.notes",
    "jobs.jsonl.2019-01-01T00-00-00-000Z", // another file's rotation
  ];

  it("deletes only rotated audit files older than the window", () => {
    expect(expiredAuditRotations(names, "audit.jsonl", 2190, now)).toEqual(["audit.jsonl.2019-01-01T00-00-00-000Z"]);
  });

  it("matches the stamp format log.ts writes", () => {
    const stamp = new Date("2020-03-04T05:06:07.089Z").toISOString().replace(/[:.]/g, "-");
    expect(expiredAuditRotations([`audit.jsonl.${stamp}`], "audit.jsonl", 30, now)).toEqual([`audit.jsonl.${stamp}`]);
  });
});

describe("slip paths", () => {
  const meta = {
    driver: "Bob R.",
    startISO: "2026-09-01T21:30:00.000Z", // 3:30 PM Mountain time (MDT)
    timeZone: "America/Denver",
    mailId: "AAMk-TEST-0001",
    contentType: "image/jpeg",
  };

  it("files under local-date/driver with time and a stable ref, no member data anywhere", () => {
    const rel = slipRelPath(meta).replace(/\\/g, "/");
    expect(rel).toBe(`2026-09-01/Bob_R./1530_order-${orderRef(meta.mailId)}.jpg`);
  });

  it("orderRef is stable and short", () => {
    expect(orderRef(meta.mailId)).toBe(orderRef(meta.mailId));
    expect(orderRef(meta.mailId)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("local date rolls with the service timezone, not UTC", () => {
    // 2026-09-02T03:30Z is still Sep 1, 9:30 PM Mountain time.
    const p = localDateParts("2026-09-02T03:30:00.000Z", "America/Denver");
    expect(p).toEqual({ date: "2026-09-01", hhmm: "2130" });
  });

  it("sanitizes driver names for Windows paths", () => {
    expect(safeName("José / Team 2")).toBe("Jos_Team_2");
    expect(safeName("   ")).toBe("unknown");
  });

  it("maps content types to extensions, unknown to .bin", () => {
    expect(slipExt("image/png")).toBe("png");
    expect(slipExt("application/pdf")).toBe("bin");
  });
});
