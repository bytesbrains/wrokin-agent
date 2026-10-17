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
//
// It also hands back, once, a run about to finish having changed nothing (#865): a
// measured run described the edit it would make and stopped without making it. A run
// that rightly changes nothing (a false premise) just says so again.
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
    const command = typeof c?.typecheck === "string" && c.typecheck.trim() ? c.typecheck.trim() : null;
    const base = typeof c?.base === "string" && /^[0-9a-f]{40}$/.test(c.base) ? c.base : null;
    if (!command && !base) return null;
    const scripts = c.scripts && typeof c.scripts === "object" ? c.scripts : {};
    return { command, scripts, base };
  } catch {
    return null;
  }
}

/** The message for a run about to finish with no change since it started. */
export const NO_CHANGE_MESSAGE =
  "You are finishing without having changed anything: no commits and no uncommitted edits since the run " +
  "started. Describing a change doesn't make it. If the issue needs a change, make it now with your tools, " +
  "then run the checks. If it truly needs none (its premise is false, say), finish again with a summary that says why.";

/**
 * Whether the checkout differs from `base`: a commit on top of it, or an uncommitted
 * edit. Fails open (true) when git can't tell, so a broken git never costs a turn.
 */
export async function changedSince(base, exec, cwd) {
  const st = await exec("git", ["status", "--porcelain"], { cwd, timeout: 30_000 });
  if (st.code !== 0 || st.stdout.trim()) return true;
  const n = await exec("git", ["rev-list", "--count", `${base}..HEAD`], { cwd, timeout: 30_000 });
  return n.code !== 0 || Number.parseInt(n.stdout, 10) !== 0;
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
export function makeGate({ command, exec, cwd, scripts = {}, scriptsNow = () => currentScripts(cwd), base = null }) {
  let rounds = 0;
  let askedNoChange = false;
  return async (event) => {
    // Not `event.context.canContinue`: it describes the transcript BEFORE these entries,
    // which ends on the agent's own message and so is always false here. pi checks again
    // after committing them, and the hand-back message is what makes continuing valid.
    if (event.outcome !== "completed" || event.continue) return undefined;
    // Once per run, and apart from the typecheck's rounds: a second "no change" stands.
    if (base && !askedNoChange && !(await changedSince(base, exec, cwd))) {
      askedNoChange = true;
      return {
        entries: [{ type: "custom_message", customType: "wrokin-no-change", content: NO_CHANGE_MESSAGE, display: true }],
        continue: true,
      };
    }
    if (!command || rounds >= MAX_ROUNDS) return undefined;
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
    makeGate({
      command: checks.command,
      scripts: checks.scripts,
      base: checks.base,
      exec: (c, a, o) => pi.exec(c, a, o),
      cwd: process.cwd(),
    }),
  );
}
