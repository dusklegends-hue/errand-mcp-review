/**
 * Startup refusals. config.ts exits the process on a bad instance file
 * (fail closed), so each case runs in a child process.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const roster = [{ driver: "Ana", calendarId: "ana@cal" }];
const base = {
  name: "t",
  mail: { clientIdEnv: "T_MS", tokenFile: "./ms.json" },
  google: { clientIdEnv: "T_GID", clientSecretEnv: "T_GSEC", tokenFile: "./g.json" },
  serviceHours: { timeZone: "America/Denver", open: "07:00", close: "18:00" },
  delivery: { durationMinutes: 60, horizonDays: 3 },
};

function load(instance: object): { status: number | null; stderr: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "errand-config-"));
  mkdirSync(path.join(dir, "instances"));
  writeFileSync(path.join(dir, "instances", "t.json"), JSON.stringify({ ...base, ...instance }));
  const r = spawnSync(process.execPath, ["--import", "tsx", "-e", "import('./src/config.ts')"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ERRAND_MCP_ENV_FILE: path.join(dir, "no-such.env"),
      ERRAND_MCP_INSTANCE_DIR: path.join(dir, "instances"),
      T_MS: "x",
      T_GID: "x",
      T_GSEC: "x",
    },
  });
  return { status: r.status, stderr: r.stderr };
}

describe("instance walls at startup", () => {
  it("refuses a live block that names a board calendar (bookings must land on the driver's calendar)", () => {
    const r = load({ modes: ["live"], live: { scheduleCalendarId: "board@cal", roster } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("live.scheduleCalendarId is not allowed");
  });

  it("refuses a test block with no sandbox calendar (test writes must never reach real calendars)", () => {
    const r = load({ modes: ["test"], test: { roster } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("test.scheduleCalendarId is required");
  });

  it("starts with a sandboxed test block and a board-free live block", () => {
    const r = load({ modes: ["test", "live"], test: { scheduleCalendarId: "sandbox@cal", roster }, live: { roster } });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
}, 30_000);
