// The files the checks read besides package.json's scripts (#870, #891). A run that
// changes one can't be called verified, and neither can one whose checkout holds a
// config the PR doesn't: the proof-run reads the checkout, the reviewer reads the PR.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { git, runnerGitEnv } from "./publish.mjs";

/**
 * The TypeScript and test-runner configs. `"strict": false` in a tsconfig, or an
 * `exclude` in the vitest config, turns a failing check green without touching a script.
 */
const NAMES = [
  "tsconfig*.json",
  "jsconfig*.json",
  "vitest.config.*",
  "vitest.workspace.*",
  "vite.config.*",
  "jest.config.*",
  ".mocharc*",
  "karma.conf.*",
  "ava.config.*",
  "playwright.config.*",
];

export const CHECK_CONFIGS = NAMES.map((f) => `:(glob)**/${f}`);

// The disk walk must match what git's `:(glob)` matches: `*` and `?` stay wildcards
// within a name, and everything else is literal (PR #894 review).
export const globRe = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
const NAME_RES = NAMES.map(globRe);
// Vite bundles a config to `vite.config.ts.timestamp-<n>.mjs` while it loads it; that
// file is Vite's, and no tool looks for a config by that name.
const isCheckConfig = (name) => NAME_RES.some((re) => re.test(name)) && !name.includes(".timestamp-");

/**
 * Directories never walked: git's own, installed packages, and what frameworks generate
 * on install (SvelteKit and Nuxt write a tsconfig there). A config in one of them only
 * applies if a tracked config points at it, and that change shows in the diff.
 */
const SKIP_DIRS = new Set([".git", "node_modules", ".svelte-kit", ".nuxt", ".next", ".output", ".astro", ".turbo", ".cache"]);

/**
 * The check configs the branch adds, changes or deletes over `base`, from the runner's
 * copy. `--no-renames`: a config renamed away still shows, as the deletion it is.
 */
export function changedCheckConfigs({ dir, base, branch, env, run = git }) {
  const r = run(["diff", "--name-only", "--no-renames", `${base}..refs/heads/${branch}`, "--", ...CHECK_CONFIGS], {
    cwd: dir,
    env: runnerGitEnv(env),
  });
  if (r.code !== 0) {
    console.log(`::warning title=wrokin-agent check configs::git diff failed: ${r.out.slice(0, 300)}`);
    return [];
  }
  return r.out.split("\n").filter(Boolean);
}

/**
 * Paths of the check configs on disk under `root`, relative to it. Symlinks are listed,
 * not followed. The checkout is the agent's until cleanup, so a directory the runner
 * can't read is listed as `<dir>/ (unreadable)`: a `chmod 700` must not hide a config.
 */
export function checkConfigsOnDisk(root, read = readdirSync) {
  const found = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = read(join(root, rel), { withFileTypes: true });
    } catch {
      if (rel) found.push(`${rel}/ (unreadable)`);
      return;
    }
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path);
      } else if (isCheckConfig(e.name)) {
        found.push(path);
      }
    }
  };
  walk("");
  return found.sort();
}

/**
 * The check configs in the agent's checkout that the pushed branch doesn't hold (#891).
 * The leftover commit is `git add -A`, which skips ignored files: an agent that adds
 * `vitest.config.ts` to `.gitignore` and writes one excluding the failing test gets a
 * green proof-run and a PR whose only change is `.gitignore`. Read from the disk and
 * the runner's copy, never with git inside the checkout (see `collectCommits`).
 */
export function unpushedCheckConfigs({ workspace, dir, branch, env, run = git, onDisk = checkConfigsOnDisk }) {
  return onDisk(workspace).filter(
    (path) => run(["cat-file", "-e", `refs/heads/${branch}:${path}`], { cwd: dir, env: runnerGitEnv(env) }).code !== 0,
  );
}

/** The proof-run's result once the agent's check-config changes are counted against it. */
export function withConfigChanges(result, files, unpushed = []) {
  if (!files.length && !unpushed.length) return result;
  const names = (fs) => fs.map((f) => `\`${f}\``).join(", ");
  const why = [];
  if (files.length) why.push(`the agent changed ${names(files)}, which the checks read`);
  if (unpushed.length) why.push(`the checkout the checks ran in holds ${names(unpushed)}, which the PR doesn't`);
  return { ...result, verified: false, reason: `${result.reason}; ${why.join("; ")}` };
}
