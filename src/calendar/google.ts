import { getGoogleAccessToken } from "../auth/googleTokens.js";
import type { InstanceConfig } from "../config.js";
import { request } from "../util/http.js";

const CAL = "https://www.googleapis.com/calendar/v3";
const UPSTREAM = "Google Calendar";

export interface BusyBlock {
  start: string;
  end: string;
}

async function authHeaders(inst: InstanceConfig): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await getGoogleAccessToken(inst)}`,
    "Content-Type": "application/json",
  };
}

/** One query across the whole roster at once -- freebusy.query takes a list. */
export async function freeBusy(
  inst: InstanceConfig,
  calendarIds: string[],
  timeMin: string,
  timeMax: string,
): Promise<Map<string, BusyBlock[]>> {
  const { json } = await request(UPSTREAM, `${CAL}/freeBusy`, {
    method: "POST",
    headers: await authHeaders(inst),
    body: JSON.stringify({ timeMin, timeMax, items: calendarIds.map((id) => ({ id })) }),
  });
  const calendars = ((json as Record<string, unknown>).calendars ?? {}) as Record<
    string,
    { busy?: BusyBlock[]; errors?: unknown[] }
  >;
  const out = new Map<string, BusyBlock[]>();
  for (const id of calendarIds) {
    // A calendar the token cannot see comes back with an errors array and no
    // busy list. Treating that as "free all day" would book a driver whose
    // calendar we cannot actually read -- fail loudly instead.
    const entry = calendars[id];
    if (!entry || entry.errors?.length) {
      throw new Error(`${UPSTREAM}: freebusy could not read calendar ${id} (not shared with this account?)`);
    }
    out.set(id, entry.busy ?? []);
  }
  return out;
}

export interface CreatedEvent {
  id: string;
  htmlLink: string;
}

export async function insertEvent(
  inst: InstanceConfig,
  calendarId: string,
  event: { summary: string; description: string; startISO: string; endISO: string },
): Promise<CreatedEvent> {
  const { json } = await request(
    UPSTREAM,
    `${CAL}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: await authHeaders(inst),
      body: JSON.stringify({
        summary: event.summary,
        description: event.description,
        start: { dateTime: event.startISO },
        end: { dateTime: event.endISO },
        // The description carries member name + addresses; force the event
        // private so PHI never inherits a calendar's wider default sharing.
        visibility: "private",
      }),
    },
  );
  const created = json as Record<string, unknown>;
  return { id: String(created.id), htmlLink: String(created.htmlLink ?? "") };
}

export async function getEvent(inst: InstanceConfig, calendarId: string, eventId: string): Promise<Record<string, unknown>> {
  const { json } = await request(
    UPSTREAM,
    `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { headers: await authHeaders(inst) },
  );
  return json as Record<string, unknown>;
}

export async function deleteEvent(inst: InstanceConfig, calendarId: string, eventId: string): Promise<void> {
  await request(
    UPSTREAM,
    `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE", headers: await authHeaders(inst) },
  );
}
