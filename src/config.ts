import dotenv from "dotenv";
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Mode } from "./gate/types.js";

// An MCP client launches this server from ITS working directory, not ours.
// So every path here is resolved against the project root (derived from this
// module's own location: src/config.ts or dist/config.js, both one level
// down) rather than process.cwd().
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ENV_FILE = process.env.ERRAND_MCP_ENV_FILE?.trim() || ".env";
dotenv.config({ path: path.isAbsolute(ENV_FILE) ? ENV_FILE : path.join(PROJECT_ROOT, ENV_FILE) });

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

export const MODES = ["test", "live"] as const;

const boolFromString = z
  .string()
  .optional()
  .transform((v) => v?.trim().toLowerCase() === "true");

const envSchema = z.object({
  ERRAND_MCP_ALLOW_DESTRUCTIVE: boolFromString,
  ERRAND_MCP_CONFIRM_TTL_MS: z.coerce.number().int().positive().default(300_000),
  ERRAND_MCP_OPERATOR_NAME: z.string().optional(),
  ERRAND_MCP_AUDIT_LOG_PATH: z.string().default("./data/audit.jsonl"),
  ERRAND_MCP_AUDIT_MAX_BYTES: z.coerce.number().int().positive().default(10_485_760),
  ERRAND_MCP_HANDLE_DIR: z.string().default("./data/handles"),
  ERRAND_MCP_MAX_INLINE_BYTES: z.coerce.number().int().positive().default(8000),
  ERRAND_MCP_INSTANCE_DIR: z.string().default("./instances"),
  ERRAND_MCP_LEDGER_PATH: z.string().default("./data/jobs.jsonl"),
  ERRAND_MCP_SLIP_DIR: z.string().default("./data/slips"),
  /** Days the scheduler's slip folder keeps a dated subfolder. */
  ERRAND_MCP_SLIP_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  /** Hours a spilled handle file may live before the startup sweep removes it. */
  ERRAND_MCP_HANDLE_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  /** Days a ROTATED audit file is kept. The audit log carries no PHI; six
   *  years matches the HIPAA documentation-retention period. The customer's
   *  own policy sets the real number. */
  ERRAND_MCP_AUDIT_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(2190),
});

/**
 * One instance = one deployment target: whose mailbox is read, whose roster
 * is searched. The file holds SHAPE (ids,
 * roster, hours); every secret stays in the env file and is referenced here
 * by variable NAME, so handing the tool to the business is a new instance
 * file plus a new env block -- no code changes (the provider-seam promise).
 */
const rosterEntrySchema = z.object({
  driver: z.string().min(1),
  calendarId: z.string().min(1),
  /** Zone this driver covers ("central", "east", "west", ...).
   *  Free-form lowercase; schedule matches it case-insensitively. */
  region: z.string().min(1).optional(),
});

const modeTargetSchema = z.object({
  /**
   * The SANDBOX calendar: REQUIRED in test, where every booking lands here
   * instead of on the assigned driver's calendar -- a test can read real
   * driver calendars while writing only to a scratch one. REFUSED in live
   * (see loadInstances): a live booking must land on the driver's own
   * calendar, or the next availability check cannot see it and the same
   * driver gets booked twice.
   */
  scheduleCalendarId: z.string().min(1).optional(),
  roster: z.array(rosterEntrySchema).min(1),
});

const instanceSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  /** Modes this instance may be addressed in. Omit "live" and live dispatch does not exist here. */
  modes: z.array(z.enum(MODES)).min(1),
  mail: z.object({
    clientIdEnv: z.string().min(1),
    /** Rotating Microsoft refresh token lives here, not in env -- see auth/msTokens.ts. */
    tokenFile: z.string().min(1),
  }),
  google: z.object({
    clientIdEnv: z.string().min(1),
    clientSecretEnv: z.string().min(1),
    tokenFile: z.string().min(1),
  }),
  serviceHours: z.object({
    timeZone: z.string().min(1),
    /** Local wall-clock opening hours, HH:MM. */
    open: z.string().regex(/^\d{2}:\d{2}$/),
    close: z.string().regex(/^\d{2}:\d{2}$/),
  }),
  delivery: z.object({
    /**
     * How a trip's time is chosen. "appointment" (default, the go-live
     * requirement): the trip is booked at the time the request states and
     * a request without an appointment date/time is not bookable.
     * "soonest": the next free slot in service hours -- the pre-2026-10-07
     * behavior, kept for instances that genuinely have no appointment.
     */
    bookBy: z.enum(["appointment", "soonest"]).default("appointment"),
    /** Trip length in minutes. Appointment mode uses it only when the
     *  request states no pick-up time (the trip then starts this long
     *  before the appointment); soonest mode searches for a slot this long. */
    durationMinutes: z.number().int().min(15).max(480),
    /** Without a horizon, "soonest" happily books three months out. */
    horizonDays: z.number().int().min(1).max(14),
  }),
  /** Zone -> 5-digit ZIPs it covers. Lets `schedule` derive the delivery
   *  region server-side from the parsed address (PHI-blind). Optional. */
  regions: z.record(z.string(), z.array(z.string().regex(/^\d{5}$/))).optional(),
  /**
   * Whether the operator may view an attached request image at all. Off by
   * default: the image is the whole form, PHI included, and with this off
   * no tool result carries member data. Images still reach the scheduler's
   * slip folder either way.
   */
  allowImageView: z.boolean().default(false),
  test: modeTargetSchema.optional(),
  live: modeTargetSchema.optional(),
});

