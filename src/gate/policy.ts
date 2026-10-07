import { consumeToken, fingerprint, issueToken } from "./confirmations.js";
import type { GateContext, GateDecision, Mode, RiskTier } from "./types.js";

/** A tier per mode: the column split is the point (build plan, "gate policy"). */
type TierPair = { test: RiskTier; live: RiskTier };

/**
 * The entire security posture of the server lives here. The same action can
 * be an unremarkable auto-write against the Meta test number and a hard
 * confirm against a real driver -- the gate keys on the (action, mode) pair,
 * not the action name. This module stays pure and network-free so it is
 * fully unit-testable with no credentials at all.
 */
const RISK_TABLE: Record<string, Record<string, TierPair>> = {
  errand_email: {
    list: { test: "READ", live: "READ" },
    // Returns the slip as an image block or a handle. Read-only either way.
    get_attachment: { test: "READ", live: "READ" },
  },
  errand_calendar: {
    freebusy: { test: "READ", live: "READ" },
    // Scratch calendar versus the board people actually read.
    schedule: { test: "AUTO_WRITE", live: "CONFIRM" },
    // Books the whole backlog's boards in one action -- the human sees and
    // confirms it in live mode, exactly like a single schedule.
    // Proposes the backlog plan without booking; plan_ahead then books the
    // named list it returns.
    plan_preview: { test: "READ", live: "READ" },
    plan_ahead: { test: "AUTO_WRITE", live: "CONFIRM" },
    // Live cancel takes the same two-step confirmation as a booking
    // (customer IT, 2026-10-07): it removes a trip from a driver's day, and
    // a re-book is not guaranteed the same driver or time.
    cancel: { test: "AUTO_WRITE", live: "CONFIRM" },
  },
  // errand_dispatch was removed 2026-09-01 (WhatsApp = no BAA = HIPAA
  // exposure). Fail-closed means any stale caller gets unknown_action.
  errand_fetch_handle: {
    get: { test: "READ", live: "READ" },
  },
};

/**
 * Tool -> action names, read straight off the risk table, so a described
 * surface and a permitted surface cannot drift: an action absent here is
 * denied as `unknown_action` no matter how it was asked for.
 */
export function listActions(): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(RISK_TABLE).map(([tool, actions]) => [tool, Object.keys(actions)]),
  );
}

function resolveTier(tool: string, action: string, mode: Mode): RiskTier | undefined {
  return RISK_TABLE[tool]?.[action]?.[mode];
}

export function decide(
  tool: string,
  action: string,
  params: Record<string, unknown>,
  ctx: GateContext,
): GateDecision {
  // 1. Instance wall. Applies to reads and writes alike: credentials for an
  //    instance can be present without the model being allowed to touch it.
  const allowedModes = ctx.instanceModes.get(ctx.instance);
  if (!allowedModes) {
    return { type: "denied", reason: "not_allowlisted" };
  }

  // 2. Mode wall, keyed on (instance, mode). An instance with no "live" in
  //    its allowlist cannot be dispatched live no matter what the caller
  //    asks for -- which is every instance, until someone edits its file.
  if (!allowedModes.has(ctx.mode)) {
    return { type: "denied", reason: "mode_not_allowed_for_instance" };
  }

  const tier = resolveTier(tool, action, ctx.mode);
  if (tier === undefined) {
    // Fail closed: an unlisted or unknown action is always denied, and this
    // is NOT unlockable via ERRAND_MCP_ALLOW_DESTRUCTIVE -- a future
    // dangerous action added without an explicit table entry stays denied
    // by construction rather than silently falling through to auto.
    return { type: "denied", reason: "unknown_action" };
  }

  if (tier === "READ" || tier === "AUTO_WRITE") {
    return { type: "auto" };
  }

  let effectiveTier: RiskTier = tier;
  if (effectiveTier === "DENY_UNLESS_UNLOCKED") {
    if (!ctx.destructiveUnlocked) {
      return { type: "denied", reason: "requires_destructive_unlock" };
    }
    effectiveTier = "CONFIRM"; // unlocked, but still needs its own explicit confirm
  }

  // CONFIRM: fingerprint covers (tool, action, instance, mode, params) and
  // excludes confirmToken itself, so a token can never authorize a different
  // call, a different instance, or a different mode than it was issued for.
  const fp = fingerprint(tool, action, ctx.instance, ctx.mode, params);
  if (ctx.confirmToken && consumeToken(ctx.confirmToken, fp)) {
    return { type: "auto" };
  }
  const { token, expiresAt } = issueToken(fp);
  return { type: "confirm_required", token, expiresAt };
}
