// One Builder-family run, start to finish (#805). Never fails the job: every outcome,
// including a broken setup, ends as a comment on the issue and exit 0.
//
//   context (GitHub token) → branch → hand the checkout to the agent's user (#832)
//     → pi as that user (Cruise only) → commit leftovers + verify, as that user
//     → copy the commits out → push + PR (GitHub token) → take the checkout back
//
// The GitHub token is the wrokin App token from check-in (#817), else GITHUB_TOKEN.
// This process holds it, so nothing the agent runs may run as this process's user.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { client, fetchIssue, taskMarkdown } from "./github.mjs";
import { modelsJson, piEnv, scrubbedEnv, wantsThinkingSwitch } from "./pi-config.mjs";
import { piArgs, runPi, summarizeFile } from "./run-pi.mjs";
import { sh, verify } from "./verify.mjs";
import { asPiUser, cleanUp, killPiProcesses, piHome, prepare, reclaim, restoreLocalAction } from "./isolate.mjs";
import {
  branchName,
  collectCommits,
  cutoffReason,
  dropCheckoutCredentials,
  excludeAgentLogs,
  finalizeCommits,
  git,
  isReady,
  openPr,
  prBody,
  pushBranch,
  runnerGitEnv,
  saveAgentLogs,
} from "./publish.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** `spawn`, but the child runs as the agent's user. */
const spawnAsPi = (file, args, opts) => {
  const w = asPiUser(file, args, opts.env);
  return spawn(w.file, w.args, { ...opts, env: w.env });
};

