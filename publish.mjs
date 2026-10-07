// Publishing a run (#805): commit what pi left, push a branch, open the PR, and tell
// the issue. Runs after pi has exited, with the run's GitHub token (the wrokin App token
// from check-in, #817, else GITHUB_TOKEN), which pi never had.
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const UNVERIFIED_BANNER =
  "> ⚠️ **Authored, NOT proven to build.** The wrokin Builder could not verify this change " +
  "on the runner. Treat it as a draft to review, not a finished change.";

/** Cruise refusals that no retry lifts, said as what a reader can do about them. */
const CUTOFF_CODES = {
  wallet_exhausted: "the Cruise wallet ran out of credit (`wallet_exhausted`); a credit grant lifts it",
  budget_exhausted: "the Cruise project budget for this period is spent (`budget_exhausted`)",
};

/** One sentence for why a run was cut off, from `summarize`'s `cutoff`. */
export function cutoffReason(cutoff) {
  if (CUTOFF_CODES[cutoff.code]) return CUTOFF_CODES[cutoff.code];
  const said = cutoff.message.replace(/\s+/g, " ").trim().slice(0, 300);
  return `a model call failed${cutoff.code ? ` (\`${cutoff.code}\`)` : ""}${said ? `: ${said}` : ""}`;
}

/**
 * Ready for review only when the proof-run passed AND the agent finished. Partial work
 * that happens to pass stays a draft: the agent never said it was done (#822).
 */
export const isReady = (result, cutoff) => result.verified && !cutoff;

/**
 * A cut-off run gets this banner INSTEAD of the unverified one, not on top of it: two
 * "not finished" notices back to back bury the reason (#823 review). It carries the
 * proof-run's outcome, so nothing the other banner said is lost.
 */
const cutoffBanner = (cutoff, verified) =>
  `> ⛔ **The run was cut off before the agent finished:** ${cutoffReason(cutoff)}. ` +
  "What's here is partial work, committed as the agent left it" +
  (verified
    ? ". Its tests pass, but the agent never said it was done."
    : ", and NOT proven to build. Treat it as a draft to review.");

/**
 * What the pi extensions write into the working directory: the supervisor's audit log
 * and the awareness gate's envelopes. They belong in the run's artifact, never in the
 * customer's PR, and pi itself may `git add -A`, so git must not see them at all.
 */
export const AGENT_LOG_DIRS = [".supervisor/", ".awareness/"];

/** Adds the agent's log dirs to the checkout's own exclude file (never .gitignore). */
export function excludeAgentLogs({ cwd, env, run = git, append = appendFileSync }) {
  const r = run(["rev-parse", "--git-path", "info/exclude"], { cwd, env });
  if (r.code !== 0) return false;
  const file = r.out.startsWith("/") ? r.out : join(cwd, r.out);
  mkdirSync(dirname(file), { recursive: true });
  append(file, `\n# wrokin-agent: pi extension logs\n${AGENT_LOG_DIRS.join("\n")}\n`);
  return true;
}

/**
 * Removes every credential actions/checkout left for this job, before pi starts.
 *
 * Unsetting `http.https://github.com/.extraheader` is not enough: since checkout #2286
 * (v6), a default `persist-credentials` writes the job token to a file in $RUNNER_TEMP
 * and points `.git/config` at it with `includeIf.gitdir:<dir>.path` entries. With
 * those left in place, a `git push` run by pi would authenticate, and pi could read
 * the token straight from the file. So: drop the includes that point into
 * $RUNNER_TEMP, delete those files and any other `git-credentials-*` file there, and
 * drop the old-style header too. Returns what it removed, for the log.
 */
export function dropCheckoutCredentials({ cwd, env, runnerTemp, run = git }) {
  const removed = [];
  const list = run(["config", "--local", "--get-regexp", "^includeif\\."], { cwd, env });
  for (const line of list.code === 0 ? list.out.split("\n") : []) {
    const [key, value] = [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)];
    if (!key || !value || !runnerTemp || !value.startsWith(runnerTemp)) continue;
    run(["config", "--local", "--unset-all", key], { cwd, env });
    rmSync(value, { force: true });
    removed.push(key);
  }
  let files = [];
  try {
    files = runnerTemp ? readdirSync(runnerTemp).filter((f) => /^git-credentials-.*\.config$/.test(f)) : [];
  } catch {
    // no runner temp dir: nothing checkout could have written there
  }
  for (const f of files) {
    rmSync(join(runnerTemp, f), { force: true });
    removed.push(f);
  }
  if (run(["config", "--local", "--unset-all", "http.https://github.com/.extraheader"], { cwd, env }).code === 0) {
    removed.push("http.https://github.com/.extraheader");
  }
  return removed;
}

