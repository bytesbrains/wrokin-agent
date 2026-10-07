// Fails fast, before pi starts, when the Cruise key or the model can't work (#810).
//
// Model ids depend on the key: on 2026-10-02 the prod key listed no
// `deepseek/deepseek-v4-pro` — v4-pro was `workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813`
// (#804). Without this check a typo or an unlisted id surfaces as pi's first failed
// call, deep in a run that has already cloned and set up. A lane (`bb/*`) is checked
// the same way: lanes are listed by /v1/models too.
//
// The key is sent only to the Cruise base URL and never printed.
import { fileURLToPath } from "node:url";
import { recordSetupError } from "./report-failure.mjs";

/** Turns a /v1/models response into the reason the run can't go ahead, or null. */
export function checkModel(status, body, model) {
  if (status === 401 || status === 403) {
    return "Cruise rejected the key. Check the Cruise key on the Builder card, or the cruise_api_key input.";
  }
  if (status !== 200) return `Cruise /v1/models answered HTTP ${status}.`;
  const ids = Array.isArray(body?.data) ? body.data.map((m) => m?.id).filter(Boolean) : [];
  if (ids.includes(model)) return null;
  const near = ids.filter((id) => id.includes(model.split("/").pop())).slice(0, 5);
  return (
    `Cruise has no model "${model}" for this key.` +
    (near.length ? ` Did you mean: ${near.join(", ")}?` : " Use a lane such as bb/builder.")
  );
}

/**
 * Below this a run is likely to be cut off partway (#822). Cruise holds a call's worst
 * case before sending it, about 15× what it costs for an agent resending a long context:
 * the #667 run was refused holding $0.29 for a call worth about $0.02, with $0.27 left.
 */
export const LOW_BALANCE_USD = 1;

/**
 * The wallet, from Cruise's `x-cruise-wallet-*` headers: `{ problem, warning }`.
 * Cruise sends them on chat responses; on /v1/models only once
 * bytesbrains/bytesbrains-cruise#584 lands. Without them this says nothing, so it is
 * safe to ship first.
 */
export function checkWallet(headers) {
  const state = headers?.get?.("x-cruise-wallet-state") ?? null;
  const raw = headers?.get?.("x-cruise-wallet-balance") ?? null;
  const balance = raw === null ? null : Number.parseFloat(raw);
  const left = Number.isFinite(balance) ? ` ($${balance.toFixed(2)} left)` : "";
  if (state === "exhausted") {
    return { problem: `The Cruise wallet is out of credit${left}. A credit grant lifts it; no retry will.`, warning: null };
  }
  if (state === "low" || (Number.isFinite(balance) && balance < LOW_BALANCE_USD)) {
    return {
      problem: null,
      warning: `The Cruise wallet is low${left}. A long run may be cut off partway with wallet_exhausted.`,
    };
  }
  return { problem: null, warning: null };
}

/** The key goes out as a bearer token, so only ever over https. */
export function checkBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return `cruise_base_url is not a URL: "${baseUrl}".`;
  }
  return url.protocol === "https:" ? null : `cruise_base_url must be https, got ${url.protocol}//${url.host}.`;
}

export async function preflight({ baseUrl, key, model, fetchFn = fetch, warn = () => {} }) {
  if (!key) return "No Cruise key. Add one on the Builder card, or pass cruise_api_key.";
  const badUrl = checkBaseUrl(baseUrl ?? "");
  if (badUrl) return badUrl;
  let res;
  try {
    res = await fetchFn(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${key}` },
    });
  } catch (err) {
    return `Could not reach Cruise at ${baseUrl}: ${err.message}`;
  }
  const body = res.status === 200 ? await res.json().catch(() => null) : null;
  const modelProblem = checkModel(res.status, body, model);
  if (modelProblem) return modelProblem;
  const wallet = checkWallet(res.headers);
  if (wallet.warning) warn(wallet.warning);
  return wallet.problem;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problem = await preflight({
    baseUrl: process.env.CRUISE_BASE_URL,
    key: process.env.CRUISE_API_KEY,
    model: process.env.MODEL,
    warn: (w) => console.log(`::warning title=wrokin-agent preflight::${w}`),
  });
  if (problem) {
    console.log(`::error title=wrokin-agent preflight::${problem}`);
    recordSetupError(problem);
    process.exit(1);
  }
  console.log(`Cruise accepts the key and lists ${process.env.MODEL}.`);
}
