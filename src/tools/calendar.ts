import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { deleteEvent, freeBusy, insertEvent, type BusyBlock } from "../calendar/google.js";
import { findSoonestSlot, type DriverAvailability } from "../calendar/slots.js";
import { assignFixedTrips, freeBusyRanges, pickDriverFor, tripWindow, type FixedTrip } from "../calendar/trip.js";
import { config, getInstance, type InstanceConfig } from "../config.js";
import { getAttachment, getMessageBody, listInbox } from "../mail/graph.js";
import { fileSlip, orderRef } from "../slips/slips.js";
import { hourSlotsByDay, planAhead } from "../calendar/plan.js";
import { sweepSlips } from "../util/retention.js";
import { parseOrder, regionForAddress, type ParsedOrder } from "../mail/order.js";
import { Ledger } from "../ledger/ledger.js";
import type { Mode } from "../gate/types.js";
import { UpstreamError } from "../util/http.js";
import { formatLocal } from "../util/tz.js";
import { commonShape, errorResult, requireFields, runAction, type CommonArgs } from "./shared.js";

const ACTIONS = ["freebusy", "schedule", "plan_preview", "plan_ahead", "cancel"] as const;

const inputShape = {
  ...commonShape,
  action: z.enum(ACTIONS),
  /** The Graph message id this job is for -- the ledger key. */
  mail_id: z.string().min(1).optional(),
  // PHI-blind (2026-09-01): member / pickup_from / deliver_to are
  // DELIBERATELY not arguments. The server reads them out of the order
  // email itself, so member data never passes through the operator layer.
  /** Pin a specific driver instead of letting the server pick. */
  driver: z.string().max(100).optional(),
  /** Delivery zone ("central", "east", ...). Prefers drivers whose roster
   *  region matches; falls back to the whole roster if none are free. */
  region: z.string().max(60).optional(),
  /** plan_ahead: how many days back to scan the mailbox for backlog (default 3). */
  since_days: z.number().int().min(1).max(14).optional(),
  /** plan_ahead, soonest-mode instances only: first day to fill -- 1 = tomorrow (default), 0 = later today. */
  from_day: z.number().int().min(0).max(7).optional(),
  /** plan_ahead: book exactly these requests (the mail_ids plan_preview returned). Required in live mode. */
  mail_ids: z.array(z.string().min(1).max(512)).min(1).max(50).optional(),
};

interface Args extends CommonArgs {
  action: (typeof ACTIONS)[number];
  mail_id?: string;
  driver?: string;
  region?: string;
  since_days?: number;
  from_day?: number;
  mail_ids?: string[];
}

/**
 * Live availability for the mode's roster across one or more time ranges:
 * one freebusy query per range, busy never cached (roster is shape; busy is
 * data).
 */
async function rosterAvailability(
  inst: InstanceConfig,
  mode: Mode,
  ranges: { from: Date; to: Date }[],
): Promise<DriverAvailability[]> {
  const roster = inst[mode]!.roster;
  const ids = roster.map((r) => r.calendarId);
  const busy = new Map<string, BusyBlock[]>(ids.map((id) => [id, []]));
  for (const r of ranges) {
    const got = await freeBusy(inst, ids, r.from.toISOString(), r.to.toISOString());
    for (const [id, blocks] of got) busy.get(id)!.push(...blocks);
  }
  return roster.map((r) => ({
    driver: r.driver,
    calendarId: r.calendarId,
    region: r.region,
    busy: busy.get(r.calendarId) ?? [],
  }));
}

/** Now through the end of the soonest-search horizon. */
function horizonRange(inst: InstanceConfig): { from: Date; to: Date } {
  const now = new Date();
  return { from: now, to: new Date(now.getTime() + (inst.delivery.horizonDays + 1) * 86_400_000) };
}

interface Booking {
  mailId: string;
  driver: string;
  calendarId: string;
  start: Date;
  end: Date;
}

/**
 * Writes one trip: the calendar event (which IS the driver assignment), the
 * ledger line, and the filed request image. schedule and plan_ahead both
 * book through here, so they cannot drift apart.
 *
 * The event lands on the assigned driver's OWN calendar -- the calendar the
 * next availability check reads -- unless test mode names a sandbox
 * calendar (config.ts refuses one in live). Before 2026-10-07 `schedule`
 * wrote to a single board calendar while availability read the drivers'
 * calendars, so a second booking could land on the same driver and time.
 */