export type InstanceConfig = z.infer<typeof instanceSchema> & {
  /** Resolved secrets, pulled from env by the names the file gave. */
  secrets: {
    msClientId: string;
    googleClientId: string;
    googleClientSecret: string;
  };
  mailTokenPath: string;
  googleTokenPath: string;
};

function fail(message: string): never {
  // Fail closed: a misconfigured server must not start rather than start unsafe.
  // eslint-disable-next-line no-console
  console.error(`errand-mcp: ${message}`);
  process.exit(1);
}

function requireEnv(name: string, forWhat: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`instance ${forWhat} names env var ${name}, which is empty or unset`);
  return value;
}

function loadInstances(dir: string): Map<string, InstanceConfig> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    fail(`instance directory ${dir} does not exist or is unreadable`);
  }
  if (files.length === 0) {
    fail(`instance directory ${dir} holds no *.json instance files, refusing to start`);
  }

  const instances = new Map<string, InstanceConfig>();
  for (const file of files) {
    const full = path.join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(full, "utf8"));
    } catch (err) {
      fail(`instance file ${file} is not valid JSON: ${(err as Error).message}`);
    }
    const parsed = instanceSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
      fail(`instance file ${file} is invalid, refusing to start:\n${issues}`);
    }
    const inst = parsed.data;
    // A mode in `modes` without its target block would fail at dispatch time
    // with a confusing error; refuse at startup instead.
    for (const mode of inst.modes) {
      if (!inst[mode]) fail(`instance ${inst.name} allows mode "${mode}" but has no "${mode}" target block`);
    }
    // Test mode must name its sandbox: every test-mode booking lands there,
    // so a test roster that lists real drivers' calendars (for realistic
    // availability) can never write to them -- and test writes need no
    // confirmation, so this is the wall that keeps them off real calendars.
    if (inst.test && !inst.test.scheduleCalendarId) {
      fail(`instance ${inst.name}: test.scheduleCalendarId is required -- test-mode bookings must land on a scratch calendar`);
    }
    if (inst.live?.scheduleCalendarId) {
      fail(
        `instance ${inst.name}: live.scheduleCalendarId is not allowed -- live bookings land on the assigned driver's own calendar so availability sees them`,
      );
    }
    instances.set(inst.name, {
      ...inst,
      secrets: {
        msClientId: requireEnv(inst.mail.clientIdEnv, inst.name),
        googleClientId: requireEnv(inst.google.clientIdEnv, inst.name),
        googleClientSecret: requireEnv(inst.google.clientSecretEnv, inst.name),
      },
      mailTokenPath: resolveFromRoot(inst.mail.tokenFile),
      googleTokenPath: resolveFromRoot(inst.google.tokenFile),
    });
  }
  return instances;
}

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    fail(`invalid configuration, refusing to start:\n${issues}`);
  }
  const env = parsed.data;

  const instances = loadInstances(resolveFromRoot(env.ERRAND_MCP_INSTANCE_DIR));

  /** instance -> the set of modes that instance may be addressed in. */
  const instanceModes = new Map<string, Set<Mode>>();
  for (const [name, inst] of instances) {
    instanceModes.set(name, new Set(inst.modes));
  }

  return {
    instances,
    instanceModes,
    destructiveUnlocked: env.ERRAND_MCP_ALLOW_DESTRUCTIVE,
    confirmTtlMs: env.ERRAND_MCP_CONFIRM_TTL_MS,
    operatorName: env.ERRAND_MCP_OPERATOR_NAME?.trim() || os.userInfo().username,
    auditLogPath: resolveFromRoot(env.ERRAND_MCP_AUDIT_LOG_PATH),
    auditMaxBytes: env.ERRAND_MCP_AUDIT_MAX_BYTES,
    handleDir: resolveFromRoot(env.ERRAND_MCP_HANDLE_DIR),
    maxInlineBytes: env.ERRAND_MCP_MAX_INLINE_BYTES,
    ledgerPath: resolveFromRoot(env.ERRAND_MCP_LEDGER_PATH),
    slipDir: resolveFromRoot(env.ERRAND_MCP_SLIP_DIR),
    slipRetentionDays: env.ERRAND_MCP_SLIP_RETENTION_DAYS,
    handleRetentionHours: env.ERRAND_MCP_HANDLE_RETENTION_HOURS,
    auditRetentionDays: env.ERRAND_MCP_AUDIT_RETENTION_DAYS,
  };
}

export type Config = ReturnType<typeof loadConfig>;

export const config: Config = loadConfig();

/** The one place instance lookup + existence checking happens for handlers. */
export function getInstance(name: string): InstanceConfig | null {
  return config.instances.get(name) ?? null;
}
