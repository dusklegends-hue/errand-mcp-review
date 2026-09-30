import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export interface ListEnvelope<T> {
  summary: string;
  preview: T[];
  truncated: boolean;
  handle?: string;
  count: number;
}

const INLINE_PREVIEW_ITEMS = 10;

let handleDirEnsured = false;
async function ensureHandleDir(): Promise<void> {
  if (handleDirEnsured) return;
  await mkdir(config.handleDir, { recursive: true });
  handleDirEnsured = true;
}

/**
 * The universal read-side result contract: small results come back fully
 * inline; results whose serialized size exceeds the configured byte
 * threshold spill to a handle file instead, with only a small preview
 * returned inline. Threshold is size-based, not row-count-based.
 */
export async function buildListEnvelope<T>(items: T[], summaryLabel: string): Promise<ListEnvelope<T>> {
  const serialized = JSON.stringify(items);
  const byteSize = Buffer.byteLength(serialized, "utf8");

  if (byteSize <= config.maxInlineBytes) {
    return {
      summary: `${items.length} ${summaryLabel}`,
      preview: items,
      truncated: false,
      count: items.length,
    };
  }

  await ensureHandleDir();
  const handle = randomUUID();
  await writeFile(path.join(config.handleDir, `${handle}.json`), serialized, "utf8");

  return {
    summary: `${items.length} ${summaryLabel} (showing first ${INLINE_PREVIEW_ITEMS} inline -- full result spilled, use errand_fetch_handle to retrieve it)`,
    preview: items.slice(0, INLINE_PREVIEW_ITEMS),
    truncated: true,
    handle,
    count: items.length,
  };
}

/**
 * Binary spill for the attachment path (build plan, "the photo is the
 * expensive part"): an image inlined into a tool result is re-billed every
 * later turn it sits in context, so the slip goes to disk by default and is
 * inlined only on the one call that actually needs to read it.
 */
export async function spillBinaryHandle(
  bytes: Buffer,
  contentType: string,
): Promise<{ handle: string; path: string; bytes: number; content_type: string }> {
  await ensureHandleDir();
  const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  const handle = randomUUID();
  const filePath = path.join(config.handleDir, `${handle}.${ext}`);
  await writeFile(filePath, bytes);
  return { handle, path: filePath, bytes: bytes.length, content_type: contentType };
}