async function bookTrip(
  inst: InstanceConfig,
  args: Args,
  ledger: Ledger,
  order: ParsedOrder,
  b: Booking,
): Promise<string> {
  const target = inst[args.mode]!.scheduleCalendarId ?? b.calendarId;
  const tz = inst.serviceHours.timeZone;
  const created = await insertEvent(inst, target, {
    summary: `Transport: ${order.member} (${b.driver})`,
    description:
      `Pick up: ${order.pickupFrom} at ${formatLocal(b.start, tz)}\n` +
      `Destination: ${order.deliverTo} by ${formatLocal(b.end, tz)}\n` +
      `Order ref: order-${orderRef(b.mailId)}`,
    startISO: b.start.toISOString(),
    endISO: b.end.toISOString(),
  });

  await ledger.append({
    instance: args.instance,
    mode: args.mode,
    mailId: b.mailId,
    state: "scheduled",
    driver: b.driver,
    slotStart: b.start.toISOString(),
    slotEnd: b.end.toISOString(),
    eventId: created.id,
    calendarId: target,
  });

  // File the request image where the scheduler grabs it:
  // data/slips/<local date>/<driver>/. Best-effort -- a request with no
  // image still books. This folder is where PHI rests on this machine, and
  // it is swept after the retention window.
  try {
    const att = await getAttachment(inst, b.mailId);
    await fileSlip(
      config.slipDir,
      { driver: b.driver, startISO: b.start.toISOString(), timeZone: tz, mailId: b.mailId, contentType: att.contentType },
      att.bytes,
    );
  } catch {
    /* no image attachment or transient fetch failure */
  }
  return created.id;
}

function missingFieldsError(missing: string[], byAppointment: boolean): Error {
  const appointmentLines = byAppointment ? `, "Date of the Appointment: ...", "Time of the Appointment: ..."` : "";
  return new Error(
    `request email is missing labeled field(s): ${missing.join(", ")} -- ` +
      `expected lines like "Member's Name: ...", "Pick-Up: ...", "Destination: ..."${appointmentLines} ` +
      `(PHI-blind mode reads these from the email server-side; they are not arguments)`,
  );
}

