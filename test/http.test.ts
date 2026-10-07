import { afterEach, describe, expect, it, vi } from "vitest";
import { extractErrorCode, request } from "../src/util/http.js";

afterEach(() => vi.unstubAllGlobals());

const respond = (status: number, body: string) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "content-type": "application/json" } })));

describe("upstream errors carry status and code, never upstream text", () => {
  it("drops a Graph message that quotes the search (it may be a member's name)", async () => {
    respond(400, JSON.stringify({ error: { code: "BadRequest", message: 'Syntax error: character \'"\' near "Rita Reyes"' } }));
    const err = await request("Microsoft Graph", "https://graph.example/x").catch((e: Error) => e);
    expect((err as Error).message).toBe("Microsoft Graph: HTTP 400 BadRequest");
  });

  it("takes Google's reason code, not its message", () => {
    expect(
      extractErrorCode({ error: { code: 404, status: "NOT_FOUND", message: "Event Rita Reyes not found", errors: [{ reason: "notFound" }] } }),
    ).toBe("notFound");
  });

  it("reduces anything free-text-shaped to a token", () => {
    expect(extractErrorCode({ error: "invalid_grant" })).toBe("invalid_grant");
    expect(extractErrorCode({ error: "invalid grant: Rita Reyes" })).toBe("unknown");
    expect(extractErrorCode("plain text body")).toBe("unknown");
  });

  it("does not quote a malformed success body", async () => {
    respond(200, "<html>Rita Reyes</html>");
    const err = await request("Google Calendar", "https://cal.example/x").catch((e: Error) => e);
    expect((err as Error).message).toBe("Google Calendar: HTTP 200 invalid_json");
  });
});
