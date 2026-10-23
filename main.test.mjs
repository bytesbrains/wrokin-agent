import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, readInputs, reportCrash, verifyBudget } from "./main.mjs";

const env = (over = {}) => ({
  GITHUB_REPOSITORY: "o/r",
  GITHUB_RUN_ID: "9",
  GITHUB_SERVER_URL: "https://github.com",
  RUNNER_TEMP: "/rt",
  INPUT_ISSUE_NUMBER: "5",
  INPUT_MODEL: "bb/builder",
  ...over,
});

/** A fake GitHub client recording comments; `issue` is what GET /issues/N answers. */
const fakeGh = (issue) => {
  const comments = [];
  return {
    comments,
    async call(method, path, body) {
      if (method === "POST") {
        comments.push(body.body);
        return { ok: true, status: 201, data: {} };
      }
      return issue;
    },
    async all() {
      return { ok: true, items: [] };
    },
  };
};

describe("readInputs", () => {
  it("defaults the role and the timeout, and builds the run link", () => {
    const i = readInputs(env());
    expect(i).toMatchObject({ role: "builder", issue: 5, timeoutMs: 30 * 60_000, runUrl: "https://github.com/o/r/actions/runs/9", temp: "/rt/wrokin-agent", thinking: "" });
    expect(readInputs(env({ INPUT_TIMEOUT_MINUTES: "-3" })).timeoutMs).toBe(30 * 60_000);
    expect(readInputs(env({ INPUT_TIMEOUT_MINUTES: "45" })).timeoutMs).toBe(45 * 60_000);
    expect(readInputs(env({ INPUT_TIMEOUT_MINUTES: "nope" }))).toMatchObject({ minutes: 30, timeoutMs: 30 * 60_000 });
    expect(readInputs(env({ INPUT_THINKING: "off" })).thinking).toBe("off");
    expect(readInputs(env({ INPUT_THINKING: "on" })).thinking).toBe("on");
    const prInput = readInputs(env({ INPUT_ISSUE_NUMBER: "", INPUT_PR_NUMBER: "42" }));
    expect(prInput).toMatchObject({ role: "builder-fix", issue: null, pr: 42 });
    expect(readInputs(env({ INPUT_ISSUE_NUMBER: "5", INPUT_PR_NUMBER: "42" })).role).toBe("builder");
    expect(readInputs(env({ INPUT_ISSUE_NUMBER: "5", INPUT_PR_NUMBER: "42", INPUT_ROLE: "builder-fix" })).role).toBe("builder-fix");
  });
});

describe("verifyBudget", () => {
  it("caps verify at 20 minutes, so agent + verify fit the 90-minute job", () => {
    expect(verifyBudget(30 * 60_000)).toBe(20 * 60_000);
    expect(verifyBudget(5 * 60_000)).toBe(5 * 60_000);
  });
});

