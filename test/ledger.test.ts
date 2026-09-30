import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";

let dir: string;
function makeLedger(): Ledger {
  dir = mkdtempSync(path.join(tmpdir(), "errand-ledger-"));
  return new Ledger(path.join(dir, "jobs.jsonl"));
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ledger", () => {
  it("returns null for a never-seen mail id", async () => {
    const ledger = makeLedger();
    expect(await ledger.get("josh", "test", "m1")).toBeNull();
  });

  it("replays to the latest state per key", async () => {
    const ledger = makeLedger();
    await ledger.append({ instance: "josh", mode: "test", mailId: "m1", state: "seen" });
    await ledger.append({ instance: "josh", mode: "test", mailId: "m1", state: "scheduled", driver: "Josh" });
    const job = await ledger.get("josh", "test", "m1");
    expect(job!.state).toBe("scheduled");
    expect(job!.driver).toBe("Josh");
  });

  it("keeps test and live pipelines for the same email separate", async () => {
    const ledger = makeLedger();
    await ledger.append({ instance: "josh", mode: "test", mailId: "m1", state: "dispatched", wamid: "w1" });
    expect(await ledger.get("josh", "live", "m1")).toBeNull();
    expect((await ledger.get("josh", "test", "m1"))!.state).toBe("dispatched");
  });

  it("a cancel (back to seen) does not lose the dispatch history line", async () => {
    const ledger = makeLedger();
    await ledger.append({ instance: "josh", mode: "test", mailId: "m1", state: "scheduled", eventId: "e1" });
    await ledger.append({ instance: "josh", mode: "test", mailId: "m1", state: "seen" });
    const job = await ledger.get("josh", "test", "m1");
    expect(job!.state).toBe("seen"); // current state reopened...
    const all = await ledger.load();
    expect(all.size).toBe(1); // ...but load() replays; the file itself keeps every line (append-only)
  });
});
