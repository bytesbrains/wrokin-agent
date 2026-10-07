import { describe, it, expect } from "vitest";
import { LOW_BALANCE_USD, checkBaseUrl, checkModel, checkWallet, preflight } from "./preflight.mjs";

const listing = {
  data: [
    { id: "bb/builder" },
    { id: "mistral/codestral-2508" },
    { id: "workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813" },
  ],
};

describe("checkModel", () => {
  it("accepts a listed lane and a listed model", () => {
    expect(checkModel(200, listing, "bb/builder")).toBeNull();
    expect(checkModel(200, listing, "mistral/codestral-2508")).toBeNull();
  });

  it("names the key, not the model, on 401 and 403", () => {
    expect(checkModel(401, null, "bb/builder")).toMatch(/rejected the key/);
    expect(checkModel(403, null, "bb/builder")).toMatch(/rejected the key/);
  });

  // The id the prod key did NOT list on 2026-10-02 (#804), and the one it did.
  it("suggests the id this key does list", () => {
    const why = checkModel(200, listing, "deepseek/deepseek-v4-pro");
    expect(why).toMatch(/no model "deepseek\/deepseek-v4-pro"/);
    expect(why).toMatch(/workers-ai\/@cf\/deepseek-ai\/deepseek-v4-pro-0813/);
  });

  it("points at a lane when nothing is close", () => {
    expect(checkModel(200, listing, "acme/unknown")).toMatch(/bb\/builder/);
  });

  it("reports other statuses as they are", () => {
    expect(checkModel(502, null, "bb/builder")).toMatch(/HTTP 502/);
  });
});

describe("checkBaseUrl", () => {
  it("accepts https and rejects anything else", () => {
    expect(checkBaseUrl("https://cruise.bytesbrains.net/v1")).toBeNull();
    expect(checkBaseUrl("http://localhost:8787/v1")).toMatch(/must be https/);
    expect(checkBaseUrl("cruise.bytesbrains.net/v1")).toMatch(/not a URL/);
  });
});

describe("preflight", () => {
  it("refuses to call Cruise without a key", async () => {
    let called = false;
    const why = await preflight({
      baseUrl: "https://cruise.example/v1",
      key: "",
      model: "bb/builder",
      fetchFn: () => {
        called = true;
      },
    });
    expect(why).toMatch(/No Cruise key/);
    expect(called).toBe(false);
  });

  it("sends the key only as a bearer token to the base URL's /models", async () => {
    const seen = [];
    const why = await preflight({
      baseUrl: "https://cruise.example/v1/",
      key: "sk-test",
      model: "bb/builder",
      fetchFn: async (url, init) => {
        seen.push({ url, auth: init.headers.authorization });
        return { status: 200, json: async () => listing };
      },
    });
    expect(why).toBeNull();
    expect(seen).toEqual([{ url: "https://cruise.example/v1/models", auth: "Bearer sk-test" }]);
  });

  // The key travels as a bearer token, so a non-https base URL must never be called (#811 review).
  it("refuses a non-https base URL without sending the key", async () => {
    let called = false;
    const why = await preflight({
      baseUrl: "http://cruise.example/v1",
      key: "sk-test",
      model: "bb/builder",
      fetchFn: () => {
        called = true;
      },
    });
    expect(why).toBe("cruise_base_url must be https, got http://cruise.example.");
    expect(called).toBe(false);
  });

  it("turns a network failure into one line", async () => {
    const why = await preflight({
      baseUrl: "https://cruise.example/v1",
      key: "sk-test",
      model: "bb/builder",
      fetchFn: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    expect(why).toBe("Could not reach Cruise at https://cruise.example/v1: getaddrinfo ENOTFOUND");
  });
});

// #822: the #667 run started with $0.27 and was refused on call 49. Cruise sends these
// headers on /v1/models once bytesbrains/bytesbrains-cruise#584 lands; until then, none.
describe("checkWallet", () => {
  const h = (o) => new Headers(o);

  it("refuses an exhausted wallet, saying no retry helps", () => {
    const w = checkWallet(h({ "x-cruise-wallet-state": "exhausted", "x-cruise-wallet-balance": "0.0000" }));
    expect(w.problem).toBe("The Cruise wallet is out of credit ($0.00 left). A credit grant lifts it; no retry will.");
  });

  it("warns, without refusing, when Cruise says low or the balance is under the floor", () => {
    expect(checkWallet(h({ "x-cruise-wallet-state": "low" }))).toEqual({
      problem: null,
      warning: "The Cruise wallet is low. A long run may be cut off partway with wallet_exhausted.",
    });
    // Cruise said `ok` because the wallet has no low threshold (bytesbrains-cruise#583).
    const w = checkWallet(h({ "x-cruise-wallet-state": "ok", "x-cruise-wallet-balance": "0.2653" }));
    expect(w.problem).toBeNull();
    expect(w.warning).toMatch(/low \(\$0\.27 left\)/);
  });

  it("says nothing for a healthy, uncapped or silent wallet", () => {
    const quiet = { problem: null, warning: null };
    expect(checkWallet(h({ "x-cruise-wallet-state": "ok", "x-cruise-wallet-balance": String(LOW_BALANCE_USD + 4) }))).toEqual(quiet);
    expect(checkWallet(h({ "x-cruise-wallet-state": "ok" }))).toEqual(quiet); // uncapped: no balance header
    expect(checkWallet(h({}))).toEqual(quiet);
    expect(checkWallet(undefined)).toEqual(quiet);
  });
});

describe("preflight: wallet", () => {
  const reply = (headers) => async () => ({ status: 200, headers: new Headers(headers), json: async () => listing });
  const base = { baseUrl: "https://cruise.example/v1", key: "sk-test", model: "bb/builder" };

  it("fails an exhausted wallet before pi starts", async () => {
    const why = await preflight({ ...base, fetchFn: reply({ "x-cruise-wallet-state": "exhausted" }) });
    expect(why).toMatch(/out of credit/);
  });

  it("passes a low wallet with a warning", async () => {
    const warnings = [];
    const why = await preflight({
      ...base,
      fetchFn: reply({ "x-cruise-wallet-state": "low", "x-cruise-wallet-balance": "0.5" }),
      warn: (w) => warnings.push(w),
    });
    expect(why).toBeNull();
    expect(warnings).toEqual(["The Cruise wallet is low ($0.50 left). A long run may be cut off partway with wallet_exhausted."]);
  });

  it("names a bad model before the wallet", async () => {
    const why = await preflight({ ...base, model: "acme/unknown", fetchFn: reply({ "x-cruise-wallet-state": "exhausted" }) });
    expect(why).toMatch(/no model "acme\/unknown"/);
  });
});