/** `git`, run as the agent's user: for the checkout it owns. */
const gitAsPi = (args, { cwd, env }) => {
  const w = asPiUser("git", args, env);
  const r = spawnSync(w.file, w.args, { cwd, env: w.env, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};
const ROLES = new Set(["builder"]);

export function readInputs(env) {
  const minutes = Number.parseInt(env.INPUT_TIMEOUT_MINUTES ?? "", 10);
  return {
    role: env.INPUT_ROLE || "builder",
    issue: Number.parseInt(env.INPUT_ISSUE_NUMBER ?? "", 10),
    model: env.INPUT_MODEL,
    baseUrl: env.INPUT_CRUISE_BASE_URL,
    cruiseKey: env.INPUT_CRUISE_API_KEY,
    token: env.INPUT_GITHUB_TOKEN,
    testCommand: env.INPUT_TEST_COMMAND ?? "",
    timeoutMs: (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000,
    pi: env.INPUT_PI,
    agentDir: env.INPUT_AGENT_DIR,
    repo: env.GITHUB_REPOSITORY,
    workspace: env.GITHUB_WORKSPACE,
    runId: env.GITHUB_RUN_ID,
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    temp: join(env.RUNNER_TEMP ?? "/tmp", "wrokin-agent"),
  };
}

/**
 * One budget for install + test together, separate from the agent's: capped so the
 * agent's limit plus verify always fits the workflow's job timeout, and publish runs.
 */
export const verifyBudget = (agentMs) => Math.min(agentMs, 20 * 60_000);

async function comment(gh, i, body) {
  await gh.call("POST", `/repos/${i.repo}/issues/${i.issue}/comments`, { body });
}

export async function main(env = process.env, gh = client(env.INPUT_GITHUB_TOKEN)) {
  const i = readInputs(env);
  if (!Number.isInteger(i.issue) || i.issue < 1) return console.log("::error::issue_number is required");
  if (!ROLES.has(i.role)) {
    console.log(`::error::unknown role "${i.role}"`);
    return comment(gh, i, `⚠️ wrokin Builder couldn't start: unknown role \`${i.role}\`. [Run](${i.runUrl})`);
  }

  const ctx = await fetchIssue(gh, i.repo, i.issue);
  if (ctx.error) {
    // Unreadable issue: try the comment anyway (a PR number is readable, for one).
    console.log(`::error::${ctx.error}`);
    return comment(gh, i, `⚠️ wrokin Builder couldn't start: ${ctx.error}. [Run](${i.runUrl})`);
  }

  mkdirSync(i.temp, { recursive: true });
  const taskFile = join(i.temp, "task.md");
  writeFileSync(taskFile, taskMarkdown(i.repo, ctx.issue, ctx.comments));
  writeFileSync(join(i.agentDir, "models.json"), JSON.stringify(modelsJson(i.model, i.baseUrl), null, 2));

  // Work on our own branch in the job's checkout, after removing every credential
  // checkout left behind, so nothing pi runs can push with, or read, the job's token.
  const gitEnv = scrubbedEnv(env);
  const base = git(["rev-parse", "HEAD"], { cwd: i.workspace, env: gitEnv }).out;
  const baseRef = env.INPUT_BASE_BRANCH || env.GITHUB_REF_NAME;
  const branch = branchName(i.role, i.issue, i.runId);
  const dropped = dropCheckoutCredentials({ cwd: i.workspace, env: gitEnv, runnerTemp: env.RUNNER_TEMP });
  if (dropped.length) console.log(`removed checkout credentials before pi: ${dropped.join(", ")}`);
  excludeAgentLogs({ cwd: i.workspace, env: gitEnv });
  const co = git(["checkout", "-b", branch], { cwd: i.workspace, env: gitEnv });
  if (co.code !== 0) {
    return comment(gh, i, `⚠️ wrokin Builder couldn't start: \`git checkout\` failed. [Run](${i.runUrl})`);
  }

  // Hand the checkout to the agent's user, or run nothing (#832: fail closed).
  const home = piHome(i.temp);
  const iso = prepare({
    workspace: i.workspace,
    writable: [i.agentDir],
    readable: [taskFile, here, i.pi],
    home,
  });
  if (!iso.ok) {
    console.log(`::error title=wrokin-agent isolation::${iso.reason}`);
    return comment(
      gh,
      i,
      `⚠️ wrokin Builder didn't run: ${iso.reason}. It runs the agent as a separate user so ` +
        `nothing the agent runs can read this job's tokens, and refuses to run without that. [Run](${i.runUrl})`,
    );
  }
  try {
    return await agentRun(gh, i, { ctx, base, baseRef, branch, taskFile, home, env, gitEnv });
  } finally {
    // Nothing the agent started outlives the run, its logs leave the checkout as plain
    // files, and the checkout it wrote is deleted rather than handed back: later steps
    // run git in it as the runner, and its .git/config is the agent's now.
    cleanUp([
      ["killing the agent's processes", () => killPiProcesses()],
      ["saving the agent's logs", () => saveAgentLogs({ workspace: i.workspace, to: join(i.temp, "agent-logs") })],
      ["reclaiming the checkout", () => reclaim({ workspace: i.workspace })],
      ["restoring the local action", () => restoreLocalAction({ from: here, to: env.GITHUB_ACTION_PATH, workspace: i.workspace })],
    ]);
  }
}

/** pi, then its commits, the proof-run and the PR. The checkout belongs to the agent's user. */
async function agentRun(gh, i, { ctx, base, baseRef, branch, taskFile, home, env, gitEnv }) {
  const piGitEnv = { ...gitEnv, HOME: home };

  const eventsFile = join(i.temp, "pi-events.jsonl");
  const ran = await runPi({
    bin: i.pi,
    args: piArgs({
      model: i.model,
      rolePrompt: join(here, "roles", `${i.role}.md`),
      taskFile,
      thinking: wantsThinkingSwitch(i.model),
    }),
    env: { ...piEnv(env, { agentDir: i.agentDir, cruiseKey: i.cruiseKey, session: `wrokin-${i.runId}` }), HOME: home },
    cwd: i.workspace,
    eventsFile,
    timeoutMs: i.timeoutMs,
    spawnFn: spawnAsPi,
  });
  killPiProcesses();
  const s = summarizeFile(eventsFile);
  const usage = { input: s.input, cached: s.cached, output: s.output, toolCalls: s.toolCalls };
  console.log(
    `pi exit=${ran.code} timedOut=${ran.timedOut} tools=${s.toolCalls} tokens=${s.input}+${s.cached}cached/${s.output}`,
  );
  if (ran.stderr) console.log(ran.stderr.slice(-1500));
  // pi exits 0 after a failed model call, so this is the only place the cutoff shows (#822).
  if (s.cutoff) console.log(`::error title=wrokin-agent cut off::${cutoffReason(s.cutoff)}`);

  finalizeCommits({ cwd: i.workspace, env: piGitEnv, base, run: gitAsPi });
  // Counted from the runner's own copy, never from git inside the agent's checkout.
  const { dir: publishDir, commits } = collectCommits({
    workspace: i.workspace,
    branch,
    base,
    dir: join(i.temp, "publish.git"),
    env: gitEnv,
  });
  if (commits === 0) {
    const why = ran.code !== 0 && s.toolCalls === 0 && !s.errors.length && !s.finalText
      ? `pi failed to start (exit ${ran.code}): ${(ran.stderr || "no output").trim().slice(-300)}`
      : ran.timedOut
      ? "it ran out of time"
      : s.cutoff
        ? `it was cut off: ${cutoffReason(s.cutoff)}`
        : s.errors.length
          ? `the model call failed: ${s.errors.at(-1).slice(0, 300)}`
          : "it made no changes";
    return comment(
      gh,
      i,
      `wrokin Builder didn't open a PR for this issue: ${why}.\n\n` +
        (s.finalText ? `**What it said:**\n\n${s.finalText.slice(0, 3000)}\n\n` : "") +
        `<sub>${i.model} via Cruise · [run](${i.runUrl})</sub>`,
    );
  }

  // The tests are code the agent wrote, so they run as its user too.
  const result = await verify({
    dir: i.workspace,
    override: i.testCommand,
    env: piGitEnv,
    timeoutMs: verifyBudget(i.timeoutMs),
    run: (cmd, opts) => sh(cmd, { ...opts, spawnFn: spawnAsPi }),
  });
  killPiProcesses();
  const pushed = pushBranch({
    cwd: publishDir,
    env: runnerGitEnv(gitEnv),
    repo: i.repo,
    branch,
    token: i.token,
    ref: `refs/heads/${branch}`,
  });
  if (!pushed.ok) {
    return comment(gh, i, `⚠️ wrokin Builder made changes but couldn't push them: ${pushed.message}\n\n[Run](${i.runUrl})`);
  }
  const body = prBody({ issue: i.issue, summary: s.finalText, result, runUrl: i.runUrl, model: i.model, usage, cutoff: s.cutoff });
  const ready = isReady(result, s.cutoff);
  const pr = await openPr(gh, {
    repo: i.repo,
    base: baseRef,
    branch,
    title: `${ctx.issue.title} (#${i.issue})`.slice(0, 250),
    body,
    draft: !ready,
  });
  const tests = result.verified ? "✅ verified: the tests pass" : `⚠️ not verified: ${result.reason}`;
  // The cutoff leads: it is why the work is partial, and the test result only follows from it.
  const verdict = s.cutoff ? `⛔ cut off before the agent finished: ${cutoffReason(s.cutoff)}; ${tests}` : tests;
  if (pr.ok) {
    return comment(gh, i, `wrokin Builder opened ${ready ? "" : "a draft "}PR #${pr.number}, ${verdict}.`);
  }
  return comment(
    gh,
    i,
    `wrokin Builder pushed \`${branch}\` (${verdict}) but couldn't open the PR. ${pr.message}\n\n` +
      `[Open the PR yourself](${pr.compare}). The PR text the Builder wrote:\n\n<details><summary>PR body</summary>\n\n${body}\n\n</details>`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    // Advisory: a crash here is reported, never a red job.
    console.log(`::error title=wrokin-agent::${err?.stack ?? err}`);
  }
}
