// Credentials and settings for the run, resolved once at job start (#813).
//
// With a `cruise_api_key` input the run never contacts wrok.in (enterprise, self-hosted
// Cruise). Without one, it checks in: a GitHub OIDC token for audience `wrokin-agent`
// goes to `POST /agent/checkin`, and the Builder card's Cruise key, lane, base URL,
// read cap (#864) and base branch (#857) come back. That is the only call to wrok.in in a run. pi then calls Cruise directly.
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
    readCapKb: env.INPUT_READ_CAP_KB ?? "",
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

/**
 * One line, for text from outside that ends up in an `::error` workflow command (and on
 * the issue): a line break would end that command and start one of its own (PR #880).
 */
const oneLine = (s) => String(s).replace(/[\r\n]+/g, " ");

/** The key comes back in the response, so wrok.in is only ever called over https. */
function checkApiBase(apiBase) {
  try {
    if (new URL(apiBase).protocol === "https:") return null;
  } catch {
    return `wrokin_api_base is not a URL: "${apiBase}".`;
  }
  return "wrokin_api_base must be https.";
}

/** POST /agent/checkin → `{ key, model, baseUrl, readCapKb, baseBranch, githubToken }` or `{ error }` in words for the issue. */
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
    return { error: `Could not reach wrok.in to fetch the Cruise key: ${oneLine(err.message)}` };
  }
  const body = await res.json().catch(() => null);
  if (res.status !== 200) {
    // The server's refusals are written for the customer ("add a Cruise key on the
    // Builder card"), so they go on the issue as they are.
    return { error: `wrok.in check-in refused (HTTP ${res.status}): ${oneLine(body?.error ?? "no reason given")}.` };
  }
  if (typeof body?.cruise_api_key !== "string" || !body.cruise_api_key) {
    return { error: "wrok.in check-in answered without a Cruise key." };
  }
  return {
    key: body.cruise_api_key,
    model: body.model ?? "",
    baseUrl: body.cruise_base_url ?? "",
    // A whole number of KB, 0 = off. Absent from an older wrok.in, or not a whole
    // number: empty, and read-cap.mjs applies its own default.
    readCapKb: Number.isInteger(body.read_cap_kb) && body.read_cap_kb >= 0 ? String(body.read_cap_kb) : "",
    // Null when the card leaves it automatic, and absent from an older wrok.in: empty, and
    // the run works the base out itself. A `base_branch` input beats it in main.mjs, which
    // keeps the two apart so the log can say which one chose.
    baseBranch: typeof body.base_branch === "string" ? body.base_branch : "",
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
    return { model: i.model || DEFAULT_MODEL, baseUrl: i.baseUrl || DEFAULT_BASE_URL, readCapKb: i.readCapKb, baseBranch: "" };
  }
  const tok = await requestOidc(env, AUDIENCE, fetchFn);
  if (tok.error) return { error: tok.error };
  const got = await checkin({ apiBase: i.apiBase, oidc: tok.oidc, role: i.role, fetchFn });
  if (got.error) return { error: got.error };
  const r = {
    key: got.key,
    githubToken: got.githubToken,
    model: i.model || got.model || DEFAULT_MODEL,
    baseUrl: i.baseUrl || got.baseUrl || DEFAULT_BASE_URL,
    // "0" is an input too (off), so only an empty input defers to the card.
    readCapKb: i.readCapKb !== "" ? i.readCapKb : got.readCapKb,
    baseBranch: got.baseBranch,
  };
  // Each value becomes one `name=value` line in $GITHUB_OUTPUT; a line break would
  // let a value write outputs of its own. Checked before the masks too: `::add-mask::`
  // is a workflow command, and a key with a line break in it would end it and start
  // another (PR #880). Nothing has printed yet, and the error names no value.
  if (Object.values(r).some((v) => /[\r\n]/.test(v))) return { error: "wrok.in check-in answered with a malformed value." };
  log(`::add-mask::${r.key}`);
  if (r.githubToken) log(`::add-mask::${r.githubToken}`);
  return r;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await resolve(process.env);
  if (r.error) {
    console.log(`::error title=wrokin-agent check-in::${r.error}`);
    recordSetupError(r.error);
    process.exit(1);
  }
  const out = [`model=${r.model}`, `cruise_base_url=${r.baseUrl}`, `read_cap_kb=${r.readCapKb}`, `card_base_branch=${r.baseBranch}`];
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
