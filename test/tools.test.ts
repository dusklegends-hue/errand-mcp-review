/**
 * Tool-layer tests (2026-10-07, after the customer IT review): the real
 * handlers, the real gate, ledger and audit log, with only Microsoft Graph
 * and Google Calendar mocked. These pin what the operator actually receives.
 *
 * config.ts reads the environment at import, so the environment is set up
 * at the top of this file and the tool modules are imported dynamically.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = mkdtempSync(path.join(tmpdir(), "errand-tools-"));
mkdirSync(path.join(tmp, "instances"));
const roster = [
  { driver: "Ana", calendarId: "ana@cal", region: "central" },
  { driver: "Ben", calendarId: "ben@cal", region: "east" },
];
writeFileSync(
  path.join(tmp, "instances", "t.json"),
  JSON.stringify({
    name: "t",
    modes: ["test", "live"],
    mail: { clientIdEnv: "T_MS", tokenFile: "./ms.json" },
    google: { clientIdEnv: "T_GID", clientSecretEnv: "T_GSEC", tokenFile: "./g.json" },
    serviceHours: { timeZone: "America/Denver", open: "07:00", close: "18:00" },
    delivery: { durationMinutes: 60, horizonDays: 3 },
    regions: { east: ["00015"], central: ["00002"] },
    test: { scheduleCalendarId: "sandbox@cal", roster },
    live: { roster },
  }),
);
Object.assign(process.env, {
  ERRAND_MCP_ENV_FILE: path.join(tmp, "no-such.env"),
  ERRAND_MCP_INSTANCE_DIR: path.join(tmp, "instances"),
  ERRAND_MCP_AUDIT_LOG_PATH: path.join(tmp, "audit.jsonl"),
  ERRAND_MCP_LEDGER_PATH: path.join(tmp, "jobs.jsonl"),
  ERRAND_MCP_SLIP_DIR: path.join(tmp, "slips"),
  ERRAND_MCP_HANDLE_DIR: path.join(tmp, "handles"),
  T_MS: "x",
  T_GID: "x",
  T_GSEC: "x",
});

vi.mock("../src/mail/graph.js", () => ({
  listInbox: vi.fn(),
  getMessageBody: vi.fn(),
  getAttachment: vi.fn(),
}));
vi.mock("../src/calendar/google.js", () => ({
  freeBusy: vi.fn(),
  insertEvent: vi.fn(),
  deleteEvent: vi.fn(),
}));

// The client's form, with every field the brief says must never reach the operator.
const REQUEST = [
  "Member's Name: Rita Reyes",
  "Member ID: MEM-0001",
  "Member's Phone Number: 555-555-0142",
  "Date of the Appointment: 10/14/2026",
  "Time of the Appointment: 10:00 AM",
  "Pick-Up: 100 Example St, Springfield 00002",
  "Pick-up Time: 9:15 AM",
  "Destination: 410 Maple Ave, Springfield 00015",
].join("\n");
const LEAKS = ["Rita", "MEM-0001", "555-0142", "Example St", "Maple Ave", "9:15", "10:00", "calendar.google.com"];

type Mocked = ReturnType<typeof vi.fn>;
let calendar: typeof import("../src/tools/calendar.js");
let email: typeof import("../src/tools/email.js");
let graph: Record<string, Mocked>;
let google: Record<string, Mocked>;
let UpstreamError: typeof import("../src/util/http.js").UpstreamError;

const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");
const json = (r: { content: { type: string; text?: string }[] }) => JSON.parse(text(r));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T18:00:00Z"));
  calendar = await import("../src/tools/calendar.js");
  email = await import("../src/tools/email.js");
  graph = (await import("../src/mail/graph.js")) as unknown as Record<string, Mocked>;
  google = (await import("../src/calendar/google.js")) as unknown as Record<string, Mocked>;
  UpstreamError = (await import("../src/util/http.js")).UpstreamError;
});

afterAll(() => vi.useRealTimers());

beforeEach(() => {
  vi.clearAllMocks();
  graph.getMessageBody.mockResolvedValue({ bodyText: REQUEST });
  graph.getAttachment.mockRejectedValue(new Error("no image attachment"));
  graph.listInbox.mockResolvedValue([
    { id: "inbox-1", from: "Requests@Example-Plan.org", received: "2026-10-07T15:00:00Z", hasAttachments: true, bodyText: REQUEST },
  ]);
  google.freeBusy.mockImplementation(async (_i: unknown, ids: string[]) => new Map(ids.map((id) => [id, []])));
  google.insertEvent.mockResolvedValue({ id: "evt-1", htmlLink: "https://calendar.google.com/event?eid=abc" });
  google.deleteEvent.mockResolvedValue(undefined);
});

describe("schedule -- the booking confirmation (IT question 1)", () => {
  it("returns exactly status, booking ref, event id, driver, and zone match -- no member data", async () => {
    const r = await calendar.handleCalendar({ instance: "t", mode: "test", action: "schedule", mail_id: "m-shape" });
    expect(Object.keys(json(r)).sort()).toEqual(["booking_ref", "driver", "event_id", "region_match", "status"]);
    expect(json(r)).toMatchObject({ status: "ok", event_id: "evt-1", driver: "Ben", region_match: true });
    for (const leak of LEAKS) expect(text(r)).not.toContain(leak);
  });

  it("books the request's own pick-up-to-appointment window", async () => {
    await calendar.handleCalendar({ instance: "t", mode: "test", action: "schedule", mail_id: "m-window" });
    const event = google.insertEvent.mock.calls[0]![2] as { startISO: string; endISO: string };
    expect([event.startISO, event.endISO]).toEqual(["2026-10-14T15:15:00.000Z", "2026-10-14T16:00:00.000Z"]);
  });

  it("writes test-mode bookings only to the sandbox calendar", async () => {
    await calendar.handleCalendar({ instance: "t", mode: "test", action: "schedule", mail_id: "m-sandbox" });
    expect(google.insertEvent.mock.calls[0]![1]).toBe("sandbox@cal");
  });

  it("writes live bookings to the assigned driver's own calendar, after confirmation", async () => {
    const args = { instance: "t", mode: "live" as const, action: "schedule" as const, mail_id: "m-live" };
    const first = json(await calendar.handleCalendar(args));
    expect(first.status).toBe("confirmation_required");
    expect(google.insertEvent).not.toHaveBeenCalled();
    await calendar.handleCalendar({ ...args, confirm_token: first.confirm_token });
    expect(google.insertEvent.mock.calls[0]![1]).toBe("ben@cal");
  });

  it("does not book, and writes nothing, when no driver is free for the exact window", async () => {
    google.freeBusy.mockImplementation(
      async (_i: unknown, ids: string[]) => new Map(ids.map((id) => [id, [{ start: "2026-10-14T15:00:00Z", end: "2026-10-14T15:30:00Z" }]])),
    );
    const r = await calendar.handleCalendar({ instance: "t", mode: "test", action: "schedule", mail_id: "m-busy" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not booked");
    expect(google.insertEvent).not.toHaveBeenCalled();
  });
});

describe("cancel", () => {
  it("treats an event already deleted by hand as cancelled, so the request can be re-booked", async () => {
    await calendar.handleCalendar({ instance: "t", mode: "test", action: "schedule", mail_id: "m-gone" });
    google.deleteEvent.mockRejectedValue(new UpstreamError("Google Calendar", 410, "deleted", "HTTP 410 deleted", false));
    const r = json(await calendar.handleCalendar({ instance: "t", mode: "test", action: "cancel", mail_id: "m-gone" }));
    expect(r).toMatchObject({ status: "ok", event_already_gone: true });
    const again = json(await calendar.handleCalendar({ instance: "t", mode: "test", action: "schedule", mail_id: "m-gone" }));
    expect(again.status).toBe("ok");
  });
});

describe("backlog booking (plan_preview / plan_ahead)", () => {
  it("previews without booking and hands back the list to book", async () => {
    const r = json(await calendar.handleCalendar({ instance: "t", mode: "live", action: "plan_preview" }));
    expect(r.mail_ids).toEqual(["inbox-1"]);
    expect(r.proposed[0]).toMatchObject({ mail_id: "inbox-1", driver: "Ben" });
    expect(google.insertEvent).not.toHaveBeenCalled();
    for (const leak of LEAKS) expect(JSON.stringify(r)).not.toContain(leak);
  });

  it("refuses a live plan_ahead that does not name its list", async () => {
    const r = await calendar.handleCalendar({ instance: "t", mode: "live", action: "plan_ahead" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("plan_preview");
  });

  it("binds the live confirmation to the named list", async () => {
    const first = json(await calendar.handleCalendar({ instance: "t", mode: "live", action: "plan_ahead", mail_ids: ["inbox-1"] }));
    expect(first.status).toBe("confirmation_required");
    const swapped = json(
      await calendar.handleCalendar({ instance: "t", mode: "live", action: "plan_ahead", mail_ids: ["other"], confirm_token: first.confirm_token }),
    );
    expect(swapped.status).toBe("confirmation_required");
    expect(google.insertEvent).not.toHaveBeenCalled();
  });
});

describe("errand_email", () => {
  it("lists server-derived fields only", async () => {
    const r = json(await email.handleEmail({ instance: "t", mode: "test", action: "list" }));
    expect(Object.keys(r.preview[0]).sort()).toEqual(
      ["from_domain", "has_attachments", "job_state", "mail_id", "received", "ref", "request"].sort(),
    );
    for (const leak of LEAKS) expect(JSON.stringify(r)).not.toContain(leak);
  });

  it("refuses image view unless the instance enables it, without fetching the image", async () => {
    const r = await email.handleEmail({ instance: "t", mode: "test", action: "get_attachment", mail_id: "inbox-1" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("disabled");
    expect(graph.getAttachment).not.toHaveBeenCalled();
  });
});

describe("audit log", () => {
  it("holds no request data after all of the above, including a member-name search", async () => {
    await email.handleEmail({ instance: "t", mode: "test", action: "list", query: "Rita Reyes" });
    const log = readFileSync(path.join(tmp, "audit.jsonl"), "utf8");
    expect(log.length).toBeGreaterThan(0);
    for (const leak of LEAKS) expect(log).not.toContain(leak);
  });
});
