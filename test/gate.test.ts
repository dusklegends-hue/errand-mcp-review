import { beforeEach, describe, expect, it } from "vitest";
import { _resetForTests, fingerprint } from "../src/gate/confirmations.js";
import { decide, listActions } from "../src/gate/policy.js";
import type { GateContext, Mode } from "../src/gate/types.js";

function ctx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    instance: "josh",
    mode: "test",
    destructiveUnlocked: false,
    instanceModes: new Map<string, Set<Mode>>([["josh", new Set<Mode>(["test", "live"])]]),
    ...overrides,
  };
}

beforeEach(() => _resetForTests());

describe("gate policy", () => {
  // The planted regression (build plan, stage 0 "done when"): the rule must
  // be shown biting, not just written down.
  it("refuses a live-mode schedule without a token AND allows the same call in test mode", () => {
    const params = { mail_id: "m1" };
    const live = decide("errand_calendar", "schedule", params, ctx({ mode: "live" }));
    expect(live.type).toBe("confirm_required");

    const test = decide("errand_calendar", "schedule", params, ctx({ mode: "test" }));
    expect(test.type).toBe("auto");
  });

  it("denies the removed dispatch tool outright (WhatsApp path deleted 2026-09-01)", () => {
    for (const action of ["preview", "send", "resend"]) {
      expect(decide("errand_dispatch", action, {}, ctx())).toEqual({ type: "denied", reason: "unknown_action" });
    }
  });

  it("denies an unknown instance outright, even for reads", () => {
    const d = decide("errand_email", "list", {}, ctx({ instance: "nobody" }));
    expect(d).toEqual({ type: "denied", reason: "not_allowlisted" });
  });

  it("denies live mode for an instance whose allowlist has only test", () => {
    const d = decide(
      "errand_calendar",
      "schedule",
      {},
      ctx({ mode: "live", instanceModes: new Map([["josh", new Set<Mode>(["test"])]]) }),
    );
    expect(d).toEqual({ type: "denied", reason: "mode_not_allowed_for_instance" });
  });

  it("denies unknown actions and tools, not unlockable", () => {
    expect(decide("errand_email", "delete", {}, ctx())).toEqual({ type: "denied", reason: "unknown_action" });
    expect(decide("errand_email", "delete", {}, ctx({ destructiveUnlocked: true }))).toEqual({
      type: "denied",
      reason: "unknown_action",
    });
  });

  it("consumes a valid confirmation token exactly once", () => {
    const params = { mail_id: "m1" };
    const first = decide("errand_calendar", "schedule", params, ctx({ mode: "live" }));
    expect(first.type).toBe("confirm_required");
    const token = (first as { token: string }).token;

    const second = decide("errand_calendar", "schedule", params, ctx({ mode: "live", confirmToken: token }));
    expect(second.type).toBe("auto");

    // Replay: the same token again is refused (a fresh confirm is issued).
    const third = decide("errand_calendar", "schedule", params, ctx({ mode: "live", confirmToken: token }));
    expect(third.type).toBe("confirm_required");
  });

  it("refuses a token against different params, a different mode, or a different instance", () => {
    const params = { mail_id: "m1" };
    const issued = decide("errand_calendar", "schedule", params, ctx({ mode: "live" }));
    const token = (issued as { token: string }).token;

    // Different params: refused AND burned.
    const edited = decide("errand_calendar", "schedule", { mail_id: "m2" }, ctx({ mode: "live", confirmToken: token }));
    expect(edited.type).toBe("confirm_required");

    // The burned token no longer works even for the original call.
    const replayOriginal = decide("errand_calendar", "schedule", params, ctx({ mode: "live", confirmToken: token }));
    expect(replayOriginal.type).toBe("confirm_required");
  });

  it("fingerprints differ across instance and mode for identical params", () => {
    const p = { mail_id: "m1" };
    expect(fingerprint("t", "a", "josh", "test", p)).not.toBe(fingerprint("t", "a", "josh", "live", p));
    expect(fingerprint("t", "a", "josh", "test", p)).not.toBe(fingerprint("t", "a", "biz", "test", p));
  });

  it("exposes exactly the planned surface", () => {
    expect(listActions()).toEqual({
      errand_email: ["list", "get_attachment"],
      errand_calendar: ["freebusy", "schedule", "plan_ahead", "cancel"],
      errand_fetch_handle: ["get"],
    });
  });
});
