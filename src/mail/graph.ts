import { getMsAccessToken } from "../auth/msTokens.js";
import { stripHtml } from "./order.js";
import type { InstanceConfig } from "../config.js";
import { UpstreamError, request } from "../util/http.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const UPSTREAM = "Microsoft Graph";

export interface MailSummary {
  id: string;
  subject: string;
  from: string | null;
  received: string;
  hasAttachments: boolean;
  bodyPreview: string;
}

async function authHeaders(inst: InstanceConfig): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await getMsAccessToken(inst)}` };
}

export async function listInbox(
  inst: InstanceConfig,
  opts: { limit: number; sinceDays: number; search?: string },
): Promise<MailSummary[]> {
  const select = "$select=id,subject,from,receivedDateTime,hasAttachments,bodyPreview";
  let url: string;
  if (opts.search) {
    // Graph refuses $search combined with $filter/$orderby (the discord-mcp
    // lesson), so the date window is applied client-side below.
    url = `${GRAPH}/me/mailFolders/inbox/messages?$search=${encodeURIComponent(`"${opts.search}"`)}&$top=${opts.limit}&${select}`;
  } else {
    const since = new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString();
    url = `${GRAPH}/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${since}&$orderby=receivedDateTime desc&$top=${opts.limit}&${select}`;
  }
  const { json } = await request(UPSTREAM, url, { headers: await authHeaders(inst) });
  const cutoff = Date.now() - opts.sinceDays * 86_400_000;
  const value = ((json as { value?: unknown[] }).value ?? []) as Record<string, unknown>[];
  return value
    .map((m) => ({
      id: String(m.id),
      subject: String(m.subject ?? ""),
      from: ((m.from as Record<string, unknown> | undefined)?.emailAddress as Record<string, unknown> | undefined)
        ?.address as string | null ?? null,
      received: String(m.receivedDateTime ?? ""),
      hasAttachments: Boolean(m.hasAttachments),
      bodyPreview: String(m.bodyPreview ?? ""),
    }))
    .filter((m) => !opts.search || (m.received && Date.parse(m.received) >= cutoff));
}

export interface AttachmentBytes {
  attachmentId: string;
  name: string;
  contentType: string;
  bytes: Buffer;
}

/**
 * Pulls the slip photo. Without an explicit attachment id, takes the first
 * image attachment -- a transport-request mail has exactly one photo in the
 * expected case, and callers who hit the unexpected case get the full list
 * in the error to pick from.
 */
export async function getAttachment(
  inst: InstanceConfig,
  messageId: string,
  attachmentId?: string,
): Promise<AttachmentBytes> {
  const headers = await authHeaders(inst);
  const listUrl = `${GRAPH}/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size`;
  const { json } = await request(UPSTREAM, listUrl, { headers });
  const all = ((json as { value?: unknown[] }).value ?? []) as Record<string, unknown>[];

  let target: Record<string, unknown> | undefined;
  if (attachmentId) {
    target = all.find((a) => a.id === attachmentId);
    if (!target) {
      throw new UpstreamError(UPSTREAM, 404, "attachment_not_found", `no attachment ${attachmentId} on that message`, false);
    }
  } else {
    target = all.find((a) => String(a.contentType ?? "").startsWith("image/"));
    if (!target) {
      const listing = all.map((a) => `${a.id} (${a.contentType})`).join(", ") || "none";
      throw new UpstreamError(
        UPSTREAM,
        404,
        "no_image_attachment",
        `message has no image attachment; attachments present: ${listing}`,
        false,
      );
    }
  }

  // /$value returns the raw bytes and skips the base64 decode entirely.
  const rawUrl = `${GRAPH}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(String(target.id))}/$value`;
  const { bytes } = await request(UPSTREAM, rawUrl, { headers, expectJson: false });
  return {
    attachmentId: String(target.id),
    name: String(target.name ?? "attachment"),
    contentType: String(target.contentType ?? "application/octet-stream"),
    bytes: bytes!,
  };
}

export interface MessageBody {
  subject: string;
  bodyText: string;
}

/** Full body fetch for server-side order parsing (PHI-blind mode). */
export async function getMessageBody(inst: InstanceConfig, messageId: string): Promise<MessageBody> {
  const url = `${GRAPH}/me/messages/${encodeURIComponent(messageId)}?$select=subject,body`;
  const { json } = await request(UPSTREAM, url, { headers: await authHeaders(inst) });
  const m = json as Record<string, unknown>;
  const body = (m.body ?? {}) as Record<string, unknown>;
  const content = String(body.content ?? "");
  const isHtml = String(body.contentType ?? "").toLowerCase() === "html";
  return { subject: String(m.subject ?? ""), bodyText: isHtml ? stripHtml(content) : content };
}
