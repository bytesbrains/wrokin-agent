// Job end, success or not (#817): revoke the wrokin App token check-in handed this run,
// so it is dead the moment the job is, not up to an hour later. Only runs when there is
// one; the job's own GITHUB_TOKEN is GitHub's to expire.
import { fileURLToPath } from "node:url";
import { client } from "./github.mjs";

/**
 * `DELETE /installation/token` with the token itself. 204 = revoked, 401 = already dead.
 * A network error or 5xx is retried once (#818 review): one flaky answer shouldn't leave
 * the token live for its remaining hour. Anything else is final.
 */
export async function revoke(token, fetchFn = fetch, attempts = 2) {
  if (!token) return { revoked: false, message: "no wrokin App token to revoke" };
  let last = "";
  for (let i = 0; i < attempts; i++) {
    let r;
    try {
      r = await client(token, fetchFn).call("DELETE", "/installation/token");
    } catch (err) {
      last = `could not revoke the wrokin App token: ${err.message}`;
      continue;
    }
    if (r.status === 204) return { revoked: true, message: "revoked the wrokin App token" };
    if (r.status === 401) return { revoked: true, message: "the wrokin App token was already invalid" };
    last = `could not revoke the wrokin App token (HTTP ${r.status}); it expires within the hour`;
    if (r.status < 500) break;
  }
  return { revoked: false, message: last };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Never fails the job: the run's outcome is already on the issue.
  try {
    const r = await revoke(process.env.INPUT_GITHUB_TOKEN);
    console.log(r.revoked ? r.message : `::warning title=wrokin-agent::${r.message}`);
  } catch (err) {
    console.log(`::warning title=wrokin-agent::could not revoke the wrokin App token: ${err?.message ?? err}`);
  }
}
