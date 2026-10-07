// The independent check (#805): after pi exits, the action runs the repo's tests itself.
// pi saying "tests pass" is a claim; this is the evidence that decides ready vs draft.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
 * Installs, then tests. `verified` only when a real test command ran and exited 0.
 * The proof-run is what goes into the PR, so it records what actually ran.
 */
export async function verify({ dir, override, env, timeoutMs, run = sh, now = Date.now }) {
  const test = testCommand(dir, override);
  if (!test) return { verified: false, reason: "no test command found", proof: null };
  // One deadline for install and test together: the test gets what install left.
  const deadline = now() + timeoutMs;
  const install = installCommand(dir);
  if (install) {
    const r = await run(install, { cwd: dir, env, timeoutMs });
    if (r.code !== 0) {
      return {
        verified: false,
        reason: r.timedOut ? `\`${install}\` timed out` : `\`${install}\` failed (exit ${r.code})`,
        proof: { cmd: install, exitCode: r.code, tail: r.tail },
      };
    }
  }
  const left = deadline - now();
  if (left <= 0) return { verified: false, reason: `\`${install}\` used the whole verify budget`, proof: null };
  const r = await run(test, { cwd: dir, env, timeoutMs: left });
  const proof = { cmd: test, exitCode: r.code, tail: r.tail };
  if (r.code === 0) return { verified: true, reason: "tests passed", proof };
  return { verified: false, reason: r.timedOut ? `\`${test}\` timed out` : `\`${test}\` failed (exit ${r.code})`, proof };
}
