// When setup fails (no key, unknown model, pi won't install), the run never reaches
// main.mjs, so this tells the issue why instead of leaving only a red job (#805).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { client } from "./github.mjs";

const errorFile = (env) => join(env.RUNNER_TEMP ?? "/tmp", "wrokin-agent", "setup-error.txt");

/** Called by preflight/setup on failure, so the comment can quote the real reason. */
export function recordSetupError(message, env = process.env) {
  try {
    mkdirSync(join(env.RUNNER_TEMP ?? "/tmp", "wrokin-agent"), { recursive: true });
    appendFileSync(errorFile(env), `${message}\n`);
  } catch {
    // best effort: the ::error line in the log still says it
  }
}

export function failureComment(reason, runUrl) {
  return (
    `⚠️ wrokin Builder couldn't start on this issue: ${reason || "setup failed (see the run log)"}\n\n` +
    `[Run](${runUrl})`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  let reason = "";
  try {
    reason = readFileSync(errorFile(env), "utf8").trim();
  } catch {
    // no recorded reason: the generic text says to look at the log
  }
  const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const r = await client(env.INPUT_GITHUB_TOKEN).call(
    "POST",
    `/repos/${env.GITHUB_REPOSITORY}/issues/${env.INPUT_ISSUE_NUMBER}/comments`,
    { body: failureComment(reason, runUrl) },
  );
  if (!r.ok) console.log(`::warning::could not comment on the issue (HTTP ${r.status})`);
}
