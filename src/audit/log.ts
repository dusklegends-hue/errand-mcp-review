import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { Mode } from "../gate/types.js";
import { redactParams } from "./redact.js";

export type AuditDecision = "auto" | "confirm_issued" | "confirm_consumed" | "denied";
export type AuditOutcome = "success" | "error" | "pending";

export interface AuditEvent {
  tool: string;
  action: string;
  instance: string;
  /** The mode this specific call was made in -- named per call, not global. */
  mode: Mode;
  paramsSummary: Record<string, unknown>;
  decision: AuditDecision;
  denyReason?: string | null;
  confirmToken?: string | null;
  outcome: AuditOutcome;
  error?: string | null;
  durationMs?: number;
  /** Result of a post-write re-read, when the action performs one. */
  outcomeVerified?: boolean | null;
}

let dirEnsured = false;
async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  await mkdir(path.dirname(config.auditLogPath), { recursive: true });
  dirEnsured = true;
}

/**
 * Size-based rotation. Rotating by rename keeps the live file append-only:
 * entries are never rewritten or deleted in place, they just move to a
 * timestamped sibling once the active log passes the size cap.
 */
async function rotateIfNeeded(): Promise<void> {
  try {
    const info = await stat(config.auditLogPath);
    if (info.size < config.auditMaxBytes) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await rename(config.auditLogPath, `${config.auditLogPath}.${stamp}`);
  } catch (err) {
    // ENOENT just means nothing has been logged yet.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function appendAuditEvent(event: AuditEvent): Promise<void> {
  await ensureDir();
  await rotateIfNeeded();
  const line = {
    ts: new Date().toISOString(),
    operator: config.operatorName,
    instance: event.instance,
    mode: event.mode,
    tool: event.tool,
    action: event.action,
    params_summary: redactParams(event.paramsSummary),
    decision: event.decision,
    deny_reason: event.denyReason ?? null,
    confirm_token: event.confirmToken ?? null,
    outcome: event.outcome,
    outcome_verified: event.outcomeVerified ?? null,
    error: event.error ?? null,
    duration_ms: event.durationMs ?? null,
  };
  await appendFile(config.auditLogPath, `${JSON.stringify(line)}\n`, "utf8");
}
