import { describe, it, expect } from "vitest";
import { modelsJson, piEnv, resolveThinking, scrubbedEnv, wantsThinkingSwitch } from "./pi-config.mjs";
import { cacheReadShare, errorCode, formatBytes, formatTopTools, piArgs, summarize, toolBytes, UNCACHED_ISSUE, UNCACHED_SHARE } from "./run-pi.mjs";
import { buildJobSummary } from "./publish.mjs";
import { client, fetchIssue, fetchPR, prTaskMarkdown, taskMarkdown } from "./github.mjs";
import { failureComment } from "./report-failure.mjs";

describe("pi-config", () => {
  // #804: the switch reaches only lanes (Cruise strips it per member) and DeepSeek.
  it("sends the thinking switch only to lanes and DeepSeek", () => {
    expect(wantsThinkingSwitch("bb/builder")).toBe(true);
    expect(wantsThinkingSwitch("bb-adm/code-review")).toBe(true);
    expect(wantsThinkingSwitch("workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813")).toBe(true);
    expect(wantsThinkingSwitch("mistral/codestral-2508")).toBe(false);
    expect(wantsThinkingSwitch("openai/gpt-6-astra")).toBe(false);
  });

  it("resolves thinking setting correctly (#865)", () => {
    expect(resolveThinking("off", "bb/builder")).toBe(true);
    expect(resolveThinking("off", "mistral/codestral-2508")).toBe(true);
    expect(resolveThinking("on", "bb/builder")).toBe(false);
    expect(resolveThinking("on", "mistral/codestral-2508")).toBe(false);
    expect(resolveThinking("default", "bb/builder")).toBe(true);
    expect(resolveThinking("", "bb/builder")).toBe(true);
    expect(resolveThinking(null, "bb/builder")).toBe(true);
    expect(resolveThinking("default", "mistral/codestral-2508")).toBe(false);
    expect(resolveThinking("", "mistral/codestral-2508")).toBe(false);
  });

  it("writes the key and session as env placeholders, never values", () => {
    const m = modelsJson("bb/builder", "https://cruise.example/v1").providers.cruise;
    expect(m.apiKey).toBe("$CRUISE_API_KEY");
    expect(m.headers).toEqual({ "x-cruise-class": "agentic", "x-cruise-session": "$CRUISE_SESSION" });
    expect(m.compat).toMatchObject({ maxTokensField: "max_tokens", thinkingFormat: "deepseek" });
    expect(modelsJson("mistral/codestral-2508", "x").providers.cruise.compat.thinkingFormat).toBeUndefined();
  });

  it("keeps every GitHub and runner token out of the agent's environment", () => {
    const env = {
      PATH: "/bin",
      HOME: "/home/runner",
      GITHUB_TOKEN: "decoy-env-token",
      ACTIONS_RUNTIME_TOKEN: "rt",
      // The OIDC request pair the check-in uses (#813). Either one lets the holder mint
      // an OIDC token for this run, so neither may reach pi or the commands it runs.
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/x?api-version=1",
      // The run's GitHub token: the wrokin App token from check-in (#817), else GITHUB_TOKEN.
      INPUT_GITHUB_TOKEN: "ghs_decoy_checkin_token",
      INPUT_CRUISE_API_KEY: "sk",
      MY_SECRET: "s",
    };
    const out = scrubbedEnv(env);
    expect(out.PATH).toBe("/bin");
    expect(Object.values(out)).not.toContain("decoy-env-token");
    for (const k of Object.keys(env).filter((k) => k !== "PATH" && k !== "HOME")) expect(out[k]).toBeUndefined();
    // pi itself gets the Cruise key (it calls Cruise), the verify step does not.
    expect(piEnv(env, { agentDir: "/a", cruiseKey: "sk", session: "s1" }).CRUISE_API_KEY).toBe("sk");
    expect(out.CRUISE_API_KEY).toBeUndefined();
    const pi = piEnv(env, { agentDir: "/a", cruiseKey: "sk", session: "s1" });
    expect(pi.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    expect(pi.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
    expect(Object.values(pi)).not.toContain("oidc");
    expect(Object.values(pi)).not.toContain("ghs_decoy_checkin_token");
  });
});

describe("scrubbedEnv: toolchains", () => {
  // setup-java / setup-python / setup-go export these; without them the repo's own build
  // can't find its compiler (#812 review). A credential-sounding name never passes.
  it("passes toolchain paths and still drops anything credential-shaped", () => {
    const out = scrubbedEnv({
      JAVA_HOME: "/jdk",
      JAVA_HOME_17_X64: "/jdk17",
      LD_LIBRARY_PATH: "/py/lib",
      pythonLocation: "/py",
      GOROOT: "/go",
      NODE_OPTIONS: "--max-old-space-size=4096",
      NODE_AUTH_TOKEN: "npm-secret",
      NPM_TOKEN: "npm-secret",
      GOPRIVATE_AUTH: "x",
      RANDOM_VAR: "x",
    });
    expect(out).toMatchObject({ JAVA_HOME: "/jdk", JAVA_HOME_17_X64: "/jdk17", LD_LIBRARY_PATH: "/py/lib", pythonLocation: "/py", GOROOT: "/go", NODE_OPTIONS: "--max-old-space-size=4096" });
    for (const k of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "GOPRIVATE_AUTH", "RANDOM_VAR"]) expect(out[k]).toBeUndefined();
  });
});

describe("piArgs", () => {
  it("loads the action's own extensions explicitly, before the prompt (#857)", () => {
    const a = piArgs({ model: "m", rolePrompt: "/r.md", taskFile: "/t.md", thinking: false, extensions: ["/act/check-gate.mjs"] });
    expect(a.slice(a.indexOf("-e"), a.indexOf("-e") + 2)).toEqual(["-e", "/act/check-gate.mjs"]);
    expect(a.indexOf("-e")).toBeLessThan(a.indexOf("@/t.md"));
    expect(piArgs({ model: "m", rolePrompt: "/r.md", taskFile: "/t.md", thinking: false })).not.toContain("-e");
  });

  it("runs non-interactively, untrusting the repo's .pi config", () => {
    const a = piArgs({ model: "bb/builder", rolePrompt: "/r.md", taskFile: "/t.md", thinking: true });
    expect(a).toEqual(expect.arrayContaining(["--no-session", "--no-approve", "--mode", "json", "@/t.md"]));
    expect(a.slice(a.indexOf("--thinking"), a.indexOf("--thinking") + 2)).toEqual(["--thinking", "off"]);
    expect(piArgs({ model: "m", rolePrompt: "r", taskFile: "t", thinking: false })).not.toContain("--thinking");
  });
});

describe("toolBytes & formatBytes (#860)", () => {
  it("measures the content pi sends the model: text and image blocks, not details", () => {
    expect(toolBytes(null)).toBe(0);
    expect(toolBytes(undefined)).toBe(0);
    expect(toolBytes({ content: [{ type: "text", text: "foo" }, { type: "text", text: "bar" }] })).toBe(6);
    expect(toolBytes({ content: [{ type: "text", text: "é" }] })).toBe(2);
    expect(toolBytes({ content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] })).toBe(8);
    expect(toolBytes({ content: [{ type: "text", text: "ok" }], details: { diff: "x".repeat(5000) } })).toBe(2);
    // Shapes pi never emits measure as nothing rather than as a guess.
    expect(toolBytes("hello")).toBe(0);
    expect(toolBytes({ content: "defg" })).toBe(0);
  });

  it("formats bytes compactly", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(-1)).toBe("0 KB");
    expect(formatBytes(500)).toBe("<1 KB");
    expect(formatBytes(412 * 1024)).toBe("412 KB");
    expect(formatBytes(61 * 1024)).toBe("61 KB");
    expect(formatBytes(9 * 1024)).toBe("9 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
  });

  it("formats top tools sorted by bytes descending", () => {
    const tools = {
      read: { calls: 10, bytes: 412 * 1024 },
      bash: { calls: 5, bytes: 61 * 1024 },
      grep: { calls: 2, bytes: 9 * 1024 },
      find: { calls: 1, bytes: 2 * 1024 },
    };
    expect(formatTopTools(tools, 3)).toBe("read 412 KB · bash 61 KB · grep 9 KB");
    expect(formatTopTools({})).toBe("");
    expect(formatTopTools({ read: { calls: 1, bytes: 0 } })).toBe("read 0 KB");
  });
});