export async function handleCalendar(args: Args): Promise<CallToolResult> {
  const inst = getInstance(args.instance);
  if (!inst) return errorResult(`Unknown instance "${args.instance}". Configured: ${[...config.instances.keys()].join(", ")}`);

  const ledger = new Ledger(config.ledgerPath);
  const tz = inst.serviceHours.timeZone;
  const byAppointment = inst.delivery.bookBy === "appointment";
  const base = {
    tool: "errand_calendar",
    instance: args.instance,
    mode: args.mode,
    confirmToken: args.confirm_token,
  };
  const slotQuery = () => ({
    now: new Date(),
    durationMinutes: inst.delivery.durationMinutes,
    horizonDays: inst.delivery.horizonDays,
    open: inst.serviceHours.open,
    close: inst.serviceHours.close,
    timeZone: tz,
  });

  /**
   * The backlog and its assignment, without booking anything -- shared by
   * plan_preview (shows it) and plan_ahead (books it). `onlyIds` restricts
   * the backlog to a named list; a named id that is no longer pending comes
   * back in `skipped`.
   */
  const buildPlan = async (onlyIds?: string[]) => {
    // 1. The backlog: recent, labeled, not yet scheduled. All parsing is
    //    server-side (PHI-blind); mail with no labeled lines at all is
    //    ignored silently, partially-labeled mail is reported by ref so a
    //    human can fix the email.
    const mail = await listInbox(inst, { limit: 50, sinceDays: args.since_days ?? 3 });
    const jobs = await ledger.load();
    const wanted = onlyIds ? new Set(onlyIds) : null;
    const pool: { mailId: string; region: string | null; order: ParsedOrder }[] = [];
    const malformed: { ref: string; missing: string[] }[] = [];
    for (const m of mail) {
      if (wanted && !wanted.has(m.id)) continue;
      const state = jobs.get(`${args.instance}:${args.mode}:${m.id}`)?.state ?? null;
      if (state === "scheduled" || state === "dispatched") continue;
      const parsed = parseOrder(m.bodyText, { requireAppointment: byAppointment });
      if (parsed.order) {
        pool.push({ mailId: m.id, region: regionForAddress(parsed.order.deliverTo, inst.regions), order: parsed.order });
      } else if (parsed.found > 0) {
        malformed.push({ ref: `order-${orderRef(m.id)}`, missing: parsed.missing });
      }
    }
    const skipped = (onlyIds ?? [])
      .filter((id) => !pool.some((p) => p.mailId === id))
      .map((id) => ({ ref: `order-${orderRef(id)}`, reason: "no longer pending (already booked, incomplete, or outside the scan window)" }));

    // 2. Assign. Appointment mode: every trip keeps the time its request
    //    states; each goes to the best driver free for it. Soonest mode: the
    //    backlog is laid across the days ahead, a side of town per driver
    //    per day, overflow rolling forward.
    let assignments: (Booking & { regionMatch: boolean })[];
    let boards: { date: string; board: { driver: string; regions: string[]; count: number }[] }[];
    const unassigned: { ref: string; reason: string }[] = [];
    if (byAppointment) {
      const trips: FixedTrip[] = [];
      for (const p of pool) {
        const w = tripWindow(p.order, slotQuery());
        if (w.ok) trips.push({ mailId: p.mailId, region: p.region, start: w.start, end: w.end });
        else unassigned.push({ ref: `order-${orderRef(p.mailId)}`, reason: w.reason });
      }
      const drivers = trips.length > 0 ? await rosterAvailability(inst, args.mode, freeBusyRanges(trips, tz)) : [];
      const plan = assignFixedTrips(trips, drivers, tz);
      assignments = plan.assignments;
      boards = plan.boards;
      for (const u of plan.unassigned) unassigned.push({ ref: `order-${orderRef(u.mailId)}`, reason: u.reason });
    } else {
      const drivers = await rosterAvailability(inst, args.mode, [horizonRange(inst)]);
      const daysAhead = hourSlotsByDay(drivers, slotQuery(), args.from_day ?? 1, inst.delivery.horizonDays);
      const plan = planAhead(pool.map((p) => ({ mailId: p.mailId, region: p.region })), daysAhead);
      assignments = plan.assignments;
      boards = plan.boards;
      for (const u of plan.unassigned) unassigned.push({ ref: `order-${orderRef(u.mailId)}`, reason: u.reason });
    }
    return { pool, malformed, skipped, assignments, boards, unassigned };
  };

  switch (args.action) {
    case "freebusy":
      return runAction({
        ...base,
        action: "freebusy",
        auditParams: {},
        execute: async () => {
          const drivers = await rosterAvailability(inst, args.mode, [horizonRange(inst)]);
          const slot = findSoonestSlot(drivers, slotQuery());
          return {
            drivers: drivers.map((d) => ({ driver: d.driver, region: d.region ?? null, busy_blocks: d.busy.length })),
            soonest_slot: slot
              ? {
                  driver: slot.driver,
                  start: slot.start.toISOString(),
                  end: slot.end.toISOString(),
                  local: formatLocal(slot.start, tz),
                }
              : null,
            searched_days: inst.delivery.horizonDays,
          };
        },
      });

    case "schedule": {
      const missing = requireFields(args, ["mail_id"]);
      if (missing) return errorResult(missing);
      // PHI-blind: audit params for schedule carry no member data at all.
      // The confirmation fingerprint binds mail_id -- the job's identity.
      return runAction({
        ...base,
        action: "schedule",
        auditParams: {
          mail_id: args.mail_id,
          driver: args.driver ?? null,
          region: args.region ?? null,
        },
        execute: async () => {
          const mailId = args.mail_id!;
          const existing = await ledger.get(args.instance, args.mode, mailId);
          if (existing && existing.state !== "seen") {
            // The double-booking wall: a request already scheduled is
            // refused, not re-booked. `cancel` is the way back.
            throw new Error(
              `job for this email is already "${existing.state}" (driver ${existing.driver ?? "?"}) -- cancel it first if this is a re-book`,
            );
          }

          // PHI-blind extraction: the server reads the request email itself.
          const msg = await getMessageBody(inst, mailId);
          const parsed = parseOrder(msg.bodyText, { requireAppointment: byAppointment });
          if (!parsed.order) throw missingFieldsError(parsed.missing, byAppointment);
          const order = parsed.order;
          const zone = args.region ?? regionForAddress(order.deliverTo, inst.regions);

          // Appointment mode fixes the trip window from the request before
          // any calendar is read; it is never moved to fit a driver.
          let window: { start: Date; end: Date } | null = null;
          if (byAppointment) {
            const trip = tripWindow(order, slotQuery());
            if (!trip.ok) throw new Error(`not booked: ${trip.reason}`);
            window = { start: trip.start, end: trip.end };
          }

          let drivers = await rosterAvailability(inst, args.mode, [
            window ? { from: window.start, to: window.end } : horizonRange(inst),
          ]);
          if (args.driver) {
            drivers = drivers.filter((d) => d.driver.toLowerCase() === args.driver!.toLowerCase());
            if (drivers.length === 0) throw new Error(`driver "${args.driver}" is not on the ${args.mode} roster`);
          }

          let chosen: Booking & { region?: string };
          if (window) {
            // Region preference (Josh, 2026-09-01) carries over: an in-zone
            // driver free for the window first, anyone free otherwise.
            const pick = pickDriverFor({ mailId, region: zone, ...window }, drivers, [], tz);
            if (!pick) {
              throw new Error(
                args.driver
                  ? `not booked: driver "${args.driver}" is not free for the requested trip time -- needs a human call`
                  : "not booked: no driver on the roster is free for the requested trip time -- needs a human call",
              );
            }
            chosen = { mailId, driver: pick.driver, calendarId: pick.calendarId, region: pick.region, ...window };
          } else {
            // Soonest mode. Region preference (Josh, 2026-09-01): east-side
            // jobs go to east-side drivers. A pinned driver overrides region;
            // an empty match falls back to the whole roster, because a trip
            // by the "wrong" zone's driver beats no trip at all.
            if (zone && !args.driver) {
              const want = zone.trim().toLowerCase();
              const inZone = drivers.filter((d) => d.region?.trim().toLowerCase() === want);
              if (inZone.length > 0) drivers = inZone;
            }
            const slot = findSoonestSlot(drivers, slotQuery());
            if (!slot) {
              throw new Error(
                `no free ${inst.delivery.durationMinutes}-minute slot inside service hours in the next ${inst.delivery.horizonDays} days`,
              );
            }
            chosen = { mailId, driver: slot.driver, calendarId: slot.calendarId, region: slot.region, start: slot.start, end: slot.end };
          }

          const eventId = await bookTrip(inst, args, ledger, order, chosen);
          void sweepSlips(config.slipDir, config.slipRetentionDays);

          // Minimal confirmation (customer IT, 2026-10-07): enough to confirm
          // success and act on it -- the booking ref, the calendar event id,
          // and which driver has it. No event link, file path, address-derived
          // zone, or trip time: those live on the calendar event.
          return {
            booking_ref: `order-${orderRef(mailId)}`,
            event_id: eventId,
            driver: chosen.driver,
            region_match: zone ? chosen.region?.trim().toLowerCase() === zone.trim().toLowerCase() : null,
          };
        },
      });
    }

    case "plan_preview":
      return runAction({
        ...base,
        action: "plan_preview",
        auditParams: { since_days: args.since_days ?? 3, from_day: args.from_day ?? 1 },
        execute: async () => {
          const plan = await buildPlan();
          return {
            booked_by: inst.delivery.bookBy,
            backlog_size: plan.pool.length,
            proposed: plan.assignments.map((a) => ({
              ref: `order-${orderRef(a.mailId)}`,
              mail_id: a.mailId,
              driver: a.driver,
              region_match: a.regionMatch,
            })),
            boards: plan.boards,
            unassigned: plan.unassigned,
            malformed: plan.malformed,
            mail_ids: plan.assignments.map((a) => a.mailId),
            next: "nothing is booked yet -- to book exactly these requests, call plan_ahead with this mail_ids list",
          };
        },
      });

    case "plan_ahead": {
      // Live backlog booking books a NAMED list, and the confirmation is
      // bound to that list (customer IT review, 2026-10-07): without it, a
      // confirmation approved "whatever is in the mailbox" -- unseen, and
      // including mail that arrived between the two steps.
      if (args.mode === "live" && !args.mail_ids?.length) {
        return errorResult("live plan_ahead books a named list: run plan_preview first, review it, and pass its mail_ids");
      }
      return runAction({
        ...base,
        action: "plan_ahead",
        auditParams: { since_days: args.since_days ?? 3, from_day: args.from_day ?? 1, mail_ids: args.mail_ids ?? null },
        execute: async () => {
          const plan = await buildPlan(args.mail_ids);

          // Book each trip on its driver's calendar.
          const booked: Record<string, unknown>[] = [];
          const failed: Record<string, unknown>[] = [];
          for (const a of plan.assignments) {
            const p = plan.pool.find((x) => x.mailId === a.mailId)!;
            try {
              const eventId = await bookTrip(inst, args, ledger, p.order, a);
              booked.push({ ref: `order-${orderRef(a.mailId)}`, event_id: eventId, driver: a.driver, region_match: a.regionMatch });
            } catch (err) {
              failed.push({ ref: `order-${orderRef(a.mailId)}`, error: (err as Error).message.slice(0, 140) });
            }
          }
          void sweepSlips(config.slipDir, config.slipRetentionDays);

          return {
            booked_by: inst.delivery.bookBy,
            backlog_size: plan.pool.length,
            boards: plan.boards,
            booked,
            failed,
            unassigned: plan.unassigned,
            malformed: plan.malformed,
            skipped: plan.skipped,
            note: "PHI-blind: refs, drivers and zone counts only -- names, addresses and trip times are on the calendar events",
          };
        },
      });
    }

    case "cancel": {
      const missing = requireFields(args, ["mail_id"]);
      if (missing) return errorResult(missing);
      return runAction({
        ...base,
        action: "cancel",
        auditParams: { mail_id: args.mail_id },
        execute: async () => {
          const job = await ledger.get(args.instance, args.mode, args.mail_id!);
          if (!job || job.state === "seen") throw new Error("no scheduled job for that mail id");
          let eventAlreadyGone = false;
          if (job.eventId && job.calendarId) {
            try {
              await deleteEvent(inst, job.calendarId, job.eventId);
            } catch (err) {
              // Someone deleted the event by hand in Google Calendar. The
              // trip is already off the driver's day; reopen the job rather
              // than leave it stuck "scheduled" forever.
              if (!(err instanceof UpstreamError && (err.status === 404 || err.status === 410))) throw err;
              eventAlreadyGone = true;
            }
          }
          // Back to seen: the email can be scheduled again. Append-only means
          // the history of the original booking survives the cancel.
          await ledger.append({ instance: args.instance, mode: args.mode, mailId: args.mail_id!, state: "seen" });
          return { cancelled_event: job.eventId ?? null, was_state: job.state, event_already_gone: eventAlreadyGone };
        },
      });
    }

    default:
      return errorResult(`Unknown action: ${args.action satisfies never}`);
  }
}

export function registerCalendarTool(server: McpServer): void {
  server.registerTool(
    "errand_calendar",
    {
      title: "Driver scheduling",
      description:
        "Book transport-request trips onto drivers' Google Calendars -- the booking IS the driver assignment. Every action takes only ids; the server reads the request email itself (PHI-blind: member name, addresses, and trip times never pass through the operator layer or come back in results). `freebusy` reports live roster availability and the soonest open slot. `schedule` (mail_id) books one request: on appointment-time instances (the default) the trip runs from the request's stated pick-up time to its appointment time -- if no driver is free for exactly that window it is NOT booked and comes back for a human call, never moved to another time; it prefers a driver covering the request's zone (pin `driver` or override `region` to steer). `plan_preview` (read-only) proposes how the unscheduled backlog would be booked -- refs, drivers, a per-date board, and the refs that could not be booked and why -- and returns the mail_ids to pass on; `plan_ahead` books it the same way (in live mode it requires that mail_ids list, and its confirmation is bound to it). `cancel` deletes a booking and reopens the job. In live mode schedule, plan_ahead, and cancel each require a two-step confirmation. Results carry booking refs, event ids, and driver names only.",
      inputSchema: inputShape,
    },
    handleCalendar,
  );
}