/** Branch names the agent owns. Leading dashes can never reach git as an option. */
export function branchName(role, issue, runId) {
  return `wrokin/${role}/issue-${issue}-${runId}`.replace(/^-+/, "");
}

export function git(args, { cwd, env }) {
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/**
 * Commits anything pi left uncommitted, then reports how many commits the branch has
 * over `base`. Zero means pi changed nothing, and there is no PR to open.
 */
export function finalizeCommits({ cwd, env, base, run = git }) {
  const dirty = run(["status", "--porcelain"], { cwd, env });
  if (dirty.code === 0 && dirty.out) {
    run(["add", "-A"], { cwd, env });
    run(["commit", "--no-verify", "-m", "chore: changes the agent left uncommitted"], { cwd, env });
  }
  const count = run(["rev-list", "--count", `${base}..HEAD`], { cwd, env });
  return count.code === 0 ? Number.parseInt(count.out, 10) || 0 : 0;
}

/**
 * Git config the runner's own git runs with once the checkout belongs to the agent
 * (#832): no system or global config, and the agent's checkout trusted only as a
 * place to fetch from.
 */
export const runnerGitEnv = (env) => ({ ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });

/**
 * Copies the agent's branch into a bare repository the runner owns, and counts its
 * commits over `base` there. The runner never runs git INSIDE the agent's checkout:
 * the agent wrote its `.git/config` and hooks, and `core.fsmonitor`, a hook or an
 * `http.proxy` there would run as, or redirect the push of, the user holding the
 * token. Fetching from it only runs upload-pack, which takes nothing executable from
 * the source repository's config. Returns `{ dir, commits }`; commits 0 means no PR.
 */
export function collectCommits({ workspace, branch, base, dir, env, run = git, write = writeFileSync }) {
  rmSync(dir, { recursive: true, force: true });
  const fail = (step, r) => {
    console.log(`::warning title=wrokin-agent collect::${step} failed: ${r.out.slice(0, 400)}`);
    return { dir, commits: 0 };
  };
  const init = run(["init", "--bare", "--quiet", dir], { cwd: "/", env: runnerGitEnv(env) });
  if (init.code !== 0) return fail("git init", init);
  // Trust the agent's checkout as a fetch source, in a config FILE: upload-pack runs as
  // a child with a cleaned environment, and how `-c` reaches it differs across git
  // versions (2.43 on the runners). Global config reaches it on all of them.
  const cfg = `${dir}.gitconfig`;
  write(cfg, `[safe]\n\tdirectory = ${workspace}\n\tdirectory = ${dir}\n[protocol "file"]\n\tallow = always\n`);
  const genv = { ...runnerGitEnv(env), GIT_CONFIG_GLOBAL: cfg };
  const fetched = run(
    // `--update-shallow`: actions/checkout clones at depth 1, and without it git refuses
    // a ref that needs new shallow roots, warns, and still exits 0.
    ["fetch", "--quiet", "--no-tags", "--update-shallow", "--", workspace, `+refs/heads/${branch}:refs/heads/${branch}`],
    { cwd: dir, env: genv },
  );
  if (fetched.code !== 0) return fail("git fetch", fetched);
  const count = run(["rev-list", "--count", `${base}..refs/heads/${branch}`], { cwd: dir, env: genv });
  if (count.code !== 0) return fail("git rev-list", count);
  const commits = Number.parseInt(count.out, 10) || 0;
  const tip = run(["rev-parse", `refs/heads/${branch}`], { cwd: dir, env: genv }).out;
  console.log(`collected ${branch} at ${tip.slice(0, 12)}: ${commits} commit(s) over ${String(base).slice(0, 12)}`);
  return { dir, commits };
}

/**
 * Copies the pi extensions' logs out of the checkout for the job artifact: regular
 * files only. A symlink the agent planted there (to `/proc/<pid>/environ`, say) would
 * otherwise be followed by the upload step, running as the runner.
 */
export function saveAgentLogs({ workspace, to }) {
  const copied = [];
  const walk = (from, dest) => {
    let names = [];
    try {
      names = readdirSync(from);
    } catch {
      return;
    }
    for (const name of names) {
      const src = join(from, name);
      try {
        const st = lstatSync(src);
        if (st.isDirectory()) walk(src, join(dest, name));
        else if (st.isFile()) {
          mkdirSync(dest, { recursive: true });
          copyFileSync(src, join(dest, name));
          copied.push(src);
        }
      } catch {
        // The agent's file, and the agent decides its mode: one it made unreadable is
        // skipped, not allowed to end the cleanup that runs after this.
      }
    }
  };
  for (const d of AGENT_LOG_DIRS) walk(join(workspace, d), join(to, d));
  return copied;
}

/** Pushes `ref` to `branch` with Basic auth (git's HTTP transport 401s a Bearer token). */
export function pushBranch({ cwd, env, repo, branch, token, ref = "HEAD", run = git }) {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const r = run(
    [
      "-c", `http.extraheader=AUTHORIZATION: basic ${basic}`,
      "push", "--no-verify", "--",
      `https://github.com/${repo}.git`, `${ref}:refs/heads/${branch}`,
    ],
    { cwd, env },
  );
  const safe = r.out.replaceAll(basic, "<redacted>").replaceAll(token, "<redacted>");
  return { ok: r.code === 0, message: safe.slice(0, 500) };
}

const fence = (s) => `\`\`\`\n${s.replaceAll("```", "``​`")}\n\`\`\``;

export function prBody({ issue, summary, result, runUrl, model, usage, cutoff = null }) {
  const parts = [];
  if (cutoff) parts.push(cutoffBanner(cutoff, result.verified), "");
  else if (!result.verified) parts.push(UNVERIFIED_BANNER, "");
  parts.push(`Closes #${issue}`, "");
  const noSummary = cutoff ? "_The agent was cut off before it wrote one._" : "_The agent left no summary._";
  parts.push("## What the agent says it did", "", summary?.trim() || noSummary, "");
  parts.push("## Proof-run", "");
  if (result.proof) {
    parts.push(
      `Run by the action after the agent exited, not by the agent: **${result.reason}**.`,
      "",
      fence(`$ ${result.proof.cmd}\nexit ${result.proof.exitCode}\n…\n${result.proof.tail.slice(-2500)}`),
    );
  } else {
    parts.push(`No proof-run: ${result.reason}.`);
  }
  parts.push(
    "",
    `<sub>wrokin Builder · ${model} via Cruise · ${usage.input} in` +
      (usage.cached ? ` + ${usage.cached} cached` : "") +
      ` / ${usage.output} out tokens · ` +
      `${usage.toolCalls} tool calls · [run](${runUrl})</sub>`,
  );
  return parts.join("\n");
}

/**
 * GitHub's refusal when the repo doesn't let Actions open PRs. Only `GITHUB_TOKEN` gets
 * it: a run that checked in opens the PR with the wrokin App token (#817).
 */
export const isActionsPrRefusal = (r) =>
  r.status === 403 && /not permitted to create or approve pull requests/i.test(r.data?.message ?? "");

export async function openPr(gh, { repo, base, branch, title, body, draft }) {
  const r = await gh.call("POST", `/repos/${repo}/pulls`, { title, head: branch, base, body, draft });
  if (r.ok) return { ok: true, number: r.data.number, url: r.data.html_url };
  const compare = `https://github.com/${repo}/compare/${base}...${branch}?expand=1`;
  if (isActionsPrRefusal(r)) {
    return {
      ok: false,
      compare,
      message:
        "GitHub didn't let this workflow open the PR. The repo setting " +
        "**Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** is off. " +
        "Leave `cruise_api_key` empty to check in with wrok.in instead: wrokin then opens the PR itself, no setting needed.",
    };
  }
  return { ok: false, compare, message: `GitHub refused the PR (HTTP ${r.status}: ${r.data?.message ?? "no message"}).` };
}
