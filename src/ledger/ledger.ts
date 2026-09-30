import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The stage that separates a demo from something safe to run unattended
 * (build plan, stage 4): a job record keyed on the Graph message id, moving
 * seen -> scheduled -> dispatched, appended the way the audit log appends.
 * Re-processing the same email finds the job already advanced and refuses,
 * so a watcher restart mid-run cannot tell a driver twice.
 *
 * Keyed per (instance, mode) as well as mail id: a test-mode rehearsal of an
 * email must not block -- or stand in for -- its live dispatch.
 */

export type JobState = "seen" | "scheduled" | "dispatched";

export interface JobRecord {
  key: string;
  instance: string;
  mode: string;
  mailId: string;
  state: JobState;
  at: string;
  /** Set once scheduled. */
  driver?: string;
  slotStart?: string;
  slotEnd?: string;
  eventId?: string;
  calendarId?: string;
}

export function jobKey(instance: string, mode: string, mailId: string): string {
  return `${instance}:${mode}:${mailId}`;
}

export class Ledger {
  constructor(private readonly filePath: string) {}

  /** Replay the append-only file; the last line per key is the current state. */
  async load(): Promise<Map<string, JobRecord>> {
    const jobs = new Map<string, JobRecord>();
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return jobs; // no ledger yet -- nothing has ever been processed
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as JobRecord;
        jobs.set(record.key, record);
      } catch {
        // A torn final line (crash mid-append) loses that one transition,
        // never the file. Skip it rather than refusing every job.
      }
    }
    return jobs;
  }

  async get(instance: string, mode: string, mailId: string): Promise<JobRecord | null> {
    const jobs = await this.load();
    return jobs.get(jobKey(instance, mode, mailId)) ?? null;
  }

  async append(record: Omit<JobRecord, "key" | "at">): Promise<JobRecord> {
    const full: JobRecord = {
      ...record,
      key: jobKey(record.instance, record.mode, record.mailId),
      at: new Date().toISOString(),
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }
}
