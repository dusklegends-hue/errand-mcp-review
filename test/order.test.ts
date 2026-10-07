import { describe, expect, it } from "vitest";
import { parseDateValue, parseOrder, parseTimeValue, regionForAddress, stripHtml } from "../src/mail/order.js";

const BODY = [
  "New delivery order #4821",
  "Patient: Jane Doe",
  "Pickup from: Walgreens on 3rd St",
  "Deliver to: 410 Maple Ave, Springfield 00025",
  "Notes: leave at door",
].join("\n");

describe("parseOrder", () => {
  it("extracts the three labeled fields", () => {
    const r = parseOrder(BODY);
    expect(r.missing).toEqual([]);
    expect(r.order).toEqual({
      member: "Jane Doe",
      pickupFrom: "Walgreens on 3rd St",
      deliverTo: "410 Maple Ave, Springfield 00025",
    });
  });

  it("accepts label synonyms and mixed case", () => {
    const r = parseOrder("NAME - Bob Roe\ncollect from: CVS\nDelivery Address: 1 Elm St 00036");
    expect(r.order).toEqual({ member: "Bob Roe", pickupFrom: "CVS", deliverTo: "1 Elm St 00036" });
  });

  it("names exactly the missing fields", () => {
    const r = parseOrder("Patient: Jane Doe\nsome unrelated text");
    expect(r.order).toBeNull();
    expect(r.missing).toEqual(["pickupFrom", "deliverTo"]);
  });

  it("first labeled line wins over later duplicates", () => {
    const r = parseOrder(`${BODY}\nPatient: Someone Else`);
    expect(r.order?.member).toBe("Jane Doe");
  });

  it("a bare 'address' label is the delivery, and 'pickup address' is the pickup", () => {
    const r = parseOrder("Patient: A\nPickup address: Store\nAddress: 9 Oak St");
    expect(r.order).toEqual({ member: "A", pickupFrom: "Store", deliverTo: "9 Oak St" });
  });
});

describe("appointment fields", () => {
  // The Transportation Request form's labels.
  const FORM = [
    "Member's Name: Rita Reyes",
    "Date of the Appointment: 09/02/2026",
    "Time of the Appointment: 10:00 AM",
    "Pick-Up: 100 Example St, Springfield 00002",
    "Pick-up Time: 9:15 AM",
    "Destination: 410 Maple Ave, Springfield 00015",
  ].join("\n");

  it("reads the form's appointment date, appointment time, and pick-up time", () => {
    const r = parseOrder(FORM, { requireAppointment: true });
    expect(r.order).toEqual({
      member: "Rita Reyes",
      pickupFrom: "100 Example St, Springfield 00002",
      deliverTo: "410 Maple Ave, Springfield 00015",
      appointmentDate: "09/02/2026",
      appointmentTime: "10:00 AM",
      pickupTime: "9:15 AM",
    });
  });

  it("never reads 'Pick-up Time' as the pick-up address", () => {
    const r = parseOrder("Pick-up Time: 9:15 AM\nMember: A\nPick-Up: 1 Sun St\nDestination: 2 Moon St");
    expect(r.order?.pickupFrom).toBe("1 Sun St");
    expect(r.order?.pickupTime).toBe("9:15 AM");
  });

  it("splits a combined 'Appointment:' line into date and time", () => {
    const r = parseOrder("Appointment: 10/09/2026 2:30 PM");
    expect(r.order).toBeNull();
    expect(r.found).toBe(2);
    const full = parseOrder(`Member: A\nPick-Up: X\nDestination: Y\nAppointment: 10/09/2026 at 2:30 PM`, { requireAppointment: true });
    expect(full.order?.appointmentDate).toBe("10/09/2026");
    expect(full.order?.appointmentTime).toBe("2:30 PM");
  });

  it("requires the appointment only when asked to", () => {
    const body = "Member: A\nPick-Up: X\nDestination: Y";
    expect(parseOrder(body).order).not.toBeNull();
    const r = parseOrder(body, { requireAppointment: true });
    expect(r.order).toBeNull();
    expect(r.missing).toEqual(["appointmentDate", "appointmentTime"]);
  });

  it("counts found fields so 'not a request' is distinguishable from 'incomplete'", () => {
    expect(parseOrder("Hello, lunch Friday?").found).toBe(0);
    expect(parseOrder("Member: A").found).toBe(1);
  });
});

