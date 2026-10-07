// Runs pi on the task, autonomously, and summarises what it did (#805).
//
// pi runs in `--mode json` with its events written to a file: the file is the run's
// record (uploaded with the job), and the summary below is read from it rather than
// from pi's own claims about itself.
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";

/** pi's arguments. `--no-approve`: a repo's own `.pi/` config never loads into the run. */
export function piArgs({ model, rolePrompt, taskFile, thinking }) {
  return [
    "--no-session",
    "--no-approve",
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
 * What the events say happened: last answer, tool use, tokens, and any provider error.
 *
 * `cutoff` is set when the LAST model call failed: pi stops there and still exits 0, so
 * without it a run Cruise refused mid-task reads as an agent that just stopped (#822).
 * An error pi recovered from is in `errors` but is not a cutoff. pi's final `agent_end`
 * (with `willRetry: false`) carries the whole transcript and settles it, whatever order
 * the `message_end`s came in (#823 review); a run killed before `agent_end` falls back
 * to the last `message_end`. `cached` is input pi
 * reports apart from `input` (cache reads and writes): on #820 it was 1.79M of 1.84M.
 */
export function summarize(jsonl) {
  const s = { finalText: "", toolCalls: 0, failedToolCalls: 0, input: 0, cached: 0, output: 0, errors: [], cutoff: null };
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
    }
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
