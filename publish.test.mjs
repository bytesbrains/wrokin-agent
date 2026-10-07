import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_LOG_DIRS,
  UNVERIFIED_BANNER,
  cutoffReason,
  excludeAgentLogs,
  isReady,
  branchName,
  collectCommits,
  dropCheckoutCredentials,
  finalizeCommits,
  openPr,
  prBody,
  pushBranch,
  saveAgentLogs,
} from "./publish.mjs";
import { installCommand, testCommand, verify } from "./verify.mjs";

const fakeGit = (answers) => {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(" "));
    const hit = Object.entries(answers).find(([k]) => args.join(" ").startsWith(k));
    return hit ? hit[1] : { code: 0, out: "" };
  };
  return { run, calls };
};

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

describe("publish", () => {
  it("names branches it owns and never as an option", () => {
    expect(branchName("builder", 42, "999")).toBe("wrokin/builder/issue-42-999");
  });

  it("commits leftovers, then counts commits over the base", () => {
    const g = fakeGit({ "status --porcelain": { code: 0, out: " M a.ts" }, "rev-list --count": { code: 0, out: "2" } });
    expect(finalizeCommits({ cwd: "/w", env: {}, base: "abc", run: g.run })).toBe(2);
    expect(g.calls).toContain("add -A");
    expect(g.calls.some((c) => c.startsWith("commit --no-verify"))).toBe(true);
  });

  it("opens nothing when the agent changed nothing", () => {
    const g = fakeGit({ "status --porcelain": { code: 0, out: "" }, "rev-list --count": { code: 0, out: "0" } });
    expect(finalizeCommits({ cwd: "/w", env: {}, base: "abc", run: g.run })).toBe(0);
    expect(g.calls).not.toContain("add -A");
  });

  it("pushes with Basic auth and redacts the token from any error", () => {
    const token = ["test", "push", "credential"].join("-");
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    const g = fakeGit({ "-c": { code: 1, out: `fatal: auth ${basic} ${token}` } });
    const r = pushBranch({ cwd: "/w", env: {}, repo: "o/r", branch: "b", token, run: g.run });
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(token);
    expect(r.message).not.toContain(basic);
    expect(g.calls[0]).toContain(`http.extraheader=AUTHORIZATION: basic ${basic}`);
    expect(g.calls[0]).toContain("push --no-verify -- https://github.com/o/r.git HEAD:refs/heads/b");
  });

  it("pushes a named ref from the runner's bare copy (#832)", () => {
    const g = fakeGit({});
    pushBranch({ cwd: "/p.git", env: {}, repo: "o/r", branch: "b", token: "t", ref: "refs/heads/b", run: g.run });
    expect(g.calls[0]).toContain("https://github.com/o/r.git refs/heads/b:refs/heads/b");
  });

  it("marks an unverified PR at the top and shows the proof-run otherwise", () => {
    const usage = { input: 1, output: 2, toolCalls: 3 };
    const bad = prBody({ issue: 5, summary: "did x", result: { verified: false, reason: "no test command found", proof: null }, runUrl: "u", model: "bb/builder", usage });
    expect(bad.startsWith(UNVERIFIED_BANNER)).toBe(true);
    expect(bad).toContain("No proof-run: no test command found.");
    const good = prBody({ issue: 5, summary: "", result: { verified: true, reason: "tests passed", proof: { cmd: "npm test", exitCode: 0, tail: "ok" } }, runUrl: "u", model: "bb/builder", usage });
    expect(good).not.toContain(UNVERIFIED_BANNER);
    expect(good).toContain("Closes #5");
    expect(good).toContain("$ npm test\nexit 0");
    expect(good).toContain("_The agent left no summary._");
  });

  // #822: PR #820 said "The agent left no summary." for a run Cruise had refused mid-task.
  it("says a cut-off run was cut off, why, and that the work is partial", () => {
    const usage = { input: 46889, cached: 1793664, output: 11796, toolCalls: 66 };
    const cutoff = { message: "429: …", code: "wallet_exhausted" };
    const result = { verified: false, reason: "`npm test` failed (exit 1)", proof: { cmd: "npm test", exitCode: 1, tail: "x" } };
    const body = prBody({ issue: 667, summary: "", result, runUrl: "u", model: "bb-adm/builder", usage, cutoff });
    expect(body.startsWith("> ⛔ **The run was cut off before the agent finished:**")).toBe(true);
    expect(body).toContain("`wallet_exhausted`");
    expect(body).toContain("partial work");
    // One notice, not two (#823 review): the cutoff banner carries the test outcome.
    expect(body).not.toContain(UNVERIFIED_BANNER);
    expect(body).toContain("NOT proven to build");
    expect(body).toContain("_The agent was cut off before it wrote one._");
    expect(body).not.toContain("_The agent left no summary._");
    // Cached input in the footer: without it #820 showed 46,889 of ~1.84M input tokens.
    expect(body).toContain("46889 in + 1793664 cached / 11796 out tokens");
  });

  it("says a cut-off run's tests passed without calling it done", () => {
    const passed = { verified: true, reason: "tests passed", proof: null };
    const body = prBody({ issue: 1, summary: "", result: passed, runUrl: "u", model: "m", usage: { input: 1, output: 1, toolCalls: 1 }, cutoff: { code: "budget_exhausted", message: "" } });
    expect(body).toContain("Its tests pass, but the agent never said it was done.");
    expect(body).not.toContain("NOT proven to build");
    expect(body.match(/^> /gm)).toHaveLength(1);
  });

  it("leaves the footer as it was when nothing was cached", () => {
    const body = prBody({ issue: 1, summary: "s", result: { verified: true, reason: "ok", proof: null }, runUrl: "u", model: "m", usage: { input: 1, cached: 0, output: 2, toolCalls: 3 } });
    expect(body).toContain("1 in / 2 out tokens");
    expect(body).not.toContain("⛔");
  });

  it("keeps cut-off work a draft even when its tests pass", () => {
    const passed = { verified: true, reason: "tests passed", proof: null };
    expect(isReady(passed, null)).toBe(true);
    expect(isReady(passed, { code: "wallet_exhausted", message: "" })).toBe(false);
    expect(isReady({ ...passed, verified: false }, null)).toBe(false);
  });

  it("names known refusals plainly and quotes anything else, trimmed", () => {
    expect(cutoffReason({ code: "wallet_exhausted", message: "" })).toMatch(/out of credit.*credit grant/);
    expect(cutoffReason({ code: "budget_exhausted", message: "" })).toMatch(/budget for this period/);
    expect(cutoffReason({ code: null, message: "502:\n  upstream  gone" })).toBe("a model call failed: 502: upstream gone");
    expect(cutoffReason({ code: "server_error", message: "x".repeat(500) })).toHaveLength(
      "a model call failed (`server_error`): ".length + 300,
    );
  });

  // This repo has "Allow GitHub Actions to create … pull requests" off (2026-10-02).
  it("turns GitHub's Actions-PR refusal into the setting to change and a compare link", async () => {
    const gh = { call: async () => ({ status: 403, ok: false, data: { message: "GitHub Actions is not permitted to create or approve pull requests." } }) };
    const r = await openPr(gh, { repo: "o/r", base: "dev", branch: "wrokin/builder/issue-1-2", title: "t", body: "b", draft: true });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Allow GitHub Actions to create and approve pull requests/);
    expect(r.compare).toBe("https://github.com/o/r/compare/dev...wrokin/builder/issue-1-2?expand=1");
  });
});

