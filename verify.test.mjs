import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCommand, preinstall, testCommand, verify } from "./verify.mjs";

// The proof-run (#805, #855, #858): split out of publish.test.mjs (#891).
describe("verify: commands", () => {
  const files = (names, pkg) => ({
    exists: (p) => names.some((n) => p.endsWith(`/${n}`)),
    read: () => JSON.stringify(pkg),
  });

  it("prefers the workflow's own test command", () => {
    const f = files(["package.json"], { scripts: { test: "vitest" } });
    expect(testCommand("/w", "make check", f.read, f.exists)).toBe("make check");
  });

  it("uses the repo's package manager for its test script", () => {
    const pnpm = files(["package.json", "pnpm-lock.yaml"], { scripts: { test: "vitest" } });
    expect(testCommand("/w", "", pnpm.read, pnpm.exists)).toBe("pnpm test");
    const npm = files(["package.json"], { scripts: { test: "vitest" } });
    expect(testCommand("/w", "", npm.read, npm.exists)).toBe("npm test");
  });

  // npm init's placeholder exits 1 on purpose; it proves nothing either way.
  it("finds nothing to prove with in npm's placeholder or a bare repo", () => {
    const f = files(["package.json"], { scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    expect(testCommand("/w", "", f.read, f.exists)).toBeNull();
    expect(testCommand("/w", "", () => "", () => false)).toBeNull();
  });

  it("installs from the lockfile only", () => {
    expect(installCommand("/w", (p) => p.endsWith("/package-lock.json"))).toBe("npm ci");
    expect(installCommand("/w", () => false)).toBeNull();
  });
});

describe("verify: budget", () => {
  // One deadline for install + test (#812 review): the test gets what install left.
  const withLockfile = () => {
    const dir = mkdtempSync(join(tmpdir(), "wrokin-agent-budget-"));
    writeFileSync(join(dir, "package-lock.json"), "{}");
    return dir;
  };

  it("gives the test only what install left", async () => {
    const dir = withLockfile();
    let t = 0;
    const seen = [];
    const run = async (cmd, o) => {
      seen.push([cmd, o.timeoutMs]);
      t += 700;
      return { code: 0, tail: "" };
    };
    const r = await verify({ dir, override: "npm test", env: {}, timeoutMs: 1000, run, now: () => t });
    rmSync(dir, { recursive: true, force: true });
    expect(r.verified).toBe(true);
    expect(seen).toEqual([["npm ci", 1000], ["npm test", 300]]);
  });

  it("is not verified when install used the whole budget", async () => {
    const dir = withLockfile();
    let t = 0;
    const run = async () => {
      t += 1000;
      return { code: 0, tail: "" };
    };
    const r = await verify({ dir, override: "npm test", env: {}, timeoutMs: 1000, run, now: () => t });
    rmSync(dir, { recursive: true, force: true });
    expect(r).toEqual({ verified: false, reason: "`npm ci` used the whole verify budget", proof: null });
  });

  // #856 review: the message names the step that used the time, never `null`.
  it("names the typecheck, or setup, as what used the budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrokin-agent-budget-"));
    let t = 0;
    const slow = async () => ((t += 1000), { code: 0, tail: "" });
    const tc = await verify({ dir, override: "npm test", env: {}, timeoutMs: 1000, typecheck: "npm run typecheck", run: slow, now: () => t });
    expect(tc.reason).toBe("`npm run typecheck` used the whole verify budget");
    t = 0;
    const none = await verify({ dir, override: "npm test", env: {}, timeoutMs: 0, run: slow, now: () => t });
    rmSync(dir, { recursive: true, force: true });
    expect(none.reason).toBe("setup used the whole verify budget");
  });
});

describe("verify: typecheck (#855)", () => {
  it("fails the proof-run on a failing typecheck, before the tests run", async () => {
    const seen = [];
    const run = async (cmd) => {
      seen.push(cmd);
      return cmd === "npm run typecheck" ? { code: 2, tail: "TS2304: Cannot find name 'compressMode'" } : { code: 0, tail: "" };
    };
    const dir = mkdtempSync(join(tmpdir(), "wrokin-agent-tc-"));
    const r = await verify({ dir, override: "npm test", env: {}, timeoutMs: 1000, typecheck: "npm run typecheck", run });
    rmSync(dir, { recursive: true, force: true });
    expect(seen).toEqual(["npm run typecheck"]);
    expect(r).toMatchObject({ verified: false, reason: "`npm run typecheck` failed (exit 2)", proof: { cmd: "npm run typecheck", exitCode: 2 } });
  });

  it("runs the tests after a passing typecheck", async () => {
    const seen = [];
    const run = async (cmd) => (seen.push(cmd), { code: 0, tail: "" });
    const dir = mkdtempSync(join(tmpdir(), "wrokin-agent-tc-"));
    const r = await verify({ dir, override: "npm test", env: {}, timeoutMs: 1000, typecheck: "npm run typecheck", run });
    rmSync(dir, { recursive: true, force: true });
    expect(seen).toEqual(["npm run typecheck", "npm test"]);
    expect(r.verified).toBe(true);
    // #840: the PR shows the typecheck ran, not only the test after it.
    expect(r.proof.before).toEqual([{ cmd: "npm run typecheck", exitCode: 0 }]);
  });

  it("records no earlier check when there is no typecheck", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrokin-agent-tc-"));
    const r = await verify({ dir, override: "npm test", env: {}, timeoutMs: 1000, run: async () => ({ code: 0, tail: "" }) });
    rmSync(dir, { recursive: true, force: true });
    expect(r.proof).not.toHaveProperty("before");
  });
});

