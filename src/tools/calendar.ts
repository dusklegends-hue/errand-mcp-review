import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { deleteEvent, freeBusy, insertEvent } from "../calendar/google.js";
import { findSoonestSlot, type DriverAvailability } from "../calendar/slots.js";
import { config, getInstance, type InstanceConfig } from "../config.js";
import { getAttachment, getMessageBody, listInbox } from "../mail/graph.js";
import { fileSlip, orderRef } from "../slips/slips.js";
import { hourSlotsByDay, planAhead } from "../calendar/plan.js";
import { sweepSlips } from "../util/retention.js";
import { parseOrder, regionForAddress } from "../mail/order.js";
import { Ledger } from "../ledger/ledger.js";
import type { Mode } from "../gate/types.js";
import { formatLocal } from "../util/tz.js";
import { commonShape, errorResult, requireFields, runAction, type CommonArgs } from "./shared.js";

const ACTIONS = ["freebusy", "schedule", "plan_ahead", "cancel"] as const;

const inputShape = {
  ...commonShape,
  action: z.enum(ACTIONS),
  /** The Graph message id this job is for -- the ledger key. */
  mail_id: z.string().min(1).optional(),
  // PHI-blind (2026-09-01): member / pickup_from / deliver_to are
  // DELIBERATELY not arguments. The server reads them out of the order
  // email itself, so member data never passes through the operator layer.
  /** Pin a specific driver instead of auto-picking the soonest free one. */
  driver: z.string().max(100).optional(),
  /** Delivery zone ("central", "east", ...). Prefers drivers whose roster
   *  region matches; falls back to the whole roster if none are free. */
  region: z.string().max(60).optional(),
  /** plan_ahead: how many days back to scan the mailbox for backlog (default 3). */
  since_days: z.number().int().min(1).max(14).optional(),
  /** plan_ahead: first day to fill -- 1 = tomorrow (default), 0 = later today. */
  from_day: z.number().int().min(0).max(7).optional(),
};

interface Args extends CommonArgs {
  action: (typeof ACTIONS)[number];
  mail_id?: string;
  driver?: string;
  region?: string;
  since_days?: number;
  from_day?: number;
}

/** Live availability for the mode's roster: one freebusy query, busy never cached. */
async function rosterAvailability(inst: InstanceConfig, mode: Mode): Promise<DriverAvailability[]> {
  const roster = inst[mode]!.roster;
  const now = new Date();
  const timeMax = new Date(now.getTime() + (inst.delivery.horizonDays + 1) * 86_400_000);
  const busyByCal = await freeBusy(
    inst,
    roster.map((r) => r.calendarId),
    now.toISOString(),
    timeMax.toISOString(),
  );
  return roster.map((r) => ({
    driver: r.driver,
    calendarId: r.calendarId,
    region: r.region,
    busy: busyByCal.get(r.calendarId) ?? [],
  }));
}