describe("summarize", () => {
  const ev = (o) => JSON.stringify(o);
  it("reads the last answer, tool calls, tokens and errors from the event stream", () => {
    const jsonl = [
      ev({ type: "session", id: "x" }),
      "not json",
      ev({ type: "tool_execution_end", toolName: "bash", isError: false }),
      ev({ type: "tool_execution_end", toolName: "edit", isError: true }),
      ev({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }], usage: { input: 10, output: 2 } } }),
      ev({ type: "message_end", message: { role: "user", content: "ignored" } }),
      ev({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "## Done" }], usage: { input: 30, output: 5 } } }),
      ev({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401: bad key" } }),
    ].join("\n");
    expect(summarize(jsonl)).toEqual({
      finalText: "## Done",
      toolCalls: 2,
      failedToolCalls: 1,
      input: 40,
      cached: 0,
      cacheRead: 0,
      turns: 3,
      output: 7,
      errors: ["401: bad key"],
      cutoff: { message: "401: bad key", code: null },
      tools: {
        bash: { calls: 1, bytes: 0 },
        edit: { calls: 1, bytes: 0 },
      },
      failedEdits: 1,
      gateRounds: 0,
      cappedReads: 0,
    });
  });

  // #860: per-tool counts and bytes, failed edits, gate rounds on a fixture stream
  it("records per-tool { calls, bytes }, failed edits and gate rounds from a fixture stream", () => {
    const jsonl = [
      ev({ type: "session", id: "s1" }),
      ev({ type: "tool_execution_end", toolName: "read", result: { content: [{ type: "text", text: "x".repeat(412 * 1024) }] }, isError: false }),
      ev({ type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "b".repeat(61 * 1024) }] }, isError: false }),
      ev({ type: "tool_execution_end", toolName: "grep", result: { content: [{ type: "text", text: "g".repeat(9 * 1024) }] }, isError: false }),
      ev({ type: "tool_execution_end", toolName: "edit", result: { content: [{ type: "text", text: "could not match text" }] }, isError: true }),
      ev({ type: "tool_execution_end", toolName: "edit", result: { content: [{ type: "text", text: "e".repeat(1024) }] }, isError: false }),
      ev({ type: "tool_execution_end", toolName: "read", result: { content: [{ type: "text", text: "c".repeat(1024) }], details: { wrokinReadCap: { cap: 1024 } } }, isError: false }),
      ev({
        type: "entry_appended",
        entry: { type: "custom_message", customType: "wrokin-check-gate", content: "typecheck failed round 1", display: true },
      }),
      ev({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }], usage: { input: 100, output: 20 } } }),
    ].join("\n");
    const s = summarize(jsonl);
    expect(s.tools).toEqual({
      read: { calls: 2, bytes: 413 * 1024 },
      bash: { calls: 1, bytes: 61 * 1024 },
      grep: { calls: 1, bytes: 9 * 1024 },
      edit: { calls: 2, bytes: Buffer.byteLength("could not match text") + 1024 },
    });
    expect(s.failedEdits).toBe(1);
    expect(s.gateRounds).toBe(1);
    expect(s.cappedReads).toBe(1); // #861
    expect(formatTopTools(s.tools, 3)).toBe("read 413 KB · bash 61 KB · grep 9 KB");
    // Invariant: no content is recorded, only counts and sizes (#860)
    for (const [name, stats] of Object.entries(s.tools)) {
      expect(Object.keys(stats)).toEqual(["calls", "bytes"]);
    }
  });

  // #870: pi 1.0.4 carries the gate's hand-back only as `entry_appended`; the other
  // shapes were speculative and must not count, or a future echo would double-count.
  it("counts gate rounds from entry_appended only", () => {
    const entry = { type: "custom_message", customType: "wrokin-check-gate", content: "x", display: true };
    const jsonl = [
      ev({ type: "entry_appended", entry }),
      ev({ type: "entry_appended", entry }),
      ev({ type: "custom_message", customType: "wrokin-check-gate" }),
      ev({ type: "message_end", message: { role: "custom", customType: "wrokin-check-gate", content: "x" } }),
    ].join("\n");
    expect(summarize(jsonl).gateRounds).toBe(2);
  });

  // #822: the #667 run's last call, verbatim in shape. pi exits 0 after it, so this is
  // the only record that the agent was stopped rather than finished.
  const walletRefusal =
    '429: {"message":"Tenant \'bb-adm\' has 0.2653 of credit and this request must hold 0.2861 before it is sent.",' +
    '"type":"insufficient_quota","param":null,"code":"wallet_exhausted"}';

  it("marks a run whose last call failed as cut off, with the provider's code", () => {
    const jsonl = [
      ev({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 1850, output: 114, cacheRead: 512 } } }),
      ev({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 583, output: 177, cacheRead: 2432, cacheWrite: 10 } } }),
      ev({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: walletRefusal, usage: { input: 0, output: 0 } } }),
    ].join("\n");
    const s = summarize(jsonl);
    expect(s.cutoff).toEqual({ message: walletRefusal, code: "wallet_exhausted" });
    // Cached input is counted, not dropped: on #820 it was 1.79M of 1.84M input tokens.
    expect(s).toMatchObject({ input: 2433, cached: 2954, output: 291 });
  });

  it("does not call a run cut off when pi recovered from an error and carried on", () => {
    const jsonl = [
      ev({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "502: upstream" } }),
      ev({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "## Done" }], usage: { input: 5, output: 1 } } }),
    ].join("\n");
    const s = summarize(jsonl);
    expect(s.cutoff).toBeNull();
    expect(s.errors).toEqual(["502: upstream"]);
  });

  it("reads the code from a provider error, and nothing from one without", () => {
    expect(errorCode(walletRefusal)).toBe("wallet_exhausted");
    expect(errorCode("socket hang up")).toBeNull();
    expect(errorCode(undefined)).toBeNull();
  });

  // #823 review: a body that embeds an upstream error object must yield the envelope's
  // code, not the first "code" in the text.
  it("takes the envelope's code over one nested before it", () => {
    const nested = '429: {"upstream":{"code":"rate_limited"},"message":"m","code":"wallet_exhausted"}';
    expect(errorCode(nested)).toBe("wallet_exhausted");
    expect(errorCode('400: {"error":{"message":"m","type":"t","code":"context_length_exceeded"}}')).toBe("context_length_exceeded");
    expect(errorCode('500: {"message":"no code here"}')).toBeNull();
    expect(errorCode('502: upstream said "code": "bad_gateway" in prose')).toBe("bad_gateway");
  });

  // #823 review: whatever order the message_ends arrive in, pi's final agent_end settles
  // whether the run ended on a failed call. One with willRetry is not final.
  it("lets the final agent_end decide, and ignores one pi will retry after", () => {
    const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: walletRefusal };
    const done = { role: "assistant", content: [{ type: "text", text: "## Done" }], stopReason: "stop" };
    const flushedAfter = [
      ev({ type: "message_end", message: failed }),
      ev({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } }),
      ev({ type: "agent_end", willRetry: false, messages: [{ role: "user", content: "task" }, failed] }),
    ].join("\n");
    expect(summarize(flushedAfter).cutoff).toEqual({ message: walletRefusal, code: "wallet_exhausted" });

    const retried = [
      ev({ type: "message_end", message: failed }),
      ev({ type: "agent_end", willRetry: true, messages: [failed] }),
      ev({ type: "message_end", message: done }),
      ev({ type: "agent_end", willRetry: false, messages: [failed, done] }),
    ].join("\n");
    expect(summarize(retried).cutoff).toBeNull();
  });
});

