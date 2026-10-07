/**
 * What the operator layer is allowed to see of an email (2026-10-07, after
 * the customer IT review): nothing the sender typed. No subject, no body
 * text, no preview, no attachment file name -- every one of those is
 * sender-controlled, can carry member data, and can carry text aimed at the
 * assistant itself. The operator gets server-derived facts instead: a
 * reference, when it arrived, which organization sent it, and whether the
 * request is complete enough to book.
 *
 * Pure, config-free, testable without a token.
 */
import { orderRef, slipExt } from "../slips/slips.js";
import { parseOrder } from "./order.js";

export interface MailMessage {
  id: string;
  /** Sender address. Server-side only -- the listing exposes its domain. */
  from: string | null;
  received: string;
  hasAttachments: boolean;
  /** Full body as text. PHI. Never leaves the server. */
  bodyText: string;
}

export interface SafeListing {
  mail_id: string;
  ref: string;
  received: string;
  from_domain: string | null;
  has_attachments: boolean;
  /** complete = bookable; incomplete = some labeled fields present, `missing` names the rest; none = not a request. */
  request: "complete" | "incomplete" | "none";
  missing?: string[];
}

/** The sender's domain, lowercased, reduced to hostname characters. */
export function senderDomain(address: string | null): string | null {
  const at = address?.lastIndexOf("@") ?? -1;
  if (!address || at < 0) return null;
  const domain = address.slice(at + 1).toLowerCase().replace(/[^a-z0-9.-]/g, "");
  return domain || null;
}

export function safeListing(m: MailMessage, requireAppointment: boolean): SafeListing {
  const parsed = parseOrder(m.bodyText, { requireAppointment });
  const request = parsed.order ? "complete" : parsed.found > 0 ? "incomplete" : "none";
  return {
    mail_id: m.id,
    ref: `order-${orderRef(m.id)}`,
    received: m.received,
    from_domain: senderDomain(m.from),
    has_attachments: m.hasAttachments,
    request,
    ...(request === "incomplete" ? { missing: parsed.missing } : {}),
  };
}

/** A MIME type as the sender declared it is sender-controlled text too; pass only the well-formed shape. */
export function safeContentType(contentType: string): string {
  const t = contentType.trim().toLowerCase();
  return /^[a-z]+\/[a-z0-9.+-]{1,60}$/.test(t) ? t : "application/octet-stream";
}

/** The neutral name an attachment is reported under: the request's ref, never the sender's file name. */
export function neutralAttachmentName(mailId: string, contentType: string): string {
  return `order-${orderRef(mailId)}.${slipExt(safeContentType(contentType))}`;
}
