import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { configureConfirmTtl } from "./gate/confirmations.js";
import { registerAllTools } from "./tools/index.js";
import { sweepHandles, sweepSlips } from "./util/retention.js";

async function main(): Promise<void> {
  configureConfirmTtl(config.confirmTtlMs);

  // Retention sweeps: the slip folder and spilled handles are the only disk
  // locations that can carry PHI; both are time-limited by design. Swept at
  // startup AND daily thereafter — a long-lived process must not let the
  // retention window lapse just because nobody restarted it.
  const sweep = () => {
    void sweepSlips(config.slipDir, config.slipRetentionDays);
    void sweepHandles(config.handleDir, config.handleRetentionHours);
  };
  sweep();
  setInterval(sweep, 24 * 60 * 60 * 1000).unref();

  const server = new McpServer({ name: "errand-mcp", version: "0.1.0" });
  registerAllTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("errand-mcp: fatal error during startup", err);
  process.exitCode = 1;
});
