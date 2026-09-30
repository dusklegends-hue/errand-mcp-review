import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config, getInstance } from "../config.js";
import { buildListEnvelope, spillBinaryHandle } from "../envelope/envelope.js";
import { Ledger } from "../ledger/ledger.js";
import { getAttachment, listInbox } from "../mail/graph.js";
import { maskOrderPii } from "../mail/order.js";
import { commonShape, errorResult, ok, requireFields, runAction, type CommonArgs } from "./shared.js";

const ACTIONS = ["list", "get_attachment"] as const;

const inputShape = {
  ...commonShape,
  action: z.enum(ACTIONS),
  mail_id: z.string().min(1).optional(),
  attachment_id: z.string().min(1).optional(),
  /** Graph $search (KQL). Omitted, list reads the recent inbox. */
  query: z.string().max(500).optional(),
  since_days: z.number().int().min(1).max(90).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  /**
   * "handle" (default) writes the image to disk and returns a reference;
   * "inline" returns it as an image content block for actually reading the
   * slip. Inline is the expensive one -- it sits in context for the rest of
   * the session -- so it is opt-in per call, never the default.
   */
  disposition: z.enum(["handle", "inline"]).optional(),
};

interface Args extends CommonArgs {
  action: (typeof ACTIONS)[number];
  mail_id?: string;
  attachment_id?: string;
  query?: string;
  since_days?: number;
  limit?: number;
  disposition?: "handle" | "inline";
}

const DEFAULT_LIMIT = 15;
const DEFAULT_SINCE_DAYS = 7;

export async function handleEmail(args: Args): Promise<CallToolResult> {
  const inst = getInstance(args.instance);
  if (!inst) return errorResult(`Unknown instance "${args.instance}". Configured: ${[...config.instances.keys()].join(", ")}`);

  const ledger = new Ledger(config.ledgerPath);
  const base = {
    tool: "errand_email",
    instance: args.instance,
    mode: args.mode,
    confirmToken: args.confirm_token,
  };

  switch (args.action) {
    case "list": {
      const limit = args.limit ?? DEFAULT_LIMIT;
      const sinceDays = args.since_days ?? DEFAULT_SINCE_DAYS;
      return runAction({
        ...base,
        action: "list",
        auditParams: { query: args.query ?? null, since_days: sinceDays, limit },
        execute: async () => {
          const [mail, jobs] = await Promise.all([
            listInbox(inst, { limit, sinceDays, search: args.query }),
            ledger.load(),
          ]);
          // Each message carries its pipeline state, so "which of these have
          // I already dispatched" never needs a second tool call.
          const items = mail.map((m) => ({
            ...m,
            // PHI-blind: labeled order values are masked in previews.
            bodyPreview: maskOrderPii(m.bodyPreview),
            job_state: jobs.get(`${args.instance}:${args.mode}:${m.id}`)?.state ?? null,
          }));
          return buildListEnvelope(items, "messages");
        },
      });
    }

    case "get_attachment": {
      const missing = requireFields(args, ["mail_id"]);
      if (missing) return errorResult(missing);
      const disposition = args.disposition ?? "handle";
      return runAction({
        ...base,
        action: "get_attachment",
        auditParams: { mail_id: args.mail_id, attachment_id: args.attachment_id ?? null, disposition },
        execute: async () => {
          const att = await getAttachment(inst, args.mail_id!, args.attachment_id);
          // First touch of a message marks it seen, so the ledger records the
          // pipeline started even if scheduling never happens.
          const existing = await ledger.get(args.instance, args.mode, args.mail_id!);
          if (!existing) {
            await ledger.append({ instance: args.instance, mode: args.mode, mailId: args.mail_id!, state: "seen" });
          }
          if (disposition === "inline") {
            return {
              inline: true,
              attachment_id: att.attachmentId,
              name: att.name,
              content_type: att.contentType,
              base64: att.bytes.toString("base64"),
            };
          }
          const spilled = await spillBinaryHandle(att.bytes, att.contentType);
          return { attachment_id: att.attachmentId, name: att.name, ...spilled };
        },
        resultContent: (result) => {
          const r = result as Record<string, unknown>;
          if (r.inline) {
            return {
              content: [
                { type: "image", data: r.base64 as string, mimeType: r.content_type as string },
                {
                  type: "text",
                  text: JSON.stringify(
                    { status: "ok", attachment_id: r.attachment_id, name: r.name, content_type: r.content_type },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          return ok({ status: "ok", ...r });
        },
      });
    }

    default:
      return errorResult(`Unknown action: ${args.action satisfies never}`);
  }
}

export function registerEmailTool(server: McpServer): void {
  server.registerTool(
    "errand_email",
    {
      title: "Transport request mail",
      description:
        "Read transport-request emails from the instance's Outlook mailbox. `list` shows recent inbox messages with their pipeline state; `get_attachment` pulls the request-form photo -- as a disk handle by default, or as an inline image block with disposition:\"inline\" when the form needs to be read. Labeled request values in previews are masked (PHI-blind). Read-only: nothing here can send, move, or delete mail.",
      inputSchema: inputShape,
    },
    handleEmail,
  );
}