// "Every outcome ends as a comment on the issue" (#805), for the outcomes that end
// before git or pi are touched.
describe("main: early outcomes", () => {
  it("comments on an unknown role instead of only logging it", async () => {
    const gh = fakeGh({ ok: true, status: 200, data: { number: 5, title: "t" } });
    await main(env({ INPUT_ROLE: "architect" }), gh);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toMatch(/unknown role `architect`/);
  });

  it("comments when the number is a pull request, not an issue", async () => {
    const gh = fakeGh({ ok: true, status: 200, data: { number: 5, title: "t", pull_request: {} } });
    await main(env(), gh);
    expect(gh.comments[0]).toMatch(/#5 is a pull request, not an issue/);
  });

  it("stays silent without an issue number or PR number, since there is nowhere to comment", async () => {
    const gh = fakeGh({ ok: true, status: 200, data: {} });
    await main(env({ INPUT_ISSUE_NUMBER: "", INPUT_PR_NUMBER: "" }), gh);
    expect(gh.comments).toEqual([]);
  });

  it("comments on PR when fetchPR fails (#809)", async () => {
    const gh = {
      comments: [],
      async call(method, path, body) {
        if (method === "POST") {
          this.comments.push(body.body);
          return { ok: true, status: 201 };
        }
        return { ok: false, status: 404 };
      },
      async all() {
        return { ok: true, items: [] };
      },
    };
    await main(env({ INPUT_ISSUE_NUMBER: "", INPUT_PR_NUMBER: "42" }), gh);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toMatch(/could not read pull request #42/);
  });

  it("comments when both issue_number and pr_number are passed", async () => {
    const gh = fakeGh({ ok: true, status: 200, data: {} });
    await main(env({ INPUT_ISSUE_NUMBER: "5", INPUT_PR_NUMBER: "10" }), gh);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toMatch(/pass either issue_number or pr_number, not both/);
  });

  it("comments when the PR head branch is missing", async () => {
    const gh = {
      comments: [],
      async call(method, path, body) {
        if (method === "POST") {
          this.comments.push(body.body);
          return { ok: true, status: 201 };
        }
        return { ok: true, status: 200, data: { number: 42, head: {} } };
      },
      async all() {
        return { ok: true, items: [] };
      },
    };
    await main(env({ INPUT_ISSUE_NUMBER: "", INPUT_PR_NUMBER: "42" }), gh);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toMatch(/the PR's head branch is missing/);
  });

  it("comments when the PR is from a fork", async () => {
    const gh = {
      comments: [],
      async call(method, path, body) {
        if (method === "POST") {
          this.comments.push(body.body);
          return { ok: true, status: 201 };
        }
        return {
          ok: true,
          status: 200,
          data: { number: 42, head: { ref: "fix-bug", repo: { full_name: "forker/r" } } },
        };
      },
      async all() {
        return { ok: true, items: [] };
      },
    };
    await main(env({ INPUT_ISSUE_NUMBER: "", INPUT_PR_NUMBER: "42", GITHUB_REPOSITORY: "o/r" }), gh);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toMatch(/PRs from forks are not supported/);
  });

  it("comments when the PR head branch name starts with '-'", async () => {
    const gh = {
      comments: [],
      async call(method, path, body) {
        if (method === "POST") {
          this.comments.push(body.body);
          return { ok: true, status: 201 };
        }
        return {
          ok: true,
          status: 200,
          data: { number: 42, head: { ref: "--upload-pack", repo: { full_name: "o/r" } } },
        };
      },
      async all() {
        return { ok: true, items: [] };
      },
    };
    await main(env({ INPUT_ISSUE_NUMBER: "", INPUT_PR_NUMBER: "42", GITHUB_REPOSITORY: "o/r" }), gh);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toMatch(/invalid head branch name/);
  });
});

// #858 review: the premise stop wired through main(), not just premiseStop() alone. It
// returns before the checkout is handed to the agent's user, so nothing here needs sudo.
describe("main: premise stop", () => {
  it("reads the base from the repo's docs and stops on a wrong-base issue, with no PR", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrokin-main-"));
    const ws = join(root, "ws");
    mkdirSync(join(root, "agent"), { recursive: true });
    mkdirSync(ws);
    const g = (...a) => spawnSync("git", a, { cwd: ws, env: { PATH: process.env.PATH, HOME: root }, encoding: "utf8" });
    g("init", "-q", "-b", "main");
    writeFileSync(join(ws, "CLAUDE.md"), "Open PRs against `main`.\n");
    g("add", "-A");
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    const issue = {
      number: 5,
      title: "Extend compression",
      labels: [],
      body: "Extend `decideCompression` in `src/compress-policy.ts`, documented in `docs/compression.md`.",
    };
    const posted = [];
    const gh = {
      async call(method, path, body) {
        if (method === "POST") return posted.push({ path, body: body.body }), { ok: true, status: 201, data: {} };
        if (path === "/repos/o/r/issues/5") return { ok: true, status: 200, data: issue };
        if (path === "/repos/o/r") return { ok: true, status: 200, data: { default_branch: "main" } };
        return { ok: true, status: 200, data: [] };
      },
      async all() {
        return { ok: true, items: [] };
      },
    };
    await main(env({ GITHUB_WORKSPACE: ws, RUNNER_TEMP: root, INPUT_AGENT_DIR: join(root, "agent"), GITHUB_REF_NAME: "main", PATH: process.env.PATH }), gh);
    rmSync(root, { recursive: true, force: true });
    expect(posted).toHaveLength(1);
    expect(posted[0].path).toBe("/repos/o/r/issues/5/comments");
    expect(posted[0].body).toContain("isn't on `main` (`CLAUDE.md` says so)");
    expect(posted[0].body).toContain("(3 of the 3 names the issue gives)");
    expect(posted.some((p) => p.path.endsWith("/pulls"))).toBe(false);
  });
});

// #1039: the builder-fix split (#809) declared `taskFile` inside each branch, so
// every run died with `ReferenceError: taskFile is not defined` where isolation reads
// it — green job, no PR, no comment. Isolation itself is injected: on a sudo-capable
// Linux runner the real prepare() would proceed into user setup and pi.
describe("main: task file in scope past setup", () => {
  it("reaches isolation with the task file, and comments when isolation refuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrokin-main-"));
    const ws = join(root, "ws");
    mkdirSync(join(root, "agent"), { recursive: true });
    mkdirSync(ws);
    const g = (...a) => spawnSync("git", a, { cwd: ws, env: { PATH: process.env.PATH, HOME: root }, encoding: "utf8" });
    g("init", "-q", "-b", "main");
    writeFileSync(join(ws, "README.md"), "hello\n");
    g("add", "-A");
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    // Plain words, no backticks: the issue names nothing, so no premise stop.
    const issue = { number: 5, title: "Say hello", labels: [], body: "Greet every visitor warmly." };
    const posted = [];
    const gh = {
      async call(method, path, body) {
        if (method === "POST") return posted.push({ path, body: body.body }), { ok: true, status: 201, data: {} };
        if (path === "/repos/o/r/issues/5") return { ok: true, status: 200, data: issue };
        if (path === "/repos/o/r") return { ok: true, status: 200, data: { default_branch: "main" } };
        return { ok: true, status: 200, data: [] };
      },
      async all() {
        return { ok: true, items: [] };
      },
    };
    const seen = [];
    await main(
      env({ GITHUB_WORKSPACE: ws, RUNNER_TEMP: root, INPUT_AGENT_DIR: join(root, "agent"), GITHUB_REF_NAME: "main", PATH: process.env.PATH }),
      gh,
      { prepare: (args) => (seen.push(args), { ok: false, reason: "no isolation in tests" }) },
    );
    rmSync(root, { recursive: true, force: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].readable).toContain(join(root, "wrokin-agent", "task.md"));
    expect(posted).toHaveLength(1);
    expect(posted[0].path).toBe("/repos/o/r/issues/5/comments");
    expect(posted[0].body).toContain("didn't run");
  });
});

