/**
 * Retention sweeps (2026-09-01): the slip folder and spilled handle files are
 * the only disk locations that can carry PHI, and both are time-limited by
 * design. Sweeps run at startup and are fire-and-forget -- a failed delete
 * (file open in the scheduler's viewer, say) is retried next start rather
 * than failing anything.
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
