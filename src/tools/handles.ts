import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config, getInstance } from "../config.js";
import { commonShape, errorResult, ok, runAction, type CommonArgs } from "./shared.js";

const inputShape = {
  ...commonShape,
  handle: z.string().uuid(),
};

interface Args extends CommonArgs {
  handle: string;
}

/**
 * Retrieves a spilled envelope or attachment by handle. JSON handles come
 * back as text; image handles come back as an image content block (fetching
 * a handle IS the one call that needs the image inline).
 */
export async function handleFetchHandle(args: Args): Promise<CallToolResult> {
  return runAction({
    tool: "errand_fetch_handle",
    action: "get",
    instance: args.instance,
    mode: args.mode,
    confirmToken: args.confirm_token,
    auditParams: { handle: args.handle },
    execute: async () => {
      const files = await readdir(config.handleDir).catch(() => [] as string[]);
      const match = files.find((f) => f.startsWith(args.handle));
      if (!match) throw new Error(`no handle ${args.handle} (handles do not survive cleanup -- re-run the original call)`);
      const full = path.join(config.handleDir, match);
      const ext = path.extname(match).toLowerCase();
      if (ext === ".json") {
        return { kind: "json", text: await readFile(full, "utf8") };
      }
      // Image handles obey the same switch as get_attachment: with image view
      // off, no path returns a request image to the operator.
      if (!getInstance(args.instance)?.allowImageView) {
        throw new Error("viewing request images is disabled for this instance (PHI-blind)");
      }
      const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      return { kind: "image", base64: (await readFile(full)).toString("base64"), mime };
    },
    resultContent: (result) => {
      const r = result as Record<string, string>;
      if (r.kind === "json") return ok({ status: "ok", content: JSON.parse(r.text) });
      return {
        content: [{ type: "image", data: r.base64, mimeType: r.mime }],
      };
    },
  });
}

export function registerFetchHandleTool(server: McpServer): void {
  server.registerTool(
    "errand_fetch_handle",
    {
      title: "Fetch a spilled result",
      description:
        "Retrieve the full content behind a handle returned by another errand tool -- a spilled list, or the request-form image saved by get_attachment.",
      inputSchema: inputShape,
    },
    handleFetchHandle,
  );
}
