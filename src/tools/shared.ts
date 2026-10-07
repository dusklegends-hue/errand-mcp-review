import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { appendAuditEvent } from "../audit/log.js";
import { config } from "../config.js";
import { decide } from "../gate/policy.js";
import type { GateContext, Mode } from "../gate/types.js";
import { UpstreamError } from "../util/http.js";

/**
 * Every tool declares these. `instance` and `mode` are both required with no
 * default (playbook 3.2): a dispatch server that can only run against
 * production is one typo away from booking a real trip for a real member, so the caller states the target on every single call.
 */
export const commonShape = {
  instance: z.string().min(1),
  mode: z.enum(["test", "live"]),
  verbosity: z.enum(["compact", "full"]).optional(),
  confirm_token: z.string().optional(),
};

export type Verbosity = "compact" | "full";

export interface CommonArgs {
  instance: string;
  mode: Mode;
  verbosity?: Verbosity;
  confirm_token?: string;
}

export function ok(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Structured, non-crashing validation error for a bad action/field combination on a dense tool. */
export function requireFields(args: object, fields: string[]): string | null {
  const record = args as Record<string, unknown>;
  const missing = fields.filter((f) => record[f] === undefined || record[f] === null || record[f] === "");
  if (missing.length > 0) {
    return `Missing required field(s) for this action: ${missing.join(", ")}`;
  }
  return null;
}

function buildGateContext(instance: string, mode: Mode, confirmToken: string | undefined): GateContext {
  return {
    instance,
    mode,
    destructiveUnlocked: config.destructiveUnlocked,
    confirmToken,
    instanceModes: config.instanceModes,
  };
}

export interface RunActionOptions {
  tool: string;
  action: string;
  /** The instance and mode named on this call. Threaded into the gate, the fingerprint, and the audit line. */
  instance: string;
  mode: Mode;
  /**
   * The call's identifying arguments. Written to the audit log (redacted)
   * AND folded into the confirmation fingerprint, so a token is bound to
   * the specific target it was issued for -- not just the action name.
   */
  auditParams: Record<string, unknown>;
  confirmToken?: string;
  /** Runs only once the gate has returned "auto". Its return value is spread into the {status:"ok", ...} response. */
  execute: () => Promise<object>;
  /** Which upstream to blame when `execute` throws and the error is not an UpstreamError. */
  errorLabel?: string;
  /**
   * Builds the success CallToolResult from execute's payload instead of the
   * default JSON text -- the attachment path uses this to return an MCP
   * image content block. Gate, audit, and error handling are unchanged.
   */
  resultContent?: (result: object) => CallToolResult;
}

/**
 * The one path every tool action funnels through: gate decision first
 * (deny/confirm/auto), audit log always, upstream call only on auto. This is
 * what makes "gate before handler, fail closed" true by construction rather
 * than by each tool file remembering to check.
 */
export async function runAction(opts: RunActionOptions): Promise<CallToolResult> {
  const ctx = buildGateContext(opts.instance, opts.mode, opts.confirmToken);
  const decision = decide(opts.tool, opts.action, opts.auditParams, ctx);
  const startedAt = Date.now();

  const auditBase = {
    tool: opts.tool,
    action: opts.action,
    instance: opts.instance,
    mode: opts.mode,
    paramsSummary: opts.auditParams,
  };

  if (decision.type === "denied") {
    await appendAuditEvent({
      ...auditBase,
      decision: "denied",
      denyReason: decision.reason,
      outcome: "error",
      error: `denied: ${decision.reason}`,
    });
    return ok({ status: "denied", reason: decision.reason });
  }

  if (decision.type === "confirm_required") {
    await appendAuditEvent({
      ...auditBase,
      decision: "confirm_issued",
      confirmToken: decision.token,
      outcome: "pending",
    });
    return ok({
      status: "confirmation_required",
      message: `This action requires confirmation before it runs. Re-call ${opts.tool} with the identical arguments plus confirm_token to proceed.`,
      confirm_token: decision.token,
      expires_at: decision.expiresAt,
      action_summary: {
        tool: opts.tool,
        action: opts.action,
        instance: opts.instance,
        mode: opts.mode,
        ...opts.auditParams,
      },
    });
  }

  // decision.type === "auto"
  const auditDecision = opts.confirmToken ? "confirm_consumed" : "auto";
  try {
    const result = await opts.execute();
    await appendAuditEvent({
      ...auditBase,
      decision: auditDecision,
      confirmToken: opts.confirmToken ?? null,
      outcome: "success",
      durationMs: Date.now() - startedAt,
    });
    if (opts.resultContent) return opts.resultContent(result);
    return ok({ status: "ok", ...result });
  } catch (err) {
    // Capped like the audit copy. This server's own messages name fields
    // and rules, never request values; upstream errors arrive already
    // reduced to status + code (util/http.ts).
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    await appendAuditEvent({
      ...auditBase,
      decision: auditDecision,
      confirmToken: opts.confirmToken ?? null,
      outcome: "error",
      error: message,
      durationMs: Date.now() - startedAt,
    });
    // UpstreamError already names its upstream; only unlabeled errors get the fallback.
    const label = err instanceof UpstreamError ? "" : `${opts.errorLabel ?? "errand-mcp"} error: `;
    return errorResult(`${label}${message}`);
  }
}
