import { describe, it, expect, vi } from "vitest";
import { revoke } from "./revoke-token.mjs";

const res = (status) => ({ status, json: async () => null });

describe("revoke (#817)", () => {
  it("DELETEs /installation/token with the token itself", async () => {
    const fetchFn = vi.fn(async () => res(204));
    expect(await revoke("ghs_x", fetchFn)).toEqual({ revoked: true, message: "revoked the wrokin App token" });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.github.com/installation/token");
    expect(init.method).toBe("DELETE");
    expect(init.headers.authorization).toBe("Bearer ghs_x");
  });

  it("treats an already-dead token as revoked", async () => {
    expect((await revoke("ghs_x", async () => res(401))).revoked).toBe(true);
  });

  it("retries a 5xx or network error once, and not a 4xx", async () => {
    const flaky = vi.fn().mockResolvedValueOnce(res(502)).mockResolvedValueOnce(res(204));
    expect((await revoke("ghs_x", flaky)).revoked).toBe(true);
    expect(flaky).toHaveBeenCalledTimes(2);
    const offline = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(res(204));
    expect((await revoke("ghs_x", offline)).revoked).toBe(true);
    const forbidden = vi.fn(async () => res(403));
    expect((await revoke("ghs_x", forbidden)).revoked).toBe(false);
    expect(forbidden).toHaveBeenCalledTimes(1);
  });

  it("reports a failure without the token, and calls nothing when there is none", async () => {
    const down = vi.fn(async () => res(500));
    const r = await revoke("ghs_x", down);
    expect(down).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ revoked: false });
    expect(r.message).toMatch(/HTTP 500/);
    expect(r.message).not.toContain("ghs_x");
    const fetchFn = vi.fn();
    expect((await revoke("", fetchFn)).revoked).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
