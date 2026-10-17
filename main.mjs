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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reportVerified } from "./checkin.mjs";
import { client, fetchIssue, fetchPR, prTaskMarkdown, taskMarkdown } from "./github.mjs";
import {
  baseFromDocs,
  checkCommands,
  checkPremises,
  fetchBase,
  premiseStop,
  premiseStopComment,
  readGuidelines,
  recentMergedPrs,
  resolveBase,
  runPrompt,
} from "./context.mjs";
import { modelsJson, piEnv, resolveThinking, scrubbedEnv, wantsThinkingSwitch } from "./pi-config.mjs";
import { formatTopTools, piArgs, runPi, summarizeFile } from "./run-pi.mjs";
import { preinstall, sh, verify } from "./verify.mjs";
import { changedCheckConfigs, unpushedCheckConfigs, withConfigChanges } from "./check-configs.mjs";
import { asPiUser, cleanUp, killPiProcesses, piHome, prepare, reclaim, restoreLocalAction } from "./isolate.mjs";
import {
  branchName,
  buildJobSummary,
  collectCommits,
  cutoffReason,
  describeCommits,
  dropCheckoutCredentials,
  excludeAgentLogs,
  finalizeCommits,
  generatedSummary,
  git,
  isReady,
  openPr,
  prBody,
  pushBranch,
  recordJobSummary,
  runnerGitEnv,
  saveAgentLogs,
  timeLimitCutoff,
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
const ROLES = new Set(["builder", "builder-fix"]);

export function readInputs(env) {
  const parsed = Number.parseInt(env.INPUT_TIMEOUT_MINUTES ?? "", 10);
  // Parsed once: the limit the agent is told and the one enforced can't drift apart.
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  const issueParsed = Number.parseInt(env.INPUT_ISSUE_NUMBER ?? "", 10);
  const prParsed = Number.parseInt(env.INPUT_PR_NUMBER ?? "", 10);
  const issue = Number.isInteger(issueParsed) && issueParsed > 0 ? issueParsed : null;
  const pr = Number.isInteger(prParsed) && prParsed > 0 ? prParsed : null;
  const defaultRole = pr && !issue ? "builder-fix" : "builder";
  return {
    role: env.INPUT_ROLE || defaultRole,
    issue,
    pr,
    model: env.INPUT_MODEL,
    baseUrl: env.INPUT_CRUISE_BASE_URL,
    cruiseKey: env.INPUT_CRUISE_API_KEY,
    token: env.INPUT_GITHUB_TOKEN,
    // Only a run that checked in reports to wrok.in; one given a cruise_api_key never calls it.
    checkedIn: env.INPUT_CHECKED_IN === "true",
    apiBase: env.INPUT_WROKIN_API_BASE || "https://api.wrok.in",
    testCommand: env.INPUT_TEST_COMMAND ?? "",
    baseBranch: env.INPUT_BASE_BRANCH ?? "",
    cardBaseBranch: env.INPUT_CARD_BASE_BRANCH ?? "",
    readCapKb: env.INPUT_READ_CAP_KB ?? "",
    thinking: env.INPUT_THINKING ?? "",
    minutes,
    timeoutMs: minutes * 60_000,
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
  const target = i.pr ?? i.issue;
  if (!target) return;
  await gh.call("POST", `/repos/${i.repo}/issues/${target}/comments`, { body });
}

export async function main(env = process.env, gh = client(env.INPUT_GITHUB_TOKEN)) {
  const i = readInputs(env);
  if (!i.issue && !i.pr) return console.log("::error::issue_number or pr_number is required");
  if (i.issue && i.pr) {
    console.log("::error::pass either issue_number or pr_number, not both");
    return comment(gh, i, `⚠️ wrokin Builder couldn't start: pass either issue_number or pr_number, not both. [Run](${i.runUrl})`);
  }
  if (!ROLES.has(i.role)) {
    console.log(`::error::unknown role "${i.role}"`);
    return comment(gh, i, `⚠️ wrokin Builder couldn't start: unknown role \`${i.role}\`. [Run](${i.runUrl})`);
  }

  let ctx;
  let branch;
  let base;
  let baseInfo;
  let setup;
  const gitEnv = scrubbedEnv(env);

  if (i.pr) {
    ctx = await fetchPR(gh, i.repo, i.pr);
    if (ctx.error) {
      console.log(`::error::${ctx.error}`);
      return comment(gh, i, `⚠️ wrokin Builder couldn't start: ${ctx.error}. [Run](${i.runUrl})`);
    }

    branch = ctx.pr.head?.ref;
    if (!branch) {
      console.log("::error::the PR's head branch is missing");
      return comment(gh, i, `⚠️ wrokin Builder couldn't start: the PR's head branch is missing. [Run](${i.runUrl})`);
    }
    if (ctx.pr.head?.repo?.full_name && ctx.pr.head.repo.full_name !== i.repo) {
      console.log(`::error::fork PRs not supported (${ctx.pr.head.repo.full_name})`);
      return comment(gh, i, `⚠️ wrokin Builder couldn't start: PRs from forks are not supported by the Fix agent. [Run](${i.runUrl})`);
    }
    if (branch.startsWith("-") || /\s|\.\.|@\{|[\x00-\x1f]/.test(branch)) {
      console.log(`::error::invalid head ref: ${branch}`);
      return comment(gh, i, `⚠️ wrokin Builder couldn't start: invalid head branch name \`${branch}\`. [Run](${i.runUrl})`);
    }

    mkdirSync(i.temp, { recursive: true });
    const taskFile = join(i.temp, "task.md");
    writeFileSync(taskFile, prTaskMarkdown(i.repo, ctx.pr, ctx));
    writeFileSync(join(i.agentDir, "models.json"), JSON.stringify(modelsJson(i.model, i.baseUrl), null, 2));

    const dropped = dropCheckoutCredentials({ cwd: i.workspace, env: gitEnv, runnerTemp: env.RUNNER_TEMP });
    if (dropped.length) console.log(`removed checkout credentials before pi: ${dropped.join(", ")}`);
    excludeAgentLogs({ cwd: i.workspace, env: gitEnv });

    const fetchRes = git(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: i.workspace, env: gitEnv });
    if (fetchRes.code !== 0) {
      return comment(gh, i, `⚠️ wrokin Builder couldn't start: \`git fetch origin ${branch}\` failed. [Run](${i.runUrl})`);
    }
    const co = git(["checkout", "-B", branch, `origin/${branch}`], { cwd: i.workspace, env: gitEnv });
    if (co.code !== 0) {
      return comment(gh, i, `⚠️ wrokin Builder couldn't start: \`git checkout ${branch}\` failed. [Run](${i.runUrl})`);
    }
    base = git(["rev-parse", "HEAD"], { cwd: i.workspace, env: gitEnv }).out;
    baseInfo = { branch: ctx.pr.base?.ref ?? "main", why: "the PR's base branch" };
    // On PR rework, checkPremises is not applied: review comments and checks routinely
    // mention deleted files, proposed new files, or hypothetical alternatives, which
    // would falsely trigger a premise stop on legitimate fixes.
    setup = {
      base: baseInfo,
      checks: checkCommands(i.workspace, i.testCommand),
      premises: { missing: [], checked: 0 },
      guidelines: readGuidelines(i.workspace),
    };
  } else {
    ctx = await fetchIssue(gh, i.repo, i.issue);
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
    branch = branchName(i.role, i.issue, i.runId);
    const dropped = dropCheckoutCredentials({ cwd: i.workspace, env: gitEnv, runnerTemp: env.RUNNER_TEMP });
    if (dropped.length) console.log(`removed checkout credentials before pi: ${dropped.join(", ")}`);
    excludeAgentLogs({ cwd: i.workspace, env: gitEnv });

    // The base (#855): the dispatch always runs on the default branch, which is not where
    // every repo integrates. Start from the resolved base, else stay on what was checked out.
    const checkedOut = env.GITHUB_REF_NAME;
    const history = i.baseBranch || i.cardBaseBranch ? { prs: [] } : await recentMergedPrs(gh, i.repo);
    // Read on the checked-out (default) branch: that is where a repo states its rules.
    baseInfo = resolveBase({
      input: i.baseBranch,
      card: i.cardBaseBranch,
      docs: baseFromDocs(readGuidelines(i.workspace)),
      defaultBranch: (await gh.call("GET", `/repos/${i.repo}`)).data?.default_branch || checkedOut,
      mergedPrs: history.prs,
      listError: history.error,
    });
    let start = "HEAD";
    if (baseInfo.branch !== checkedOut) {
      const sha = fetchBase({ cwd: i.workspace, env: gitEnv, repo: i.repo, branch: baseInfo.branch, token: i.token });
      if (sha) start = sha;
      else baseInfo = { branch: checkedOut, why: `\`${baseInfo.branch}\` (${baseInfo.why}) couldn't be fetched, so the checked-out branch` };
    }
    console.log(`base: ${baseInfo.branch} — ${baseInfo.why}`);
    const co = git(["checkout", "-b", branch, start], { cwd: i.workspace, env: gitEnv });
    if (co.code !== 0) {
      return comment(gh, i, `⚠️ wrokin Builder couldn't start: \`git checkout\` failed. [Run](${i.runUrl})`);
    }
    base = git(["rev-parse", "HEAD"], { cwd: i.workspace, env: gitEnv }).out;

    // Read while the checkout is still the runner's, before the agent can change any of it.
    const issueText = [ctx.issue.title, ctx.issue.body ?? ""].join("\n");
    setup = {
      base: baseInfo,
      checks: checkCommands(i.workspace, i.testCommand),
      premises: checkPremises({ text: issueText, cwd: i.workspace, env: gitEnv, base }),
      guidelines: readGuidelines(i.workspace),
    };
    if (premiseStop(setup.premises, ctx.issue.labels)) {
      console.log(`::warning title=wrokin-agent premises::missing on ${baseInfo.branch}: ${setup.premises.missing.join(", ")}`);
      return comment(gh, i, premiseStopComment({ premises: setup.premises, base: baseInfo, runUrl: i.runUrl }));
    }
  }
  // The typecheck the in-loop gate runs (check-gate.mjs), fixed before the agent starts.
  const checksFile = join(i.temp, "run-checks.json");
  writeFileSync(checksFile, JSON.stringify({ typecheck: setup.checks.typecheck, scripts: setup.checks.scripts, base }));
  const promptFile = join(i.temp, "run-prompt.md");
  const rolePrompt = readFileSync(join(here, "roles", `${i.role}.md`), "utf8");
  writeFileSync(promptFile, runPrompt({ role: rolePrompt, minutes: i.minutes, ...setup }));

  // Hand the checkout to the agent's user, or run nothing (#832: fail closed).
  const home = piHome(i.temp);
  const iso = prepare({
    workspace: i.workspace,
    writable: [i.agentDir],
    readable: [taskFile, promptFile, checksFile, here, i.pi],
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
    // Dependencies first, as the agent's user: an install runs the repo's own scripts
    // (#865). The prompt is rewritten with the outcome before pi reads it.
    const deps = await preinstall({
      dir: i.workspace,
      env: { ...gitEnv, HOME: home },
      run: (cmd, opts) => sh(cmd, { ...opts, spawnFn: spawnAsPi }),
    });
    if (deps) {
      console.log(deps.ok ? deps.note : `::warning title=wrokin-agent install::${deps.note}`);
      writeFileSync(promptFile, runPrompt({ role: rolePrompt, minutes: i.minutes, ...setup, deps }));
    }
    return await agentRun(gh, i, { ctx, base, baseRef: baseInfo.branch, branch, taskFile, promptFile, checksFile, setup, home, env, gitEnv });
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
async function agentRun(gh, i, { ctx, base, baseRef, branch, taskFile, promptFile, checksFile, setup, home, env, gitEnv }) {
  const piGitEnv = { ...gitEnv, HOME: home };

  const eventsFile = join(i.temp, "pi-events.jsonl");
  const ran = await runPi({
    bin: i.pi,
    args: piArgs({
      model: i.model,
      rolePrompt: promptFile,
      taskFile,
      thinking: resolveThinking(i.thinking, i.model),
      extensions: [join(here, "check-gate.mjs"), join(here, "read-cap.mjs"), join(here, "compress-output.mjs")],
    }),
    env: {
      ...piEnv(env, { agentDir: i.agentDir, cruiseKey: i.cruiseKey, session: `wrokin-${i.runId}` }),
      HOME: home,
      WROKIN_CHECKS_FILE: checksFile,
      WROKIN_READ_CAP_KB: i.readCapKb,
      WROKIN_COMPRESS_TOOL_OUTPUT: env.INPUT_COMPRESS_TOOL_OUTPUT ?? "",
    },
    cwd: i.workspace,
    eventsFile,
    timeoutMs: i.timeoutMs,
    spawnFn: spawnAsPi,
  });
  killPiProcesses();
  const s = summarizeFile(eventsFile);
  const usage = {
    input: s.input,
    cached: s.cached,
    output: s.output,
    toolCalls: s.toolCalls,
    tools: s.tools,
    failedEdits: s.failedEdits,
    gateRounds: s.gateRounds,
    cappedReads: s.cappedReads,
  };
  console.log(
    `pi exit=${ran.code} timedOut=${ran.timedOut} tools=${s.toolCalls} tokens=${s.input}+${s.cached}cached/${s.output}`,
  );
  if (ran.stderr) console.log(ran.stderr.slice(-1500));
  // pi exits 0 after a failed model call, so this is the only place the cutoff shows (#822).
  // Running out of time is a cutoff too: the agent never said it was done (#855).
  const cutoff = s.cutoff ?? (ran.timedOut ? timeLimitCutoff(i.minutes) : null);
  if (cutoff) console.log(`::error title=wrokin-agent cut off::${cutoffReason(cutoff)}`);

  finalizeCommits({ cwd: i.workspace, env: piGitEnv, base, run: gitAsPi });
  // Counted from the runner's own copy, never from git inside the agent's checkout.
  const { dir: publishDir, commits } = collectCommits({
    workspace: i.workspace,
    branch,
    base,
    dir: join(i.temp, "publish.git"),
    env: gitEnv,
  });
  const top = formatTopTools(s.tools);
  const extra = [];
  if (top) extra.push(top);
  if (s.failedEdits) extra.push(`${s.failedEdits} failed edit${s.failedEdits === 1 ? "" : "s"}`);
  if (s.gateRounds) extra.push(`${s.gateRounds} gate round${s.gateRounds === 1 ? "" : "s"}`);
  if (s.cappedReads) extra.push(`${s.cappedReads} capped read${s.cappedReads === 1 ? "" : "s"}`);
  const footerExtra = extra.length ? ` · ${extra.join(" · ")}` : "";

  if (commits === 0) {
    recordJobSummary(
      buildJobSummary({ summary: s, result: null, ready: false, runId: i.runId, model: i.model }),
      env.GITHUB_STEP_SUMMARY,
    );
    const why = ran.code !== 0 && s.toolCalls === 0 && !s.errors.length && !s.finalText
      ? `pi failed to start (exit ${ran.code}): ${(ran.stderr || "no output").trim().slice(-300)}`
      : ran.timedOut
      ? "it ran out of time"
      : s.cutoff
        ? `it was cut off: ${cutoffReason(s.cutoff)}`
        : s.errors.length
          ? `the model call failed: ${s.errors.at(-1).slice(0, 300)}`
          : "it made no changes";
    const agentName = i.pr ? "wrokin Builder Fix" : "wrokin Builder";
    const actionDesc = i.pr ? "didn't make changes on this PR" : "didn't open a PR for this issue";
    return comment(
      gh,
      i,
      `${agentName} ${actionDesc}: ${why}.\n\n` +
        (s.finalText ? `**What it said:**\n\n${s.finalText.slice(0, 3000)}\n\n` : "") +
        `<sub>${i.model} via Cruise${footerExtra} · [run](${i.runUrl})</sub>`,
    );
  }

  // Before the proof-run, so nothing the tests write is counted (#891).
  const unpushedConfigs = unpushedCheckConfigs({ workspace: i.workspace, dir: publishDir, branch, env: gitEnv });
  // The tests are code the agent wrote, so they run as its user too.
  const proofRun = await verify({
    dir: i.workspace,
    override: i.testCommand,
    env: piGitEnv,
    timeoutMs: verifyBudget(i.timeoutMs),
    typecheck: setup.checks.typecheck,
    test: setup.checks.test,
    scripts: setup.checks.scripts,
    run: (cmd, opts) => sh(cmd, { ...opts, spawnFn: spawnAsPi }),
  });
  killPiProcesses();
  // A green check proves nothing when the agent rewrote what it reads (#870).
  const changedConfigs = changedCheckConfigs({ dir: publishDir, base, branch, env: gitEnv });
  const result = withConfigChanges(proofRun, changedConfigs, unpushedConfigs);
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
  const fallback = s.finalText
    ? null
    : generatedSummary({ commits: describeCommits({ dir: publishDir, base, branch, env: gitEnv }), result, cutoff });
  const ready = isReady(result, cutoff);
  recordJobSummary(
    buildJobSummary({ summary: s, result, ready, runId: i.runId, model: i.model }),
    env.GITHUB_STEP_SUMMARY,
  );
  const tests = result.verified ? "✅ verified: the tests pass" : `⚠️ not verified: ${result.reason}`;
  // The cutoff leads: it is why the work is partial, and the test result only follows from it.
  const verdict = cutoff ? `⛔ cut off before the agent finished: ${cutoffReason(cutoff)}; ${tests}` : tests;

  if (i.pr) {
    if (ready && i.checkedIn) {
      const headSha = pushed.sha ?? git(["rev-parse", "HEAD"], { cwd: publishDir, env: gitEnv }).out;
      const rep = await reportVerified(env, { apiBase: i.apiBase, pr: i.pr, headSha });
      if (rep.error) console.log(`::warning title=wrokin-agent verified record::${rep.error} PR #${i.pr} won't auto-merge.`);
      else console.log(`recorded PR #${i.pr} as verified at ${headSha.slice(0, 12)}`);
    }
    const summaryText = s.finalText ? s.finalText : (fallback?.summary ?? "");
    return comment(
      gh,
      i,
      `wrokin Builder Fix pushed fixes to \`${branch}\` (${verdict}).\n\n` +
        (summaryText ? `${summaryText}\n\n` : "") +
        `<sub>${i.model} via Cruise${footerExtra} · [run](${i.runUrl})</sub>`,
    );
  }

  const body = prBody({
    issue: i.issue,
    summary: s.finalText,
    result,
    runUrl: i.runUrl,
    model: i.model,
    usage,
    cutoff,
    setup: { ...setup, guidelines: setup.guidelines.map((g) => g.path), changedConfigs, unpushedConfigs },
    fallback,
  });
  const pr = await openPr(gh, {
    repo: i.repo,
    base: baseRef,
    branch,
    title: `${ctx.issue.title} (#${i.issue})`.slice(0, 250),
    body,
    draft: !ready,
  });
  if (pr.ok) {
    // The record auto-merge requires (#893). Failing it only keeps the PR from merging itself.
    if (ready && i.checkedIn) {
      const rep = await reportVerified(env, { apiBase: i.apiBase, pr: pr.number, headSha: pr.headSha });
      if (rep.error) console.log(`::warning title=wrokin-agent verified record::${rep.error} PR #${pr.number} won't auto-merge.`);
      else console.log(`recorded PR #${pr.number} as verified at ${pr.headSha.slice(0, 12)}`);
    }
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
