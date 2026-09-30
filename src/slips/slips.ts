/**
 * Slip filing (2026-09-01, Josh's design): the request-form photo from
 * each scheduled trip is saved where the scheduler can grab it at a
 * glance -- data/slips/<local date>/<driver>/<HHMM>_order-<ref>.jpg -- and
 * the folder is swept after the retention window (see util/retention.ts).
 *
 * Deliberate: NO path segment carries member data. Date, driver, time, and
 * a hash of the mail id are enough to find "Bob's 9:30 slip"; the member
 * is visible only inside the photo itself.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SlipMeta {
  driver: string;
  /** Slot start, ISO -- the folder date/time are this instant in service-local time. */
  startISO: string;
  timeZone: string;
  mailId: string;
  contentType: string;
}

export function localDateParts(iso: string, timeZone: string): { date: string; hhmm: string } {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const t = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return { date, hhmm: t.replace(":", "") };
}

/** Windows-safe folder name from a driver name; never empty. */
export function safeName(s: string): string {
  return s.trim().replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "unknown";
}

export function slipExt(contentType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
  };
  return map[contentType.trim().toLowerCase()] ?? "bin";
}

/** Short, stable, non-reversible reference for a mail id -- filename-safe. */
export function orderRef(mailId: string): string {
  return createHash("sha1").update(mailId).digest("hex").slice(0, 8);
}

export function slipRelPath(meta: SlipMeta): string {
  const { date, hhmm } = localDateParts(meta.startISO, meta.timeZone);
  return path.join(date, safeName(meta.driver), `${hhmm}_order-${orderRef(meta.mailId)}.${slipExt(meta.contentType)}`);
}

export async function fileSlip(baseDir: string, meta: SlipMeta, bytes: Buffer): Promise<string> {
  const full = path.join(baseDir, slipRelPath(meta));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, bytes);
  return full;
}
