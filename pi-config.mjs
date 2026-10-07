// The pi side of a run (#805): models.json for Cruise, and the environment pi runs in.
//
// Cruise facts measured live in #804:
//  - send `max_tokens`, never `max_completion_tokens`: Cruise renames it for OpenAI
//    members only, and the other vendors don't know the newer spelling;
//  - send `thinking: {type: "disabled"}` (pi's "deepseek" thinking format) only to a
//    lane or a DeepSeek model. On a lane Cruise strips it for vendors that refuse it
//    (cruise #299); a pinned model gets the body as sent, and Mistral 422s on it;
//  - `x-cruise-session` holds one lane member for the whole run.

/** Whether this model id should get pi's DeepSeek-style `thinking` switch. */
export function wantsThinkingSwitch(model) {
  return /^bb[-\w]*\//.test(model) || /deepseek/i.test(model);
}

/** pi's models.json. The key stays an env placeholder: it is never written to disk. */
export function modelsJson(model, baseUrl) {
  const thinking = wantsThinkingSwitch(model);
  return {
    providers: {
      cruise: {
        baseUrl,
        api: "openai-completions",
        apiKey: "$CRUISE_API_KEY",
        headers: { "x-cruise-class": "agentic", "x-cruise-session": "$CRUISE_SESSION" },
        compat: {
          maxTokensField: "max_tokens",
          supportsStore: false,
          supportsDeveloperRole: false,
          ...(thinking ? { thinkingFormat: "deepseek" } : {}),
        },
        models: [{ id: model, reasoning: thinking }],
      },
    },
  };
}

/**
 * Only these names reach pi and the commands it runs. An allowlist, not a denylist:
 * the runner's environment holds GITHUB_TOKEN, ACTIONS_* request tokens and whatever a
 * workflow adds, and a new secret must be kept out without anyone remembering to.
 */
const PASS_THROUGH = [
  "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI",
  "RUNNER_TOOL_CACHE", "AGENT_TOOLSDIRECTORY", "ImageOS",
];

/**
 * Toolchain locations the setup-* actions export (setup-java's JAVA_HOME, setup-python's
 * LD_LIBRARY_PATH and pythonLocation, Go, Rust, .NET, Android). Without them a repo's
 * own build can't find its compiler. Paths and settings only: see SECRET_LIKE.
 */
const TOOLCHAIN = /^(JAVA_HOME(_\w+)?|GOROOT|GOPATH|GOFLAGS|GOTOOLCHAIN|GOPROXY|pythonLocation|Python[23]?_ROOT_DIR|PKG_CONFIG_PATH|LD_LIBRARY_PATH|CARGO_HOME|RUSTUP_HOME|DOTNET_ROOT|ANDROID_(HOME|SDK_ROOT|NDK_HOME)|NODE_OPTIONS|NODE_ENV|XDG_\w+)$/;

/** Never passed, whatever matched above: a name that sounds like a credential is one. */
export const SECRET_LIKE = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|_KEY|APIKEY|PRIVATE/i;

/** The environment for a process the agent controls. `extra` is added after the allowlist. */
export function scrubbedEnv(env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || SECRET_LIKE.test(k)) continue;
    if (PASS_THROUGH.includes(k) || TOOLCHAIN.test(k)) out[k] = v;
  }
  return {
    ...out,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "wrokin Builder",
    GIT_AUTHOR_EMAIL: "builder@wrok.in",
    GIT_COMMITTER_NAME: "wrokin Builder",
    GIT_COMMITTER_EMAIL: "builder@wrok.in",
    ...extra,
  };
}

/** pi's own environment: the scrubbed one plus its config dir, the Cruise key and session. */
export function piEnv(env, { agentDir, cruiseKey, session }) {
  return scrubbedEnv(env, {
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    CRUISE_API_KEY: cruiseKey,
    CRUISE_SESSION: session,
  });
}