describe("github", () => {
  it("builds the task from the issue and human comments only", () => {
    const md = taskMarkdown("o/r", { number: 7, title: "Fix it", body: "Steps" }, [
      { user: { login: "alice", type: "User" }, body: "Also X" },
      { user: { login: "wrokin[bot]", type: "Bot" }, body: "triage noise" },
    ]);
    expect(md).toContain("# Issue #7 in o/r: Fix it");
    expect(md).toContain("### @alice\n\nAlso X");
    expect(md).not.toContain("triage noise");
  });

  it("refuses a pull request number", async () => {
    const gh = { call: async () => ({ ok: true, data: { number: 3, pull_request: {} } }), all: async () => ({ items: [] }) };
    expect((await fetchIssue(gh, "o/r", 3)).error).toMatch(/pull request/);
  });

  it("pages through comments until a short page", async () => {
    const seen = [];
    const gh = client("t", async (url) => {
      seen.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      const n = page === 1 ? 100 : 3;
      return { status: 200, json: async () => Array.from({ length: n }, (_, i) => ({ id: i })) };
    });
    const r = await gh.all("/repos/o/r/issues/1/comments");
    expect(r.items).toHaveLength(103);
    expect(seen).toHaveLength(2);
  });

  it("builds the PR task from PR metadata, failing checks, and review comments (#809)", () => {
    const pr = {
      number: 42,
      title: "Add widget",
      body: "Implements widget feature",
      head: { ref: "feat/widget", sha: "abcdef123456" },
      base: { ref: "dev" },
    };
    const reviewComments = [
      {
        path: "src/widget.ts",
        line: 15,
        user: { login: "reviewer1" },
        diff_hunk: "@@ -10,6 +10,7 @@\n+const x = null;",
        body: "Missing null check here",
      },
    ];
    const issueComments = [
      { user: { login: "human", type: "User" }, body: "Please take a look" },
      { user: { login: "bot", type: "Bot" }, body: "bot comment" },
    ];
    const failingChecks = [
      {
        name: "test",
        conclusion: "failure",
        output: {
          title: "Unit tests failed",
          summary: "1 test failed",
          text: "src/widget.test.ts: FAIL",
        },
      },
    ];

    const md = prTaskMarkdown("o/r", pr, { reviewComments, issueComments, failingChecks });
    expect(md).toContain("# Pull Request #42 in o/r: Add widget");
    expect(md).toContain("- **Head branch:** `feat/widget` (abcdef1)");
    expect(md).toContain("- **Base branch:** `dev`");
    expect(md).toContain("## Failing Checks / CI");
    expect(md).toContain("### `test` (failure) — Unit tests failed");
    expect(md).toContain("src/widget.test.ts: FAIL");
    expect(md).toContain("## Review Comments");
    expect(md).toContain("### @reviewer1 on `src/widget.ts:15`");
    expect(md).toContain("Missing null check here");
    expect(md).toContain("### @human\n\nPlease take a look");
    expect(md).not.toContain("bot comment");
  });

  it("fetches PR metadata, paginated comments and failing checks (#809)", async () => {
    const calls = [];
    const gh = {
      call: async (method, path) => {
        calls.push({ method, path });
        if (path === "/repos/o/r/pulls/42") {
          return {
            ok: true,
            status: 200,
            data: {
              number: 42,
              title: "Fix bug",
              head: { ref: "fix/bug", sha: "11223344" },
              base: { ref: "main" },
            },
          };
        }
        if (path === "/repos/o/r/commits/11223344/check-runs") {
          return {
            ok: true,
            status: 200,
            data: {
              check_runs: [
                { name: "lint", conclusion: "success" },
                { name: "test", conclusion: "failure", output: { summary: "3 failed" } },
              ],
            },
          };
        }
        return { ok: false, status: 404 };
      },
      all: async (path) => {
        calls.push({ method: "ALL", path });
        if (path === "/repos/o/r/pulls/42/comments") {
          return { ok: true, items: [{ id: 101, body: "fix this" }] };
        }
        if (path === "/repos/o/r/issues/42/comments") {
          return { ok: true, items: [{ id: 201, body: "human comment" }] };
        }
        return { ok: true, items: [] };
      },
    };

    const res = await fetchPR(gh, "o/r", 42);
    expect(res.error).toBeUndefined();
    expect(res.pr.number).toBe(42);
    expect(res.reviewComments).toHaveLength(1);
    expect(res.issueComments).toHaveLength(1);
    expect(res.failingChecks).toHaveLength(1);
    expect(res.failingChecks[0].name).toBe("test");
  });

  it("handles fetchPR errors gracefully (#809)", async () => {
    const gh = {
      call: async () => ({ ok: false, status: 404 }),
      all: async () => ({ ok: true, items: [] }),
    };
    const res = await fetchPR(gh, "o/r", 999);
    expect(res.error).toMatch(/could not read pull request #999/);
  });
});

describe("report-failure", () => {
  it("quotes the recorded reason, or points at the log", () => {
    expect(failureComment("No Cruise key.", "https://run")).toContain("No Cruise key.");
    expect(failureComment("", "https://run")).toContain("see the run log");
  });
});

// #865: two measured runs were pinned to a Cruise member that never cached (cruise#662).
describe("cacheReadShare (#865)", () => {
  // pi's `input` is the uncached part, `cacheRead` apart (a real turn: 269 + 11,264).
  it("is cache reads over the whole prompt, from pi's own usage fields", () => {
    const jsonl = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 269, cacheRead: 11264, cacheWrite: 0, output: 40 } } });
    const s = summarize(jsonl);
    expect(s).toMatchObject({ input: 269, cacheRead: 11264, turns: 1 });
    expect(cacheReadShare(s)).toBeCloseTo(11264 / 11533);
  });

  it("handles the edges", () => {
    expect(cacheReadShare({ input: 0, cacheRead: 0 })).toBeNull();
    expect(cacheReadShare({})).toBeNull();
    expect(cacheReadShare({ input: 0, cacheRead: 500 })).toBe(1);
    expect(cacheReadShare({ input: 500 })).toBe(0);
    expect(cacheReadShare({ input: 50, cacheRead: 50 })).toBe(UNCACHED_SHARE);
  });

  it("is shown in the job summary, flagged when the provider barely cached the run", () => {
    const md = (s) => buildJobSummary({ summary: { toolCalls: 0, tools: {}, ...s }, runId: "1" });
    expect(md({ input: 1000, cacheRead: 9000, turns: 12 })).toContain("| Read from prompt cache | 90% |");
    const low = md({ input: 147545, cacheRead: 1856, turns: 9 });
    expect(low).toContain("| Read from prompt cache | ⚠️ 1%: the provider barely cached this run");
    expect(low).toContain(UNCACHED_ISSUE);
    // Exactly at the line is not below it; a short run is still warming the cache.
    expect(md({ input: 50, cacheRead: 50, turns: 9 })).toContain("| Read from prompt cache | 50% |");
    expect(md({ input: 3000, cacheRead: 500, turns: 2 })).toContain("| Read from prompt cache | 14% |");
    expect(md({ input: 0, cacheRead: 0, turns: 0 })).not.toContain("prompt cache");
  });
});
