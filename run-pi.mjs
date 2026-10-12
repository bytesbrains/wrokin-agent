// Runs pi on the task, autonomously, and summarises what it did (#805).
//
// pi runs in `--mode json` with its events written to a file: the file is the run's
// record (uploaded with the job), and the summary below is read from it rather than
// from pi's own claims about itself.
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";

/** pi's arguments. `--no-approve`: a repo's own `.pi/` config never loads into the run. */
export function piArgs({ model, rolePrompt, taskFile, thinking, extensions = [] }) {
  return [
    "--no-session",
    "--no-approve",
    ...extensions.flatMap((e) => ["-e", e]),
    "--mode", "json",
    "--provider", "cruise",
    "--model", model,
    ...(thinking ? ["--thinking", "off"] : []),
    "--append-system-prompt", rolePrompt,
    `@${taskFile}`,
    "Do the task in the attached issue, following your instructions.",
  ];
}

/** Spawns pi with a wall-clock limit. Resolves with the exit code and whether it timed out. */
export function runPi({ bin, args, env, cwd, eventsFile, timeoutMs, spawnFn = spawn }) {
  return new Promise((resolve) => {
    const out = createWriteStream(eventsFile);
    const child = spawnFn(bin, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    child.stdout.pipe(out);
    child.stderr.on("data", (d) => {
      stderr = (stderr + d.toString("utf8")).slice(-4000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      out.end();
      resolve({ code: null, timedOut, stderr: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      out.end(() => resolve({ code, timedOut, stderr }));
    });
  });
}

const textOf = (message) =>
  (Array.isArray(message?.content) ? message.content : [])
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

/**
 * The machine-readable code in a provider error (`wallet_exhausted`, …), or null.
 *
 * The envelope first: pi writes `<status>: <body>`, and the body's top-level `code`
 * (Cruise) or `error.code` (OpenAI's shape) is the refusal itself. A regex over the
 * whole text would take the first `"code"` it met, which in a body that embeds an
 * upstream error object may be that object's (#823 review). The regex is only for a
 * body that is not JSON.
 */
export function errorCode(message) {
  const text = message ?? "";
  const brace = text.indexOf("{");
  if (brace >= 0) {
    try {
      const body = JSON.parse(text.slice(brace));
      const code = body?.code ?? body?.error?.code;
      return typeof code === "string" && code ? code : null;
    } catch {
      // Not JSON after all: fall through.
    }
  }
  return /"code"\s*:\s*"([a-z_]+)"/.exec(text)?.[1] ?? null;
}

const cutoffOf = (message) =>
  message?.role === "assistant" && message.stopReason === "error"
    ? { message: message.errorMessage ?? "", code: errorCode(message.errorMessage) }
    : null;

/**
 * UTF-8 byte length of a tool result, as it reaches the model. Never retains content (#860).
 *
 * pi's `tool_execution_end.result` is an `AgentToolResult`: `{ content, details }`, with
 * `content` an array of text blocks and base64 image blocks (pi-agent-core 1.0.4 —
 * failures included, via `createErrorToolResult`). Only `content` goes into the context,
 * so only it is measured; `details` is for logs and UI.
 */
export function toolBytes(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  let bytes = 0;
  for (const b of blocks) {
    const text = b?.type === "image" ? b.data : b?.text;
    if (typeof text === "string") bytes += Buffer.byteLength(text, "utf8");
  }
  return bytes;
}

/** Formats byte size compactly: "412 KB", "9 KB", "<1 KB", "1.2 MB". */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const kb = bytes / 1024;
  if (kb < 1) return "<1 KB";
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, "") : Math.round(mb)} MB`;
}

/** Formats the top N tools sorted by bytes descending (e.g. "read 412 KB · bash 61 KB · grep 9 KB"). */
export function formatTopTools(tools = {}, limit = 3) {
  const entries = Object.entries(tools)
    .filter(([_, v]) => v && (v.bytes > 0 || v.calls > 0))
    .sort((a, b) => (b[1].bytes ?? 0) - (a[1].bytes ?? 0) || (b[1].calls ?? 0) - (a[1].calls ?? 0))
    .slice(0, limit);
  if (!entries.length) return "";
  return entries.map(([name, v]) => `${name} ${formatBytes(v.bytes ?? 0)}`).join(" · ");
}

/**
 * What the events say happened: last answer, tool use, tokens, and any provider error.
 *
 * `cutoff` is set when the LAST model call failed: pi stops there and still exits 0, so
 * without it a run Cruise refused mid-task reads as an agent that just stopped (#822).
 * An error pi recovered from is in `errors` but is not a cutoff. pi's final `agent_end`
 * (with `willRetry: false`) carries the whole transcript and settles it, whatever order
 * the `message_end`s came in (#823 review); a run killed before `agent_end` falls back
 * to the last `message_end`. `cached` is input pi
 * reports apart from `input` (cache reads and writes): on #820 it was 1.79M of 1.84M.
 *
 * Also collects context-budget per-tool figures and quality guardrails (#860): result
 * bytes and calls per tool, failed edit calls, and in-loop gate rounds. Content is
 * discarded; only counts and sizes are kept.
 */
export function summarize(jsonl) {
  const s = {
    finalText: "",
    toolCalls: 0,
    failedToolCalls: 0,
    input: 0,
    cached: 0,
    output: 0,
    errors: [],
    cutoff: null,
    tools: {},
    failedEdits: 0,
    gateRounds: 0,
    cappedReads: 0,
  };
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "tool_execution_end") {
      s.toolCalls++;
      if (e.isError) s.failedToolCalls++;
      const name = e.toolName || "unknown";
      if (!s.tools[name]) s.tools[name] = { calls: 0, bytes: 0 };
      s.tools[name].calls++;
      s.tools[name].bytes += toolBytes(e.result);
      if (e.toolName === "edit" && e.isError) s.failedEdits++;
      if (e.result?.details?.wrokinReadCap) s.cappedReads++;
    }
    // The one shape pi 1.0.4 emits for the gate's hand-back (#870): one per round.
    if (e.type === "entry_appended" && e.entry?.customType === "wrokin-check-gate") s.gateRounds++;
    if (e.type === "message_end" && e.message?.role === "assistant") {
      const text = textOf(e.message);
      if (text) s.finalText = text;
      s.input += e.message.usage?.input ?? 0;
      s.cached += (e.message.usage?.cacheRead ?? 0) + (e.message.usage?.cacheWrite ?? 0);
      s.output += e.message.usage?.output ?? 0;
      const failed = e.message.stopReason === "error";
      if (failed && e.message.errorMessage) s.errors.push(e.message.errorMessage);
      s.cutoff = cutoffOf(e.message);
    }
    if (e.type === "agent_end" && !e.willRetry && Array.isArray(e.messages)) {
      const last = e.messages.findLast((m) => m?.role === "assistant");
      if (last) s.cutoff = cutoffOf(last);
    }
  }
  return s;
}

export function summarizeFile(file) {
  try {
    return summarize(readFileSync(file, "utf8"));
  } catch {
    return summarize("");
  }
}