export async function handleCalendar(args: Args): Promise<CallToolResult> {
  const inst = getInstance(args.instance);
  if (!inst) return errorResult(`Unknown instance "${args.instance}". Configured: ${[...config.instances.keys()].join(", ")}`);

  const ledger = new Ledger(config.ledgerPath);
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
    timeZone: inst.serviceHours.timeZone,
  });

  switch (args.action) {
    case "freebusy":
      return runAction({
        ...base,
        action: "freebusy",
        auditParams: {},
        execute: async () => {
          const drivers = await rosterAvailability(inst, args.mode);
          const slot = findSoonestSlot(drivers, slotQuery());
          return {
            drivers: drivers.map((d) => ({ driver: d.driver, region: d.region ?? null, busy_blocks: d.busy.length })),
            soonest_slot: slot
              ? {
                  driver: slot.driver,
                  start: slot.start.toISOString(),
                  end: slot.end.toISOString(),
                  local: formatLocal(slot.start, inst.serviceHours.timeZone),
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
          const existing = await ledger.get(args.instance, args.mode, args.mail_id!);
          if (existing && existing.state !== "seen") {
            // The double-dispatch wall: an email already scheduled or
            // dispatched is refused, not re-booked. `cancel` is the way back.
            throw new Error(
              `job for this email is already "${existing.state}" (driver ${existing.driver ?? "?"}, slot ${existing.slotStart ?? "?"}) -- cancel it first if this is a re-book`,
            );
          }

          // PHI-blind extraction: the server reads the request email itself.
          const msg = await getMessageBody(inst, args.mail_id!);
          const parsed = parseOrder(msg.bodyText);
          if (!parsed.order) {
            throw new Error(
              `order email is missing labeled field(s): ${parsed.missing.join(", ")} -- ` +
                `expected lines like "Member's Name: ...", "Pick-Up: ...", "Destination: ..." ` +
                `(PHI-blind mode reads these from the email server-side; they are not arguments)`,
            );
          }
          const { member, pickupFrom, deliverTo } = parsed.order;
          const zone = args.region ?? regionForAddress(deliverTo, inst.regions);

          let drivers = await rosterAvailability(inst, args.mode);
          if (args.driver) {
            drivers = drivers.filter((d) => d.driver.toLowerCase() === args.driver!.toLowerCase());
            if (drivers.length === 0) throw new Error(`driver "${args.driver}" is not on the ${args.mode} roster`);
          }
          // Region preference (Josh, 2026-09-01): east-side jobs go to
          // east-side drivers. A pinned driver overrides region; an empty
          // match falls back to the whole roster, because a delivery by the
          // "wrong" zone's driver beats no delivery at all.
          let regionMatch = false;
          if (zone && !args.driver) {
            const want = zone.trim().toLowerCase();
            const inZone = drivers.filter((d) => d.region?.trim().toLowerCase() === want);
            if (inZone.length > 0) {
              drivers = inZone;
              regionMatch = true;
            }
          }
          const slot = findSoonestSlot(drivers, slotQuery());
          if (!slot) {
            throw new Error(
              `no free ${inst.delivery.durationMinutes}-minute slot inside service hours in the next ${inst.delivery.horizonDays} days`,
            );
          }

          const deliverBy = formatLocal(slot.end, inst.serviceHours.timeZone);
          const created = await insertEvent(inst, inst[args.mode]!.scheduleCalendarId, {
            summary: `Transport: ${member} (${slot.driver})`,
            description: `Collect from ${pickupFrom}.\nDeliver to ${deliverTo} by ${deliverBy}.\nOrder ref: order-${orderRef(args.mail_id!)}`,
            startISO: slot.start.toISOString(),
            endISO: slot.end.toISOString(),
          });

          await ledger.append({
            instance: args.instance,
            mode: args.mode,
            mailId: args.mail_id!,
            state: "scheduled",
            driver: slot.driver,
            slotStart: slot.start.toISOString(),
            slotEnd: slot.end.toISOString(),
            eventId: created.id,
            calendarId: inst[args.mode]!.scheduleCalendarId,
          });

          // File the slip photo where the scheduler grabs it:
          // data/slips/<local date>/<driver>/. Best-effort -- an order with
          // no photo still books. This folder is the ONE place PHI rests on
          // this machine, and it is swept after the retention window.
          let slipFile: string | null = null;
          try {
            const att = await getAttachment(inst, args.mail_id!);
            slipFile = await fileSlip(
              config.slipDir,
              {
                driver: slot.driver,
                startISO: slot.start.toISOString(),
                timeZone: inst.serviceHours.timeZone,
                mailId: args.mail_id!,
                contentType: att.contentType,
              },
              att.bytes,
            );
            void sweepSlips(config.slipDir, config.slipRetentionDays);
          } catch {
            /* no image attachment or transient fetch failure */
          }

          return {
            driver: slot.driver,
            slip_file: slipFile,
            region_used: zone ?? null,
            region_match: zone ? regionMatch : null,
            slot: { start: slot.start.toISOString(), end: slot.end.toISOString(), local: formatLocal(slot.start, inst.serviceHours.timeZone) },
            event: created,
            next: "scheduled -- the booking on the driver's calendar is the assignment",
          };
        },
      });
    }

    case "plan_ahead": {
      return runAction({
        ...base,
        action: "plan_ahead",
        auditParams: { since_days: args.since_days ?? 3, from_day: args.from_day ?? 1 },
        execute: async () => {
          // 1. The backlog: recent, labeled, not yet scheduled. All parsing
          //    is server-side (PHI-blind); mail with no labeled lines at all
          //    is ignored silently, partially-labeled mail is reported by
          //    ref so a human can fix the email.
          const mail = await listInbox(inst, { limit: 50, sinceDays: args.since_days ?? 3 });
          const jobs = await ledger.load();
          const pool: { mailId: string; region: string | null; order: { member: string; pickupFrom: string; deliverTo: string } }[] = [];
          const malformed: { ref: string; missing: string[] }[] = [];
          for (const m of mail) {
            const state = jobs.get(`${args.instance}:${args.mode}:${m.id}`)?.state ?? null;
            if (state === "scheduled" || state === "dispatched") continue;
            const msg = await getMessageBody(inst, m.id);
            const parsed = parseOrder(msg.bodyText);
            if (parsed.order) {
              pool.push({ mailId: m.id, region: regionForAddress(parsed.order.deliverTo, inst.regions), order: parsed.order });
            } else if (parsed.missing.length < 3) {
              malformed.push({ ref: `order-${orderRef(m.id)}`, missing: parsed.missing });
            }
          }

          // 2. Lay the backlog across the days ahead: earliest day first,
          //    a computed side of town per driver per day, overflow rolls
          //    forward, the rest comes back unassigned.
          const drivers = await rosterAvailability(inst, args.mode);
          const daysAhead = hourSlotsByDay(drivers, slotQuery(), args.from_day ?? 1, inst.delivery.horizonDays);
          const plan = planAhead(pool.map((p) => ({ mailId: p.mailId, region: p.region })), daysAhead);

          // 3. Book the boards: driver's own calendar, an hour per order.
          const booked: Record<string, unknown>[] = [];
          const failed: Record<string, unknown>[] = [];
          for (const a of plan.assignments) {
            const p = pool.find((x) => x.mailId === a.mailId)!;
            try {
              const deliverBy = formatLocal(a.end, inst.serviceHours.timeZone);
              const created = await insertEvent(inst, a.calendarId, {
                summary: `Transport: ${p.order.member} (${a.driver})`,
                description: `Collect from ${p.order.pickupFrom}.\nDeliver to ${p.order.deliverTo} by ${deliverBy}.\nOrder ref: order-${orderRef(a.mailId)}`,
                startISO: a.start.toISOString(),
                endISO: a.end.toISOString(),
              });
              await ledger.append({
                instance: args.instance,
                mode: args.mode,
                mailId: a.mailId,
                state: "scheduled",
                driver: a.driver,
                slotStart: a.start.toISOString(),
                slotEnd: a.end.toISOString(),
                eventId: created.id,
                calendarId: a.calendarId,
              });
              try {
                const att = await getAttachment(inst, a.mailId);
                await fileSlip(
                  config.slipDir,
                  { driver: a.driver, startISO: a.start.toISOString(), timeZone: inst.serviceHours.timeZone, mailId: a.mailId, contentType: att.contentType },
                  att.bytes,
                );
              } catch { /* slip is best-effort */ }
              booked.push({
                ref: `order-${orderRef(a.mailId)}`,
                date: a.date,
                driver: a.driver,
                region: a.region ?? "unzoned",
                region_match: a.regionMatch,
                slot: formatLocal(a.start, inst.serviceHours.timeZone),
              });
            } catch (err) {
              failed.push({ ref: `order-${orderRef(a.mailId)}`, error: (err as Error).message.slice(0, 140) });
            }
          }
          void sweepSlips(config.slipDir, config.slipRetentionDays);

          return {
            backlog_size: pool.length,
            boards: plan.boards,
            booked,
            failed,
            unassigned: plan.unassigned.map((u) => ({ ref: `order-${orderRef(u.mailId)}`, region: u.region ?? "unzoned", reason: u.reason })),
            malformed,
            note: "PHI-blind: refs and zones only -- names and addresses are on the calendar events and slips",
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
          if (job.eventId && job.calendarId) {
            await deleteEvent(inst, job.calendarId, job.eventId);
          }
          // Back to seen: the email can be scheduled again. The dispatched
          // wamid (if any) is kept on the old line -- append-only means the
          // history of what was sent survives the cancel.
          await ledger.append({ instance: args.instance, mode: args.mode, mailId: args.mail_id!, state: "seen" });
          return { cancelled_event: job.eventId ?? null, was_state: job.state };
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
        "Find and book the soonest free driver on the instance's roster via Google Calendar. `freebusy` reports live availability and the soonest workable slot; `schedule` takes ONLY the mail_id -- the server reads the request email itself (PHI-blind: member name and addresses never pass through the operator layer), derives the delivery zone from the instance's region map, prefers a driver covering that zone (pin `driver` or override `region` to steer), books the slot and records the job; `plan_ahead` schedules the BACKLOG days in advance: it gathers unscheduled labeled orders, zones them by delivery ZIP, gives each driver a side of town per day computed from where the orders cluster, books back-to-back hour slots on each driver's calendar starting tomorrow (from_day 0 = later today), and rolls overflow to the next day -- a PHI-blind board per date comes back. `cancel` deletes the booking and reopens the job. The calendar booking IS the driver assignment. In test mode `schedule` writes only to the scratch calendar.",
      inputSchema: inputShape,
    },
    handleCalendar,
  );
}