describe("verify: check scripts (#858 review)", () => {
  const repo = (scripts) => {
    const dir = mkdtempSync(join(tmpdir(), "wrokin-agent-scripts-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
    return dir;
  };

  it("is not verified when the agent changed a check script, and runs nothing", async () => {
    const dir = repo({ test: "true", typecheck: "true" });
    const seen = [];
    const r = await verify({ dir, override: "", env: {}, timeoutMs: 1000, typecheck: "npm run typecheck", scripts: { typecheck: "tsc --noEmit", test: "vitest run" }, run: async (c) => (seen.push(c), { code: 0, tail: "" }) });
    rmSync(dir, { recursive: true, force: true });
    expect(r).toEqual({ verified: false, reason: "the agent changed the `typecheck` and `test` script in package.json, so the checks prove nothing", proof: null });
    expect(seen).toEqual([]);
  });

  it("runs as usual when the scripts are the base's", async () => {
    const dir = repo({ test: "vitest run", typecheck: "tsc --noEmit" });
    const r = await verify({ dir, override: "", env: {}, timeoutMs: 1000, typecheck: "npm run typecheck", test: "npm test", scripts: { typecheck: "tsc --noEmit", test: "vitest run" }, run: async () => ({ code: 0, tail: "" }) });
    rmSync(dir, { recursive: true, force: true });
    expect(r.verified).toBe(true);
  });

  // #870: the base had no test script and the agent wrote `"test": "echo ok"`. It runs and
  // is reported, but a command the agent wrote can't make its own work verified.
  it("runs a test script the agent added, and never calls it verified", async () => {
    const dir = repo({ test: "echo ok" });
    const seen = [];
    const run = async (c) => (seen.push(c), { code: 0, tail: "ok" });
    const r = await verify({ dir, override: "", env: {}, timeoutMs: 1000, test: null, scripts: {}, run });
    expect(seen).toEqual(["npm test"]);
    expect(r).toMatchObject({
      verified: false,
      reason: "tests passed; the test script was added in this run, so it can't verify the change",
      proof: { cmd: "npm test", exitCode: 0 },
    });
    const bad = await verify({ dir, override: "", env: {}, timeoutMs: 1000, run: async () => ({ code: 1, tail: "" }) });
    rmSync(dir, { recursive: true, force: true });
    expect(bad.reason).toBe("`npm test` failed (exit 1); the test script was added in this run, so it can't verify the change");
  });

  it("runs the base's test command, not one the agent's tree would resolve to", async () => {
    const dir = repo({ test: "vitest run" });
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    const seen = [];
    const r = await verify({ dir, override: "", env: {}, timeoutMs: 1000, test: "npm test", scripts: { test: "vitest run" }, run: async (c) => (seen.push(c), { code: 0, tail: "" }) });
    rmSync(dir, { recursive: true, force: true });
    expect(seen).toEqual(["pnpm i --frozen-lockfile", "npm test"]);
    expect(r.verified).toBe(true);
  });
});

describe("verify: verdict", () => {
  const dir = "/nonexistent-wrokin-test-dir";
  it("is verified only when a real test command exits 0", async () => {
    const ok = await verify({ dir, override: "true", env: {}, timeoutMs: 1000, run: async () => ({ code: 0, tail: "ok" }) });
    expect(ok).toMatchObject({ verified: true, proof: { cmd: "true", exitCode: 0 } });
    const bad = await verify({ dir, override: "t", env: {}, timeoutMs: 1000, run: async () => ({ code: 1, tail: "1 failed" }) });
    expect(bad).toMatchObject({ verified: false, reason: "`t` failed (exit 1)" });
    const none = await verify({ dir, override: "", env: {}, timeoutMs: 1000, run: async () => ({ code: 0 }) });
    expect(none).toEqual({ verified: false, reason: "no test command found", proof: null });
  });
});

// #865: a measured run spent its last turns on `tsc: not found` and opened no PR.
describe("preinstall (#865)", () => {
  const withLock = (fn) => async () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-pre-"));
    try {
      writeFileSync(join(dir, "package-lock.json"), "{}");
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("runs the lockfile's install, in the checkout, through the given runner", withLock(async (dir) => {
    const calls = [];
    const r = await preinstall({ dir, env: { A: "1" }, run: async (cmd, o) => (calls.push([cmd, o.cwd, o.env.A]), { code: 0, tail: "" }) });
    expect(calls).toEqual([["npm ci", dir, "1"]]);
    expect(r).toEqual({ cmd: "npm ci", ok: true, note: "`npm ci` ran before the agent started" });
  }));

  it("reports a failed or timed-out install without throwing", withLock(async (dir) => {
    const failed = await preinstall({ dir, env: {}, run: async () => ({ code: 1, tail: "E404" }) });
    expect(failed).toMatchObject({ cmd: "npm ci", ok: false, tail: "E404" });
    expect(failed.note).toContain("failed (exit 1)");
    const slow = await preinstall({ dir, env: {}, run: async () => ({ code: null, timedOut: true, tail: "" }) });
    expect(slow.note).toContain("timed out");
  }));

  it("does nothing when there is nothing to install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-pre-"));
    let ran = false;
    expect(await preinstall({ dir, env: {}, run: async () => ((ran = true), { code: 0 }) })).toBeNull();
    expect(ran).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
