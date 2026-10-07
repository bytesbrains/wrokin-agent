// Credentials and settings for the run, resolved once at job start (#813).
//
// With a `cruise_api_key` input the run never contacts wrok.in (enterprise, self-hosted
// Cruise). Without one, it checks in: a GitHub OIDC token for audience `wrokin-agent`
// goes to `POST /agent/checkin`, and the Builder card's Cruise key, lane and base URL
// come back. That is the only call to wrok.in in a run. pi then calls Cruise directly.
//
// Check-in also returns a wrokin App token for this one repository (#817): contents,
// pull requests and issues, never workflows. Every GitHub call in the run uses it, so
// the PR comes from wrokin[bot], needs no "Allow GitHub Actions to create and approve
// pull requests" setting, and triggers the repo's own CI. Revoked at job end.
//
// Both secrets are masked (`::add-mask::`) the moment they arrive, before anything else
// prints, and leave this step only as step outputs of the composite action.
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordSetupError } from "./report-failure.mjs";

export const AUDIENCE = "wrokin-agent";
export const DEFAULT_MODEL = "bb/builder";
export const DEFAULT_BASE_URL = "https://cruise.bytesbrains.net/v1";

/** The step's inputs, from the action's env block. */
export function readInputs(env) {
  return {
    key: env.INPUT_CRUISE_API_KEY ?? "",
    model: env.INPUT_MODEL ?? "",
    baseUrl: env.INPUT_CRUISE_BASE_URL ?? "",
    apiBase: env.INPUT_WROKIN_API_BASE || "https://api.wrok.in",
    role: env.INPUT_ROLE || "builder",
  };
}

/** A GitHub Actions OIDC token for `audience`, or the reason there isn't one. */
export async function requestOidc(env, audience, fetchFn = fetch) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) {
    return {
      error:
        "No Cruise key and no GitHub OIDC token. Add `permissions: id-token: write` to the workflow " +
        "so the run can fetch the key from the Builder card, or pass cruise_api_key.",
    };
  }
  let res;
  try {
    res = await fetchFn(`${url}&audience=${encodeURIComponent(audience)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (err) {
    return { error: `Could not get a GitHub OIDC token: ${err.message}` };
  }
  const data = res.ok ? await res.json().catch(() => null) : null;
  if (!data?.value) return { error: `Could not get a GitHub OIDC token (HTTP ${res.status}).` };
  return { oidc: data.value };
}

/** The key comes back in the response, so wrok.in is only ever called over https. */
function checkApiBase(apiBase) {
  try {
    if (new URL(apiBase).protocol === "https:") return null;
  } catch {
    return `wrokin_api_base is not a URL: "${apiBase}".`;
  }
  return "wrokin_api_base must be https.";
}

/** POST /agent/checkin → `{ key, model, baseUrl, githubToken }` or `{ error }` in words for the issue. */
export async function checkin({ apiBase, oidc, role, fetchFn = fetch }) {
  const badBase = checkApiBase(apiBase);
  if (badBase) return { error: badBase };
  let res;
  try {
    res = await fetchFn(`${apiBase.replace(/\/+$/, "")}/agent/checkin`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "wrokin-agent" },
      body: JSON.stringify({ oidc, role }),
    });
  } catch (err) {
    return { error: `Could not reach wrok.in to fetch the Cruise key: ${err.message}` };
  }
  const body = await res.json().catch(() => null);
  if (res.status !== 200) {
    // The server's refusals are written for the customer ("add a Cruise key on the
    // Builder card"), so they go on the issue as they are.
    return { error: `wrok.in check-in refused (HTTP ${res.status}): ${body?.error ?? "no reason given"}.` };
  }
  if (typeof body?.cruise_api_key !== "string" || !body.cruise_api_key) {
    return { error: "wrok.in check-in answered without a Cruise key." };
  }
  return {
    key: body.cruise_api_key,
    model: body.model ?? "",
    baseUrl: body.cruise_base_url ?? "",
    // Absent from an older wrok.in: the run then falls back to the job's GITHUB_TOKEN.
    githubToken: typeof body.github_token === "string" ? body.github_token : "",
  };
}

/**
 * Inputs win over the card, the card over the defaults. `key` is set only when it came
 * from check-in: an input key is already in the action's `inputs`, and copying a secret
 * into an output it doesn't need to be in is how one ends up printed.
 */
export async function resolve(env, { fetchFn = fetch, log = console.log } = {}) {
  const i = readInputs(env);
  if (i.key) {
    return { model: i.model || DEFAULT_MODEL, baseUrl: i.baseUrl || DEFAULT_BASE_URL };
  }
  const tok = await requestOidc(env, AUDIENCE, fetchFn);
  if (tok.error) return { error: tok.error };
  const got = await checkin({ apiBase: i.apiBase, oidc: tok.oidc, role: i.role, fetchFn });
  if (got.error) return { error: got.error };
  log(`::add-mask::${got.key}`);
  if (got.githubToken) log(`::add-mask::${got.githubToken}`);
  const r = {
    key: got.key,
    githubToken: got.githubToken,
    model: i.model || got.model || DEFAULT_MODEL,
    baseUrl: i.baseUrl || got.baseUrl || DEFAULT_BASE_URL,
  };
  // Each value becomes one `name=value` line in $GITHUB_OUTPUT; a line break would
  // let a value write outputs of its own.
  if (Object.values(r).some((v) => /[\r\n]/.test(v))) return { error: "wrok.in check-in answered with a malformed value." };
  return r;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await resolve(process.env);
  if (r.error) {
    console.log(`::error title=wrokin-agent check-in::${r.error}`);
    recordSetupError(r.error);
    process.exit(1);
  }
  const out = [`model=${r.model}`, `cruise_base_url=${r.baseUrl}`];
  if (r.key) out.push(`cruise_api_key=${r.key}`);
  if (r.githubToken) out.push(`github_token=${r.githubToken}`);
  appendFileSync(process.env.GITHUB_OUTPUT, `${out.join("\n")}\n`);
  console.log(
    r.key
      ? `Fetched the Cruise key and settings from the Builder card: ${r.model} via ${r.baseUrl}.`
      : `Using the cruise_api_key input: ${r.model} via ${r.baseUrl}.`,
  );
  console.log(
    r.githubToken
      ? "GitHub calls in this run use a wrokin App token for this repository, revoked at job end."
      : "GitHub calls in this run use the job's GITHUB_TOKEN.",
  );
}