// #1039: the entry point's catch used to log the crash and exit 0, so a crash
// looked exactly like this issue — a green job, no PR, no comment. It comments now.
describe("reportCrash", () => {
  it("comments the crash on the issue, truncated to one line with the run link", async () => {
    const gh = fakeGh({ ok: true, status: 200, data: {} });
    await reportCrash(env(), new Error("taskFile is not defined\n    at main (main.mjs:261:16)"), gh);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toContain("crashed before it could finish");
    expect(gh.comments[0]).toContain("taskFile is not defined");
    expect(gh.comments[0]).not.toContain("at main");
    expect(gh.comments[0]).toContain("https://github.com/o/r/actions/runs/9");
  });

  it("targets the PR on a fix run", async () => {
    const calls = [];
    const gh = {
      async call(method, path, body) {
        calls.push(path);
        return { ok: true, status: 201, data: {} };
      },
    };
    await reportCrash(env({ INPUT_ISSUE_NUMBER: "", INPUT_PR_NUMBER: "42" }), "boom", gh);
    expect(calls).toEqual(["/repos/o/r/issues/42/comments"]);
  });

  it("stays silent without an issue number or PR number, since there is nowhere to comment", async () => {
    const gh = fakeGh({ ok: true, status: 200, data: {} });
    await reportCrash(env({ INPUT_ISSUE_NUMBER: "", INPUT_PR_NUMBER: "" }), new Error("x"), gh);
    expect(gh.comments).toEqual([]);
  });
});
