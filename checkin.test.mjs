import { describe, it, expect, vi } from "vitest";
import { AUDIENCE, checkin, readInputs, requestOidc, resolve } from "./checkin.mjs";

const KEY = "cru_live_decoy_key_9f3a";
const GH = "ghs_decoy_repo_token_41c7";
const OIDC_ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.example/idtoken?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

/** A fetch that answers the OIDC request, then check-in with `status`/`body`. */
function fakeFetch(
  status = 200,
  body = { cruise_api_key: KEY, model: "bb/builder-fast", cruise_base_url: "https://cruise.example/v1", github_token: GH },
) {
  return vi.fn(async (url) => (String(url).includes("idtoken") ? json(200, { value: "oidc-jwt" }) : json(status, body)));
}

describe("resolve (#813)", () => {
  it("never contacts wrok.in when cruise_api_key is given, and doesn't copy the key", async () => {
    const fetchFn = vi.fn();
    const r = await resolve({ INPUT_CRUISE_API_KEY: KEY, ...OIDC_ENV }, { fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r).toEqual({ model: "bb/builder", baseUrl: "https://cruise.bytesbrains.net/v1" });
  });

  it("fetches the card's key, lane and URL, and masks the key before returning it", async () => {
    const fetchFn = fakeFetch();
    const log = vi.fn();
    const r = await resolve({ ...OIDC_ENV }, { fetchFn, log });
    expect(r).toEqual({ key: KEY, githubToken: GH, model: "bb/builder-fast", baseUrl: "https://cruise.example/v1" });
    expect(log).toHaveBeenCalledWith(`::add-mask::${KEY}`);

    const [oidcUrl, oidcInit] = fetchFn.mock.calls[0];
    expect(oidcUrl).toBe(`${OIDC_ENV.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${AUDIENCE}`);
    expect(oidcInit.headers.authorization).toBe("Bearer request-token");
    const [url, init] = fetchFn.mock.calls[1];
    expect(url).toBe("https://api.wrok.in/agent/checkin");
    expect(JSON.parse(init.body)).toEqual({ oidc: "oidc-jwt", role: "builder" });
  });

  it("lets an explicit model or base URL input win over the card", async () => {
    const r = await resolve(
      { ...OIDC_ENV, INPUT_MODEL: "mistral/codestral-2508", INPUT_CRUISE_BASE_URL: "https://mine/v1" },
      { fetchFn: fakeFetch(), log: () => {} },
    );
    expect(r).toMatchObject({ model: "mistral/codestral-2508", baseUrl: "https://mine/v1" });
  });

  it("falls back to the default lane when the card names none", async () => {
    const r = await resolve({ ...OIDC_ENV }, { fetchFn: fakeFetch(200, { cruise_api_key: KEY }), log: () => {} });
    expect(r).toMatchObject({ model: "bb/builder", baseUrl: "https://cruise.bytesbrains.net/v1" });
  });

  it("refuses a value that would add lines to $GITHUB_OUTPUT", async () => {
    const r = await resolve(
      { ...OIDC_ENV },
      { fetchFn: fakeFetch(200, { cruise_api_key: KEY, model: "bb/builder\ncruise_api_key=x" }), log: () => {} },
    );
    expect(r.error).toMatch(/malformed/);
  });
});

describe("resolve: the run's GitHub token (#817)", () => {
  it("masks the check-in's GitHub token before returning it", async () => {
    const log = vi.fn();
    const r = await resolve({ ...OIDC_ENV }, { fetchFn: fakeFetch(), log });
    expect(r.githubToken).toBe(GH);
    expect(log).toHaveBeenCalledWith(`::add-mask::${GH}`);
    // Masks come first: nothing else is printed before both are registered.
    expect(log.mock.calls.every(([l]) => l.startsWith("::add-mask::"))).toBe(true);
  });

  it("falls back to GITHUB_TOKEN when an older wrok.in returns none", async () => {
    const log = vi.fn();
    const r = await resolve({ ...OIDC_ENV }, { fetchFn: fakeFetch(200, { cruise_api_key: KEY }), log });
    expect(r.githubToken).toBe("");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("returns no GitHub token on the cruise_api_key path, which keeps GITHUB_TOKEN", async () => {
    const r = await resolve({ INPUT_CRUISE_API_KEY: KEY }, { fetchFn: vi.fn() });
    expect(r.githubToken).toBeUndefined();
  });

  it("refuses a GitHub token that would add lines to $GITHUB_OUTPUT", async () => {
    const r = await resolve(
      { ...OIDC_ENV },
      { fetchFn: fakeFetch(200, { cruise_api_key: KEY, github_token: `${GH}\ncruise_api_key=x` }), log: () => {} },
    );
    expect(r.error).toMatch(/malformed/);
  });

  it("never puts the GitHub token in an error", async () => {
    const r = await checkin({
      apiBase: "https://x",
      oidc: "t",
      role: "builder",
      fetchFn: async () => json(403, { github_token: GH, error: "missing perms" }),
    });
    expect(r.error).not.toContain(GH);
  });
});

describe("requestOidc", () => {
  it("says to add id-token: write when the workflow didn't grant it", async () => {
    const r = await requestOidc({}, AUDIENCE, vi.fn());
    expect(r.error).toMatch(/id-token: write/);
    expect(r.error).toMatch(/cruise_api_key/);
  });

  it("reports a failed token request by status", async () => {
    const r = await requestOidc(OIDC_ENV, AUDIENCE, async () => json(403, {}));
    expect(r.error).toMatch(/HTTP 403/);
  });
});

describe("checkin", () => {
  it("puts the server's refusal on the issue as it is", async () => {
    const r = await checkin({
      apiBase: "https://api.wrok.in",
      oidc: "t",
      role: "builder",
      fetchFn: async () => json(409, { error: "add a Cruise key on the Builder card" }),
    });
    expect(r.error).toBe("wrok.in check-in refused (HTTP 409): add a Cruise key on the Builder card.");
  });

  it("only ever calls wrok.in over https, since the key comes back", async () => {
    const fetchFn = vi.fn();
    const r = await checkin({ apiBase: "http://api.wrok.in", oidc: "t", role: "builder", fetchFn });
    expect(r.error).toMatch(/https/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses a 200 that carries no key", async () => {
    const r = await checkin({ apiBase: "https://x", oidc: "t", role: "builder", fetchFn: async () => json(200, {}) });
    expect(r.error).toMatch(/without a Cruise key/);
  });

  it("never puts the key in an error", async () => {
    const r = await checkin({
      apiBase: "https://x",
      oidc: "t",
      role: "builder",
      fetchFn: async () => json(500, { cruise_api_key: KEY }),
    });
    expect(r.error).not.toContain(KEY);
  });
});

describe("readInputs (#814 review)", () => {
  it("defaults the API base and role, and treats unset inputs as empty", () => {
    expect(readInputs({})).toEqual({ key: "", model: "", baseUrl: "", apiBase: "https://api.wrok.in", role: "builder" });
  });

  it("checks in at a wrokin_api_base override", async () => {
    const fetchFn = fakeFetch();
    await resolve({ ...OIDC_ENV, INPUT_WROKIN_API_BASE: "https://api.staging.wrok.in/" }, { fetchFn, log: () => {} });
    expect(fetchFn.mock.calls[1][0]).toBe("https://api.staging.wrok.in/agent/checkin");
  });
});