describe("excludeAgentLogs", () => {
  // Found by the mock end-to-end run: the extensions' logs landed in a commit.
  it("writes the extension log dirs to .git/info/exclude, resolved from the checkout", () => {
    const writes = [];
    const g = fakeGit({ "rev-parse --git-path": { code: 0, out: ".git/info/exclude" } });
    const cwd = mkdtempSync(join(tmpdir(), "wrokin-agent-exclude-"));
    const ok = excludeAgentLogs({ cwd, env: {}, run: g.run, append: (f, t) => writes.push([f, t]) });
    rmSync(cwd, { recursive: true, force: true });
    expect(ok).toBe(true);
    expect(writes[0][0]).toBe(join(cwd, ".git/info/exclude"));
    for (const d of AGENT_LOG_DIRS) expect(writes[0][1]).toContain(d);
  });
});

describe("dropCheckoutCredentials", () => {
  // actions/checkout v6 (#2286) keeps the job token in a file under $RUNNER_TEMP and
  // includes it from .git/config. Unsetting only the old extraheader left pi able to
  // push with it (#812 review lead).
  it("removes checkout's credential includes and files, and keeps unrelated includes", () => {
    // Real path: includeIf.gitdir compares resolved paths, and macOS's tmpdir is a symlink.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrokin-agent-creds-")));
    const repo = join(root, "repo");
    const temp = join(root, "runner-temp");
    const sh = (args, cwd = repo) => spawnSync("git", args, { cwd, encoding: "utf8" });
    try {
      mkdirSync(temp);
      sh(["init", "-q", repo], root);
      const creds = join(temp, "git-credentials-0d1e.config");
      writeFileSync(creds, '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic c2VjcmV0\n');
      writeFileSync(join(temp, "git-credentials-stray.config"), "x");
      const keep = join(root, "team.config");
      writeFileSync(keep, "[core]\n\tautocrlf = false\n");
      sh(["config", "--local", `includeIf.gitdir:${repo}/.git.path`, creds]);
      sh(["config", "--local", "includeIf.gitdir:/github/workspace/.git.path", creds]);
      sh(["config", "--local", "--add", "include.path", keep]);
      sh(["config", "--local", "http.https://github.com/.extraheader", "AUTHORIZATION: basic b2xk"]);
      expect(sh(["config", "--get-all", "http.https://github.com/.extraheader"]).stdout).toContain("c2VjcmV0");

      const removed = dropCheckoutCredentials({ cwd: repo, env: process.env, runnerTemp: temp });

      expect(sh(["config", "--get-all", "http.https://github.com/.extraheader"]).stdout).toBe("");
      expect(sh(["config", "--local", "--get-regexp", "^includeif\\."]).stdout).toBe("");
      expect(sh(["config", "--local", "--get", "include.path"]).stdout.trim()).toBe(keep);
      expect(existsSync(creds)).toBe(false);
      expect(existsSync(join(temp, "git-credentials-stray.config"))).toBe(false);
      expect(removed).toContain("http.https://github.com/.extraheader");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * #832: the agent owns its checkout, including `.git/config` and hooks. The runner
 * copies the commits out with a fetch and must never run anything the agent planted.
 */
describe("collectCommits: never runs the agent's git config", () => {
  const sh = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

  it("counts the agent's commits from a bare copy, with its fsmonitor and hooks inert", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wa-collect-")));
    try {
      const ws = join(root, "ws");
      const up = join(root, "up");
      const marker = join(root, "PWNED");
      // A depth-1 clone, as actions/checkout makes: the second live run counted 0
      // because a fetch from a shallow repo drops the ref without --update-shallow.
      mkdirSync(up);
      sh(up, "init", "-q", "-b", "main");
      for (const m of ["one", "two", "base"]) sh(up, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", m);
      sh(root, "clone", "-q", "--depth", "1", `file://${up}`, ws);
      expect(sh(ws, "rev-parse", "--is-shallow-repository").stdout.trim()).toBe("true");
      const base = sh(ws, "rev-parse", "HEAD").stdout.trim();
      sh(ws, "checkout", "-q", "-b", "wrokin/builder/issue-1-9");
      sh(ws, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
      sh(ws, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "two");
      // What a hostile agent leaves behind: a command git would run as the runner.
      const evil = join(root, "evil.sh");
      writeFileSync(evil, `#!/bin/sh\ntouch ${marker}\n`);
      chmodSync(evil, 0o755);
      sh(ws, "config", "core.fsmonitor", evil);
      sh(ws, "config", "core.hooksPath", root);
      for (const h of ["pre-push", "post-checkout", "reference-transaction"]) {
        writeFileSync(join(root, h), `#!/bin/sh\ntouch ${marker}\n`);
        chmodSync(join(root, h), 0o755);
      }

      const out = collectCommits({
        workspace: ws,
        branch: "wrokin/builder/issue-1-9",
        base,
        dir: join(root, "publish.git"),
        // On the runner the checkout belongs to another user (wrokin-pi). Git's own test
        // switch makes every repo look foreign, which is what tripped the first live run.
        env: { PATH: process.env.PATH, HOME: root, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" },
      });
      expect(out.commits).toBe(2);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts zero, not a crash, when the branch isn't there", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wa-collect-")));
    try {
      sh(root, "init", "-q");
      const out = collectCommits({ workspace: root, branch: "nope", base: "HEAD", dir: join(root, "p.git"), env: { PATH: process.env.PATH } });
      expect(out.commits).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("saveAgentLogs", () => {
  it("copies regular files and skips a symlink the agent planted", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wa-logs-")));
    try {
      const ws = join(root, "ws");
      const secret = join(root, "secret");
      writeFileSync(secret, "GITHUB_TOKEN=ghs_x");
      mkdirSync(join(ws, ".supervisor", "sub"), { recursive: true });
      writeFileSync(join(ws, ".supervisor", "audit.jsonl"), "{}");
      writeFileSync(join(ws, ".supervisor", "sub", "more.jsonl"), "{}");
      symlinkSync(secret, join(ws, ".supervisor", "steal.jsonl"));
      const to = join(root, "out");
      saveAgentLogs({ workspace: ws, to });
      expect(readFileSync(join(to, ".supervisor", "audit.jsonl"), "utf8")).toBe("{}");
      expect(existsSync(join(to, ".supervisor", "sub", "more.jsonl"))).toBe(true);
      expect(existsSync(join(to, ".supervisor", "steal.jsonl"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips a file the agent made unreadable instead of throwing", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wa-logs-")));
    const locked = join(root, "ws", ".supervisor", "locked.jsonl");
    try {
      const ws = join(root, "ws");
      mkdirSync(join(ws, ".supervisor"), { recursive: true });
      writeFileSync(join(ws, ".supervisor", "audit.jsonl"), "{}");
      writeFileSync(locked, "{}");
      chmodSync(locked, 0o000);
      const to = join(root, "out");
      let copied;
      expect(() => (copied = saveAgentLogs({ workspace: ws, to }))).not.toThrow();
      expect(copied).toContain(join(ws, ".supervisor", "audit.jsonl"));
    } finally {
      chmodSync(locked, 0o600);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
