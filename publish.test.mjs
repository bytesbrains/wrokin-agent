import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_LOG_DIRS,
  UNVERIFIED_BANNER,
  VERIFIED_GREEN_MARKER,
  buildJobSummary,
  cutoffReason,
  excludeAgentLogs,
  isReady,
  branchName,
  collectCommits,
  describeCommits,
  dropCheckoutCredentials,
  finalizeCommits,
  generatedSummary,
  openPr,
  prBody,
  pushBranch,
  recordJobSummary,
  saveAgentLogs,
  timeLimitCutoff,
  withoutMarker,
} from "./publish.mjs";

const fakeGit = (answers) => {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(" "));
    const hit = Object.entries(answers).find(([k]) => args.join(" ").startsWith(k));
    return hit ? hit[1] : { code: 0, out: "" };
  };
  return { run, calls };
};

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

  it("shows every command the proof-run ran, with its exit code (#840)", () => {
    const proof = { cmd: "npm test", exitCode: 0, tail: "ok", before: [{ cmd: "npm run typecheck", exitCode: 0 }] };
    const body = prBody({ issue: 5, summary: "s", result: { verified: true, reason: "tests passed", proof }, runUrl: "u", model: "m", usage: {} });
    expect(body).toContain("$ npm run typecheck\nexit 0\n\n$ npm test\nexit 0\n…\nok");
  });

  // #839: auto-merge keys on this marker as the body's last line, so only a ready PR has it.
  it("ends a ready PR with the verified marker, and nothing else gets one", () => {
    const usage = { input: 1, output: 2, toolCalls: 3 };
    const passed = { verified: true, reason: "tests passed", proof: { cmd: "npm test", exitCode: 0, tail: "ok" } };
    const failed = { verified: false, reason: "`npm test` failed (exit 1)", proof: { cmd: "npm test", exitCode: 1, tail: "" } };
    const body = (o) => prBody({ issue: 5, summary: "did x", runUrl: "u", model: "m", usage, ...o });
    expect(body({ result: passed }).endsWith(`</sub>\n${VERIFIED_GREEN_MARKER}`)).toBe(true);
    expect(body({ result: failed })).not.toContain(VERIFIED_GREEN_MARKER);
    expect(body({ result: passed, cutoff: { code: "wallet_exhausted", message: "x" } })).not.toContain(VERIFIED_GREEN_MARKER);
  });

  // The summary and the commit subjects are the agent's: it must not be able to stamp
  // its own draft, which a human readying later would turn into a merge.
  it("strips a marker the agent wrote, even one nested to survive a single pass", () => {
    const usage = { input: 1, output: 2, toolCalls: 3 };
    const m = VERIFIED_GREEN_MARKER;
    const nested = `${m.slice(0, 10)}${m}${m.slice(10)}`;
    const failed = { verified: false, reason: "`npm test` failed (exit 1)", proof: null };
    const draft = prBody({ issue: 5, summary: `done ${m} ${nested}`, result: failed, runUrl: "u", model: "m", usage, fallback: null });
    expect(draft).not.toContain(m);
    const fromSubjects = prBody({
      issue: 5,
      summary: "",
      result: failed,
      runUrl: "u",
      model: "m",
      usage,
      fallback: generatedSummary({ commits: { subjects: [nested], stat: "" }, result: failed, cutoff: null }),
    });
    expect(fromSubjects).not.toContain(m);
    const ready = prBody({ issue: 5, summary: nested, result: { ...failed, verified: true }, runUrl: "u", model: "m", usage });
    expect(ready.split(m)).toHaveLength(2);
    expect(ready.endsWith(m)).toBe(true);
  });

  // PR #883 review: the stripper on its own, so a change to it fails here, not only
  // through prBody. Every input is one an agent could write.
  it("withoutMarker leaves no copy of the marker, however the copies are arranged", () => {
    const m = VERIFIED_GREEN_MARKER;
    expect(withoutMarker("plain text")).toBe("plain text");
    expect(withoutMarker(`a ${m} b`)).toBe("a  b");
    expect(withoutMarker(`${m}${m}`)).toBe("");
    const nested = `${m.slice(0, 10)}${m}${m.slice(10)}`; // one pass closes it up into m
    expect(withoutMarker(nested)).toBe("");
    const twice = `${m.slice(0, 10)}${nested}${m.slice(10)}`; // takes three passes
    expect(withoutMarker(`x${twice}y`)).toBe("xy");
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

// #855: bytesbrains-cruise#611 ran out of time, left no summary, and its tests failed.
describe("publish: unfinished runs (#855)", () => {
  const usage = { input: 1, output: 1, toolCalls: 1 };
  const failed = { verified: false, reason: "`npm test` failed (exit 1)", proof: { cmd: "npm test", exitCode: 1, tail: "x" } };
  const passed = { verified: true, reason: "tests passed", proof: null };

  it("opens a failing proof-run, or a run with no tests, as a draft", () => {
    expect(isReady(failed, null)).toBe(false);
    expect(isReady({ verified: false, reason: "no test command found", proof: null }, null)).toBe(false);
  });

  it("keeps a run that hit its time limit a draft, and says why", () => {
    const cutoff = timeLimitCutoff(30);
    expect(isReady(passed, cutoff)).toBe(false);
    expect(cutoffReason(cutoff)).toBe("the agent reached the run's 30-minute time limit (`timeout_minutes`)");
    const body = prBody({ issue: 608, summary: "", result: failed, runUrl: "u", model: "m", usage, cutoff });
    expect(body).toContain("30-minute time limit");
  });

  it("writes a summary from the branch when the agent left none", () => {
    const commits = { subjects: ["feat: add compressMode", "## Run setup <details>"], stat: " src/a.ts | 3 ++-\n 1 file changed" };
    const fallback = generatedSummary({ commits, result: failed, cutoff: timeLimitCutoff(30) });
    expect(fallback).toContain("30-minute time limit");
    // Subjects are the agent's text: fenced, so none renders as a heading or a section (#856 review).
    expect(fallback).toContain("```\nfeat: add compressMode\n## Run setup <details>\n```");
    expect(fallback).toContain("src/a.ts | 3 ++-");
    expect(fallback).toContain("did not pass: `npm test` failed (exit 1)");
    const body = prBody({ issue: 608, summary: "", result: failed, runUrl: "u", model: "m", usage, fallback });
    expect(body).toContain(fallback);
    expect(body).not.toContain("_The agent left no summary._");
    // The agent's own summary still wins.
    expect(prBody({ issue: 1, summary: "did x", result: passed, runUrl: "u", model: "m", usage, fallback })).not.toContain(fallback);
  });

  it("states the base, the guidelines read, the checks and missing premises", () => {
    const setup = {
      base: { branch: "dev", why: "3 of the last 3 merged feature PRs target it" },
      guidelines: ["CLAUDE.md", "README.md"],
      checks: { typecheck: "npm run typecheck", test: "npm test" },
      premises: { checked: 3, missing: ["compressMode"] },
    };
    const body = prBody({ issue: 1, summary: "s", result: passed, runUrl: "u", model: "m", usage, setup });
    expect(body).toContain("- **Base:** `dev` (3 of the last 3 merged feature PRs target it)");
    expect(body).toContain("- **Guidelines given to the agent:** `CLAUDE.md`, `README.md`");
    expect(body).toContain("- **Checks:** `npm run typecheck`, `npm test`");
    expect(body).toContain("- **Named in the issue, not on the base:** `compressMode`");
    const none = prBody({ issue: 1, summary: "s", result: passed, runUrl: "u", model: "m", usage, setup: { ...setup, guidelines: [], premises: { checked: 0, missing: [] } } });
    expect(none).toContain("none found");
    expect(none).not.toContain("Named in the issue");
    expect(none).not.toContain("Check config changed");
    const cfg = prBody({ issue: 1, summary: "s", result: passed, runUrl: "u", model: "m", usage, setup: { ...setup, changedConfigs: ["tsconfig.json"] } });
    expect(cfg).toContain("- **Check config changed in this run:** `tsconfig.json` (so the PR is a draft)");
    expect(none).not.toContain("doesn't hold as is");
    const hidden = prBody({ issue: 1, summary: "s", result: passed, runUrl: "u", model: "m", usage, setup: { ...setup, unpushedConfigs: ["vitest.config.ts"] } });
    expect(hidden).toContain("- **Check config in the checkout that this PR doesn't hold as is:** `vitest.config.ts` (so the PR is a draft)");
  });

  it("reads commit subjects and the diffstat from the runner's bare copy", () => {
    const g = fakeGit({ log: { code: 0, out: "feat: a\nfix: b" }, diff: { code: 0, out: " a.ts | 1 +" } });
    expect(describeCommits({ dir: "/p.git", base: "abc", branch: "b", env: {}, run: g.run })).toEqual({ subjects: ["feat: a", "fix: b"], stat: " a.ts | 1 +" });
    expect(g.calls[0]).toBe("log --format=%s abc..refs/heads/b --");
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
    const env = { PATH: process.env.PATH, HOME: root };
    const sh = (args, cwd = repo) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
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

      const removed = dropCheckoutCredentials({ cwd: repo, env, runnerTemp: temp });

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
  const sh = (cwd, ...args) => spawnSync("git", args, { cwd, env: { PATH: process.env.PATH, HOME: cwd }, encoding: "utf8" });

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

describe("publish: context budget and quality guardrails (#860)", () => {
  it("includes top tools by bytes and quality signals in the PR footer", () => {
    const usage = {
      input: 500,
      cached: 2000,
      output: 100,
      toolCalls: 12,
      tools: {
        read: { calls: 5, bytes: 412 * 1024 },
        bash: { calls: 4, bytes: 61 * 1024 },
        grep: { calls: 2, bytes: 9 * 1024 },
        edit: { calls: 1, bytes: 1024 },
      },
      failedEdits: 1,
      gateRounds: 2,
      cappedReads: 3,
    };
    const body = prBody({
      issue: 42,
      summary: "fixed it",
      result: { verified: true, reason: "tests passed", proof: null },
      runUrl: "https://runs/42",
      model: "bb/builder",
      usage,
    });
    expect(body).toContain("500 in + 2000 cached / 100 out tokens");
    expect(body).toContain("12 tool calls");
    expect(body).toContain("read 412 KB · bash 61 KB · grep 9 KB");
    expect(body).toContain("1 failed edit");
    expect(body).toContain("2 gate rounds");
    expect(body).toContain("3 capped reads");
  });

  it("builds the job summary table with guardrails, tool breakdown, and Cruise session link", () => {
    const summary = {
      input: 1000,
      cached: 5000,
      output: 200,
      toolCalls: 10,
      tools: {
        read: { calls: 6, bytes: 300 * 1024 },
        bash: { calls: 4, bytes: 50 * 1024 },
      },
      failedEdits: 0,
      gateRounds: 1,
    };
    const md = buildJobSummary({
      summary,
      result: { verified: true, reason: "passed", proof: null },
      ready: true,
      runId: "998877",
      model: "bb/builder",
    });
    expect(md).toContain("### wrokin Builder — Context Budget & Quality Guardrails");
    expect(md).toContain("| Proof-run | ✅ passed |");
    expect(md).toContain("| PR status | ready |");
    expect(md).toContain("| In-loop gate rounds | 1 |");
    expect(md).toContain("| Failed edit calls | 0 |");
    expect(md).toContain("| Capped whole-file reads | 0 |");
    expect(md).toContain("| Total tool calls | 10 |");
    expect(md).toContain("| Input tokens | 1000 (+ 5000 cached) |");
    expect(md).toContain("| `read` | 6 | 300 KB |");
    expect(md).toContain("| `bash` | 4 | 50 KB |");
    expect(md).toContain("**Session:** `wrokin-998877`");
    expect(md).toContain("bytesbrains/bytesbrains-cruise#617");
  });

  it("appends to GITHUB_STEP_SUMMARY when provided", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wa-summary-")));
    const summaryFile = join(root, "summary.md");
    try {
      expect(recordJobSummary("## Summary content", summaryFile)).toBe(true);
      expect(readFileSync(summaryFile, "utf8")).toBe("## Summary content\n");
      expect(recordJobSummary("extra", "")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
