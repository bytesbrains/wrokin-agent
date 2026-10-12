// The independent check (#805): after pi exits, the action runs the repo's tests itself.
// pi saying "tests pass" is a claim; this is the evidence that decides ready vs draft.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Install from the lockfile, as the old Builder did (#737). Null: nothing to install. */
export function installCommand(dir, exists = existsSync) {
  const has = (f) => exists(join(dir, f));
  if (has("pnpm-lock.yaml")) return "pnpm i --frozen-lockfile";
  if (has("yarn.lock")) return "yarn install --frozen-lockfile";
  if (has("package-lock.json")) return "npm ci";
  if (has("go.mod")) return "go mod download";
  return null;
}

/** npm's placeholder `test` script, which fails by design and proves nothing. */
const NPM_PLACEHOLDER = /no test specified/i;

/**
 * The test command: the workflow's own when it gives one, otherwise what the repo
 * declares. Null means there is nothing to prove the change with, so it can't be
 * called verified.
 */
export function testCommand(dir, override, read = (f) => readFileSync(f, "utf8"), exists = existsSync) {
  if (override?.trim()) return override.trim();
  if (exists(join(dir, "package.json"))) {
    let pkg = null;
    try {
      pkg = JSON.parse(read(join(dir, "package.json")));
    } catch {
      return null;
    }
    const script = pkg?.scripts?.test;
    if (!script || NPM_PLACEHOLDER.test(script)) return null;
    if (exists(join(dir, "pnpm-lock.yaml"))) return "pnpm test";
    if (exists(join(dir, "yarn.lock"))) return "yarn test";
    return "npm test";
  }
  if (exists(join(dir, "go.mod"))) return "go test ./...";
  return null;
}

/** The repo's package.json scripts, or {}: a regular file only, never followed through a link. */
export function packageScripts(dir) {
  try {
    if (!lstatSync(join(dir, "package.json")).isFile()) return {};
    const scripts = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))?.scripts;
    return scripts && typeof scripts === "object" ? scripts : {};
  } catch {
    return {};
  }
}

/**
 * The check scripts whose body differs from the base's (#858 review). `npm run
 * typecheck` is fixed before the run, but the script it runs lives in package.json,
 * which the agent can edit: `"typecheck": "true"` would pass both gates.
 */
export function changedScripts(dir, before = {}, now = packageScripts(dir)) {
  return Object.keys(before).filter((name) => now[name] !== before[name]);
}

/** Runs one shell command with a time limit; keeps the tail of its output. */
export function sh(cmd, { cwd, env, timeoutMs, spawnFn = spawn }) {
  return new Promise((resolve) => {
    const child = spawnFn("bash", ["-c", cmd], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    const keep = (d) => {
      out = (out + d.toString("utf8")).slice(-6000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, tail: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, tail: out });
    });
  });
}

/**
 * Installs, type-checks, then tests. `verified` only when a real test command ran and
 * exited 0, after the typecheck (when there is one) passed. The proof-run is what goes
 * into the PR, so it records what actually ran. `typecheck` and `test` are found on the
 * base before the agent runs (#855, #870), so the agent can't drop a check by editing
 * package.json, nor supply its own: a test script the base didn't have still runs and is
 * reported, but can't make the result verified. A typecheck that passed rides along in
 * `proof.before`, so the PR shows it ran and not only the test that followed (#840).
 */
export async function verify({ dir, override, env, timeoutMs, typecheck = null, test: baseTest = null, scripts = {}, run = sh, now = Date.now }) {
  const fixed = override?.trim() || baseTest;
  const added = fixed ? null : testCommand(dir);
  const test = fixed || added;
  if (!test) return { verified: false, reason: "no test command found", proof: null };
  const note = added ? "; the test script was added in this run, so it can't verify the change" : "";
  const changed = changedScripts(dir, scripts);
  if (changed.length) {
    return {
      verified: false,
      reason: `the agent changed the ${changed.map((n) => `\`${n}\``).join(" and ")} script in package.json, so the checks prove nothing`,
      proof: null,
    };
  }
  // One deadline for install and test together: the test gets what install left.
  const deadline = now() + timeoutMs;
  const install = installCommand(dir);
  // Named in a budget message: the step that used the time, never one that didn't run.
  let last = null;
  if (install) {
    last = install;
    const r = await run(install, { cwd: dir, env, timeoutMs });
    if (r.code !== 0) {
      return {
        verified: false,
        reason: r.timedOut ? `\`${install}\` timed out` : `\`${install}\` failed (exit ${r.code})`,
        proof: { cmd: install, exitCode: r.code, tail: r.tail },
      };
    }
  }
  const spent = () => ({
    verified: false,
    reason: `${last ? `\`${last}\`` : "setup"} used the whole verify budget`,
    proof: null,
  });
  if (deadline - now() <= 0) return spent();
  const before = [];
  if (typecheck) {
    last = typecheck;
    const r = await run(typecheck, { cwd: dir, env, timeoutMs: deadline - now() });
    if (r.code !== 0) {
      return {
        verified: false,
        reason: r.timedOut ? `\`${typecheck}\` timed out` : `\`${typecheck}\` failed (exit ${r.code})`,
        proof: { cmd: typecheck, exitCode: r.code, tail: r.tail },
      };
    }
    before.push({ cmd: typecheck, exitCode: r.code });
  }
  const left = deadline - now();
  if (left <= 0) return spent();
  const r = await run(test, { cwd: dir, env, timeoutMs: left });
  const proof = { cmd: test, exitCode: r.code, tail: r.tail, ...(before.length ? { before } : {}) };
  if (r.code === 0) return { verified: !added, reason: `tests passed${note}`, proof };
  return { verified: false, reason: `${r.timedOut ? `\`${test}\` timed out` : `\`${test}\` failed (exit ${r.code})`}${note}`, proof };
}
