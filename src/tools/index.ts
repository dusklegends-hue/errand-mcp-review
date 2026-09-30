import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCalendarTool } from "./calendar.js";
import { registerEmailTool } from "./email.js";
import { registerFetchHandleTool } from "./handles.js";

/**
 * Two dense tools plus the handle fetcher. WhatsApp dispatch was REMOVED
 * 2026-09-01 (Josh's call): Meta signs no BAA, so messaging member details
 * over WhatsApp is HIPAA exposure for a healthcare customer. The product ends
 * at driver assignment -- `errand_calendar schedule` books the job onto the
 * chosen driver's calendar, and the calendar IS the dispatch.
 */
export function registerAllTools(server: McpServer): void {
  registerEmailTool(server);
  registerCalendarTool(server);
  registerFetchHandleTool(server);
}
