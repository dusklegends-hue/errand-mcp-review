/**
 * Retention sweeps (2026-09-01): the slip folder and spilled handle files are
 * the only disk locations that can carry PHI, and both are time-limited by
 * design. Rotated audit files (no PHI) get a long window of their own
 * (2026-10-07). Sweeps run at startup and daily, fire-and-forget -- a failed
 * delete (file open in the scheduler's viewer, say) is retried next sweep
 * rather than failing anything.
 */
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pure decision: which YYYY-MM-DD directory names fall outside the retention
 * window. `retentionDays: 14` keeps today's folder plus the 13 before it.
 * Slip folders are named in service-local time while `todayISO` defaults to
 * UTC; the worst mismatch keeps one extra day, never deletes one early.
 */
export function expiredDateDirs(names: string[], retentionDays: number, todayISO: string): string[] {
  const cutoff = new Date(`${todayISO}T00:00:00Z`).getTime() - (retentionDays - 1) * 86_400_000;
  return names.filter((n) => DATE_DIR.test(n) && new Date(`${n}T00:00:00Z`).getTime() < cutoff);
}

export async function sweepSlips(
  slipDir: string,
  retentionDays: number,
  todayISO: string = new Date().toISOString().slice(0, 10),
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(slipDir);
  } catch {
    return; // no slip folder yet -- nothing to sweep
  }
  for (const dir of expiredDateDirs(names, retentionDays, todayISO)) {
    await rm(path.join(slipDir, dir), { recursive: true, force: true }).catch(() => {});
  }
}

/** Rotation stamp as log.ts writes it: ISO time with ":" and "." made "-". */
const ROTATION_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

/**
 * Pure decision: which rotated audit files (`<base>.<stamp>`) are older than
 * the retention window. A rotation stamp is when that file stopped growing,
 * so every entry in it is at least that old -- nothing is deleted early.
 * The live log itself is never a candidate.
 */
export function expiredAuditRotations(names: string[], baseName: string, retentionDays: number, now: number): string[] {
  const cutoff = now - retentionDays * 86_400_000;
  return names.filter((n) => {
    if (!n.startsWith(`${baseName}.`)) return false;
    const m = ROTATION_STAMP.exec(n.slice(baseName.length + 1));
    if (!m) return false;
    return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) < cutoff;
  });
}

export async function sweepAuditRotations(auditLogPath: string, retentionDays: number, now: number = Date.now()): Promise<void> {
  const dir = path.dirname(auditLogPath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of expiredAuditRotations(names, path.basename(auditLogPath), retentionDays, now)) {
    await rm(path.join(dir, name), { force: true }).catch(() => {});
  }
}

export async function sweepHandles(handleDir: string, maxAgeHours: number, now: number = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(handleDir);
  } catch {
    return;
  }
  const cutoff = now - maxAgeHours * 3_600_000;
  for (const name of names) {
    const p = path.join(handleDir, name);
    try {
      if ((await stat(p)).mtimeMs < cutoff) await rm(p, { force: true });
    } catch {
      /* raced or locked -- next sweep gets it */
    }
  }
}
