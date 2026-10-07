import { describe, it, expect } from "vitest";
import { modelsJson, piEnv, scrubbedEnv, wantsThinkingSwitch } from "./pi-config.mjs";
import { errorCode, piArgs, summarize } from "./run-pi.mjs";
import { client, fetchIssue, taskMarkdown } from "./github.mjs";
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
  it("runs non-interactively, untrusting the repo's .pi config", () => {
    const a = piArgs({ model: "bb/builder", rolePrompt: "/r.md", taskFile: "/t.md", thinking: true });
    expect(a).toEqual(expect.arrayContaining(["--no-session", "--no-approve", "--mode", "json", "@/t.md"]));
    expect(a.slice(a.indexOf("--thinking"), a.indexOf("--thinking") + 2)).toEqual(["--thinking", "off"]);
    expect(piArgs({ model: "m", rolePrompt: "r", taskFile: "t", thinking: false })).not.toContain("--thinking");
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
      output: 7,
      errors: ["401: bad key"],
      cutoff: { message: "401: bad key", code: null },
    });
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
});

describe("report-failure", () => {
  it("quotes the recorded reason, or points at the log", () => {
    expect(failureComment("No Cruise key.", "https://run")).toContain("No Cruise key.");
    expect(failureComment("", "https://run")).toContain("see the run log");
  });
});
