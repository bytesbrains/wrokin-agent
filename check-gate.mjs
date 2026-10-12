// A pi extension (#857): the agent may not finish while the repo's typecheck fails.
//
// Loaded with `-e` by run-pi.mjs, inside pi, as the agent's user. When the agent is
// about to settle (`agent_before_settle`), it runs the typecheck found on the base
// before the run (`WROKIN_CHECKS_FILE`, written by main.mjs, so the agent can't edit
// the command away) and, when it fails, hands the output back and asks for one more
// turn. After MAX_ROUNDS it lets the run settle: the proof-run after exit is still the
// gate, and its failure makes the PR a draft. A typecheck that times out lets the run
// settle too (#870): it gives the agent nothing to act on, and the proof-run will say
// so. No dependencies: pi loads it as is.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_ROUNDS = 2;
const TIMEOUT_MS = 5 * 60_000;
const TAIL = 4000;

/**
 * `{ command, scripts }` from the checks file, or null when there is no typecheck. The
 * file is the runner's (in its temp dir, which the agent's user can't write) and is
 * read once, here, when pi loads the extension: before the agent has done anything.
 */
export function readChecks(file, read = (f) => readFileSync(f, "utf8")) {
  if (!file) return null;
  try {
    const c = JSON.parse(read(file));
    if (typeof c?.typecheck !== "string" || !c.typecheck.trim()) return null;
    const scripts = c.scripts && typeof c.scripts === "object" ? c.scripts : {};
    return { command: c.typecheck.trim(), scripts };
  } catch {
    return null;
  }
}

/** package.json's scripts in `cwd` now: a regular file only. */
function currentScripts(cwd) {
  try {
    if (!lstatSync(join(cwd, "package.json")).isFile()) return {};
    return JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))?.scripts ?? {};
  } catch {
    return {};
  }
}

/** The message for a check script the agent changed: the check would prove nothing. */
export function tamperMessage(names, round) {
  return (
    `You changed the ${names.map((n) => `\`${n}\``).join(" and ")} script in package.json ` +
    `(check ${round} of ${MAX_ROUNDS}). Restore it: the checks must run as the repository defines them, ` +
    "and a changed check script fails the proof-run whatever it outputs."
  );
}

/** The message the agent gets back when the typecheck fails. */
export function failureMessage(cmd, result, round) {
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-TAIL);
  return [
    `\`${cmd}\` failed (exit ${result.code}) when you tried to finish ` +
      `(check ${round} of ${MAX_ROUNDS}). Fix these errors before you finish, then write your summary again.`,
    "",
    "```",
    out.replaceAll("```", "``​`") || "(no output)",
    "```",
  ].join("\n");
}

/**
 * The settle handler, with its effects injected for tests. Returns a BoundaryResult:
 * nothing when the run may settle, else the failure as a message the model reads (and
 * the event log records) plus `continue: true` for one more model request. Verified
 * against pi 1.0.4 with a stub model: fail → second request carrying the errors → pass.
 */
export function makeGate({ command, exec, cwd, scripts = {}, scriptsNow = () => currentScripts(cwd) }) {
  let rounds = 0;
  return async (event) => {
    // Not `event.context.canContinue`: it describes the transcript BEFORE these entries,
    // which ends on the agent's own message and so is always false here. pi checks again
    // after committing them, and the hand-back message is what makes continuing valid.
    if (!command || event.outcome !== "completed" || event.continue) return undefined;
    if (rounds >= MAX_ROUNDS) return undefined;
    const now = scriptsNow();
    const changed = Object.keys(scripts).filter((n) => now[n] !== scripts[n]);
    if (changed.length) {
      rounds++;
      return {
        entries: [{ type: "custom_message", customType: "wrokin-check-gate", content: tamperMessage(changed, rounds), display: true }],
        continue: true,
      };
    }
    const r = await exec("bash", ["-c", command], { cwd, timeout: TIMEOUT_MS });
    // Killed at the limit: not a type error, and not worth a round of the agent's time.
    if (r.killed || r.code === 0) return undefined;
    rounds++;
    return {
      entries: [
        { type: "custom_message", customType: "wrokin-check-gate", content: failureMessage(command, r, rounds), display: true },
      ],
      continue: true,
    };
  };
}

export default function checkGate(pi) {
  const checks = readChecks(process.env.WROKIN_CHECKS_FILE);
  if (!checks) return;
  pi.on(
    "agent_before_settle",
    makeGate({ command: checks.command, scripts: checks.scripts, exec: (c, a, o) => pi.exec(c, a, o), cwd: process.cwd() }),
  );
}
