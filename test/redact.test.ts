import { describe, expect, it } from "vitest";
import { redactParams } from "../src/audit/redact.js";

describe("audit redaction", () => {
  it("redacts credentials fully", () => {
    expect(redactParams({ confirm_token: "abc", api_secret: "x" })).toEqual({
      confirm_token: "<redacted>",
      api_secret: "<redacted>",
    });
  });

  it("masks the pipeline's PII fields -- the gap the discord-mcp pattern would miss", () => {
    const out = redactParams({
      patient: "Jane Doe",
      deliver_to: "410 Maple Ave",
      driver_whatsapp: "15550000000",
      mail_id: "AAMk...",
    });
    expect(out.patient).toBe("<redacted:pii>");
    expect(out.deliver_to).toBe("<redacted:pii>");
    expect(out.driver_whatsapp).toBe("<redacted:pii>");
    expect(out.mail_id).toBe("AAMk..."); // ids stay -- they are the join key to the ledger
  });

  it("truncates long free text", () => {
    const out = redactParams({ body: "x".repeat(300) });
    expect(String(out.body)).toContain("...(100 more chars)");
  });
});

// Every field the IT brief's "data in scope" list names must redact — one
// case per field so a pattern regression names the exact field it dropped.
import { describe as rd, expect as re, it as ri } from "vitest";
import { redactParams as redact2 } from "../src/audit/redact.js";

rd("brief-listed PII fields all redact", () => {
  const cases: Record<string, string> = {
    member_name: "Jane Doe",
    member_id: "MEM-123",
    member_phone: "555-555-0000",
    pickup_from: "Walgreens on 3rd St",
    deliver_to: "410 Maple Ave",
    destination: "9 Oak St",
    passenger_count: "2",
    special_items: "wheelchair",
    special_instructions: "hearing impaired",
    appointment_time: "2:00 PM",
    mileage: "14",
  };
  for (const [key, value] of Object.entries(cases)) {
    ri(`${key} is redacted`, () => {
      re(redact2({ [key]: value })[key]).toBe("<redacted:pii>");
    });
  }
});
