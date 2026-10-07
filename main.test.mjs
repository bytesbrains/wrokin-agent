import { describe, it, expect } from "vitest";
import { main, readInputs, verifyBudget } from "./main.mjs";

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
    expect(i).toMatchObject({ role: "builder", issue: 5, timeoutMs: 30 * 60_000, runUrl: "https://github.com/o/r/actions/runs/9", temp: "/rt/wrokin-agent" });
    expect(readInputs(env({ INPUT_TIMEOUT_MINUTES: "-3" })).timeoutMs).toBe(30 * 60_000);
    expect(readInputs(env({ INPUT_TIMEOUT_MINUTES: "45" })).timeoutMs).toBe(45 * 60_000);
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

  it("stays silent without an issue number, since there is nowhere to comment", async () => {
    const gh = fakeGh({ ok: true, status: 200, data: {} });
    await main(env({ INPUT_ISSUE_NUMBER: "" }), gh);
    expect(gh.comments).toEqual([]);
  });
});
