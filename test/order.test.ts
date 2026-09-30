import { describe, expect, it } from "vitest";
import { maskOrderPii, parseOrder, regionForAddress, stripHtml } from "../src/mail/order.js";

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

describe("maskOrderPii", () => {
  it("masks labeled values and keeps unlabeled lines", () => {
    const masked = maskOrderPii(BODY);
    expect(masked).not.toContain("Jane Doe");
    expect(masked).not.toContain("Maple Ave");
    expect(masked).toContain("New delivery order #4821");
    expect(masked).toContain("Notes: leave at door");
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