describe("parseDateValue", () => {
  it("reads US and ISO dates", () => {
    expect(parseDateValue("09/02/2026")).toEqual({ year: 2026, month: 9, day: 2 });
    expect(parseDateValue("9/2/26")).toEqual({ year: 2026, month: 9, day: 2 });
    expect(parseDateValue("2026-09-02")).toEqual({ year: 2026, month: 9, day: 2 });
    expect(parseDateValue("09-02-2026")).toEqual({ year: 2026, month: 9, day: 2 });
  });

  it("refuses impossible or unrecognized dates instead of guessing", () => {
    expect(parseDateValue("02/30/2026")).toBeNull();
    expect(parseDateValue("13/01/2026")).toBeNull();
    expect(parseDateValue("Sept 2nd")).toBeNull();
    expect(parseDateValue("")).toBeNull();
  });
});

describe("parseTimeValue", () => {
  it("reads 12-hour and 24-hour times", () => {
    expect(parseTimeValue("10:00 AM")).toEqual({ hour: 10, minute: 0 });
    expect(parseTimeValue("9:15am")).toEqual({ hour: 9, minute: 15 });
    expect(parseTimeValue("2 p.m.")).toEqual({ hour: 14, minute: 0 });
    expect(parseTimeValue("12:30 PM")).toEqual({ hour: 12, minute: 30 });
    expect(parseTimeValue("12:05 AM")).toEqual({ hour: 0, minute: 5 });
    expect(parseTimeValue("14:30")).toEqual({ hour: 14, minute: 30 });
  });

  it("refuses ambiguous or malformed times", () => {
    expect(parseTimeValue("10")).toBeNull();
    // No AM/PM and readable either way: refused, never guessed.
    expect(parseTimeValue("2:00")).toBeNull();
    expect(parseTimeValue("6:00")).toBeNull();
    expect(parseTimeValue("12:00")).toBeNull();
    expect(parseTimeValue("00:30")).toEqual({ hour: 0, minute: 30 });
    expect(parseTimeValue("13:00 PM")).toBeNull();
    expect(parseTimeValue("9:75 AM")).toBeNull();
    expect(parseTimeValue("noon")).toBeNull();
  });
});

describe("stripHtml", () => {
  it("keeps the line structure the parser needs", () => {
    const html = "<div>Patient: Jane Doe</div><div>Pickup from: CVS</div><p>Deliver to: 2 Pine St 00012</p>";
    const r = parseOrder(stripHtml(html));
    expect(r.order?.deliverTo).toBe("2 Pine St 00012");
  });

  it("decodes the entities Outlook actually emits", () => {
    expect(stripHtml("Patient: A &amp; B&nbsp;Jr")).toBe("Patient: A & B Jr");
  });
});

describe("regionForAddress", () => {
  const regions = { east: ["00025", "00036"], west: ["00012"] };

  it("maps a ZIP in the address to its zone", () => {
    expect(regionForAddress("410 Maple Ave, Springfield 00025", regions)).toBe("east");
    expect(regionForAddress("2 Pine St 00012", regions)).toBe("west");
  });

  it("returns null for no map, no ZIP, or an unclaimed ZIP", () => {
    expect(regionForAddress("410 Maple Ave", regions)).toBeNull();
    expect(regionForAddress("410 Maple Ave 00099", regions)).toBeNull();
    expect(regionForAddress("410 Maple Ave 00025", undefined)).toBeNull();
  });
});

// Transportation Request form labels (agreed template, 2026-09-02).
import { describe as d2, expect as e2, it as i2 } from "vitest";
import { parseOrder as parse2 } from "../src/mail/order.js";

d2("Transport request form labels", () => {
  i2("parses Member's Name / Pick-Up / Destination", () => {
    const r = parse2(
      "Member's Name: Jane Q. Doe\nPick-Up: 100 Example St, Springfield 00005\nDestination: 410 Maple Ave, Springfield 00028",
    );
    e2(r.order).toEqual({
      member: "Jane Q. Doe",
      pickupFrom: "100 Example St, Springfield 00005",
      deliverTo: "410 Maple Ave, Springfield 00028",
    });
  });

  i2("accepts Pick-Up Location and Drop-off variants", () => {
    const r = parse2("Member: A\nPick-Up Location: 1 Sun St\nDrop-off: 2 Moon St");
    e2(r.order).toEqual({ member: "A", pickupFrom: "1 Sun St", deliverTo: "2 Moon St" });
  });

  i2("still accepts the legacy Patient label", () => {
    const r = parse2("Patient: B\nPickup from: X\nDeliver to: Y");
    e2(r.order?.member).toBe("B");
  });
});
