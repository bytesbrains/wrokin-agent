// Runs pi, and everything it leaves behind, as a separate OS user (#832).
//
// The action's own Node process holds the run's GitHub token and the Cruise key. A
// process can read the environment of any other process of the SAME user from
// `/proc/<pid>/environ`, so an allowlisted environment for pi was never enough: one
// `cat /proc/$PPID/environ` from a command pi ran returned both. Namespaces would hide
// the parent, but unprivileged user namespaces are blocked on every runner we use
// (AppArmor on ubuntu-latest, seccomp on our self-hosted ones; probed 2026-10-06).
// A different user is refused by the kernel instead, and needs only `sudo`.
//
// The user is in no group of the runner's, so it can't reach the Docker socket or
// `sudo` either. Fail closed: a runner that can't do this runs nothing (#832).
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { SECRET_LIKE } from "./pi-config.mjs";

/** The user pi runs as. */
export const PI_USER = "wrokin-pi";

/** Addresses pi never needs: cloud metadata (AWS/GCP/Azure) and Azure's wire server. */
export const BLOCKED_DESTINATIONS = ["169.254.169.254", "168.63.129.16"];

export function cmd(file, args) {
  const r = spawnSync(file, args, { encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

const sudo = (run, args) => run("sudo", ["-n", ...args]);

/** Every ancestor of `path`, from `/` down to its parent. */
export function ancestors(path) {
  const out = [];
  for (let d = dirname(path); d !== dirname(d); d = dirname(d)) out.unshift(d);
  return ["/", ...out.filter((d) => d !== "/")];
}

/**
 * Sets up the user and hands it the directories it works in. Returns `{ ok, home }`,
 * or `{ ok: false, reason }` with a sentence fit for the issue comment.
 *
 * `workspace` and `writable` are chowned to the user. `readable` (the task file, the
 * role prompt, the pi binary) only need their ancestors to be searchable, which on
 * ubuntu-latest means adding o+x to `/home/runner` (mode 750 there). That is not
 * reverted: it grants search, never listing or reading, and a concurrent job on a
 * self-hosted runner may be relying on it.
 */
export function prepare({
  workspace,
  writable = [],
  readable = [],
  home,
  ownPid = process.pid,
  platform = process.platform,
  run = cmd,
  stat = statSync,
  mkdir = mkdirSync,
}) {
  if (platform !== "linux") {
    return { ok: false, reason: `the runner is ${platform}; isolating the agent needs Linux` };
  }
  if (sudo(run, ["true"]).code !== 0) {
    return { ok: false, reason: "the runner user has no passwordless `sudo`, which isolating the agent needs" };
  }
  if (run("id", ["-u", PI_USER]).code !== 0) {
    const add = sudo(run, ["useradd", "--system", "--user-group", "--no-create-home", "--shell", "/usr/sbin/nologin", PI_USER]);
    if (add.code !== 0) return { ok: false, reason: `couldn't create the \`${PI_USER}\` user: ${add.out.slice(0, 200)}` };
  }
  // A pre-existing user someone added to a group would carry that group's reach in.
  const groups = run("id", ["-nG", PI_USER]).out.split(/\s+/).filter(Boolean);
  if (groups.some((g) => g !== PI_USER)) {
    return { ok: false, reason: `the \`${PI_USER}\` user is in other groups (${groups.join(", ")})` };
  }

  // Search permission down to everything it touches; nothing is made readable.
  const dirs = new Set([workspace, ...writable, ...readable, home].flatMap((p) => ancestors(p)));
  for (const d of dirs) {
    let mode;
    try {
      mode = stat(d).mode;
    } catch {
      continue; // created below, or not needed
    }
    if ((mode & 0o001) === 0 && sudo(run, ["chmod", "o+x", d]).code !== 0) {
      return { ok: false, reason: `couldn't make \`${d}\` searchable for the agent's user` };
    }
  }
  mkdir(home, { recursive: true });
  for (const p of [workspace, home, ...writable]) {
    const r = sudo(run, ["chown", "-R", `${PI_USER}:${PI_USER}`, p]);
    if (r.code !== 0) return { ok: false, reason: `couldn't hand \`${p}\` to the agent's user: ${r.out.slice(0, 200)}` };
  }

  // The proof, not the assumption: as that user, this process's environment must be
  // unreadable. A read failing for any other reason (no `cat`, sudo can't find it)
  // proves nothing, so the user must first read its OWN environment, and the denial
  // must be the kernel's.
  if (sudo(run, ["-u", PI_USER, "/bin/cat", "/proc/self/environ"]).code !== 0) {
    return { ok: false, reason: `couldn't run a command as the \`${PI_USER}\` user` };
  }
  const probe = sudo(run, ["-u", PI_USER, "/bin/cat", `/proc/${ownPid}/environ`]);
  if (probe.code === 0 || !/permission denied/i.test(probe.out)) {
    return { ok: false, reason: `the \`${PI_USER}\` user can still read the action's environment` };
  }
  blockDestinations({ run });
  return { ok: true, home };
}

/**
 * Rejects the agent user's traffic to {@link BLOCKED_DESTINATIONS}, the runner's own
 * traffic untouched. Best effort: our self-hosted images have no iptables yet, and
 * the isolation above doesn't depend on it.
 */
export function blockDestinations({ run = cmd } = {}) {
  const blocked = [];
  for (const dest of BLOCKED_DESTINATIONS) {
    // Checked first: a self-hosted runner keeps its rules across jobs, and inserting
    // again every run would grow the OUTPUT chain without bound.
    const rule = ["OUTPUT", "-m", "owner", "--uid-owner", PI_USER, "-d", dest, "-j", "REJECT"];
    if (sudo(run, ["iptables", "-C", ...rule]).code === 0 || sudo(run, ["iptables", "-I", ...rule]).code === 0) {
      blocked.push(dest);
    }
  }
  console.log(
    blocked.length === BLOCKED_DESTINATIONS.length
      ? `blocked ${blocked.join(", ")} for ${PI_USER}`
      : `no iptables on this runner: ${PI_USER} can reach cloud metadata endpoints`,
  );
  return blocked;
}

/**
 * The argv that runs `file args` as the agent user with `env`.
 *
 * Secrets never go on a command line: `/proc/<pid>/cmdline` is readable by every user.
 * So names that look like a credential (the same test that keeps them out of
 * `scrubbedEnv`) travel through `sudo --preserve-env`, and the
 * rest go as `env NAME=value` arguments, which also gets PATH past sudo's `secure_path`.
 * sudo's `env_reset` drops everything else the runner had.
 */
export function asPiUser(file, args, env) {
  const secret = [];
  const plain = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (SECRET_LIKE.test(k)) secret.push(k);
    else plain.push(`${k}=${v}`);
  }
  return {
    file: "sudo",
    args: [
      "-n", "-u", PI_USER,
      ...(secret.length ? [`--preserve-env=${secret.join(",")}`] : []),
      "--", "/usr/bin/env", ...plain, file, ...args,
    ],
    // What sudo itself is started with: the secrets it is told to preserve, and a PATH,
    // which sudo needs when the runner's sudoers sets no `secure_path`.
    env: { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...Object.fromEntries(secret.map((k) => [k, env[k]])) },
  };
}

/** Ends everything still running as the agent user: pi's background jobs, a test server. */
export function killPiProcesses({ run = cmd } = {}) {
  sudo(run, ["pkill", "-KILL", "-u", PI_USER]);
}

/**
 * Empties the checkout the agent owned and gives the directory back to the runner.
 * Deleted, not chowned back: chowning would turn the agent's `.git/config` and hooks
 * into the runner's own, and later steps (actions/checkout's post step, a self-hosted
 * runner's next job) run git there as the runner.
 */
export function reclaim({ workspace, uid = process.getuid?.(), gid = process.getgid?.(), run = cmd }) {
  const wiped = sudo(run, ["find", workspace, "-mindepth", "1", "-delete"]);
  const owned = sudo(run, ["chown", `${uid}:${gid}`, workspace]);
  if (wiped.code !== 0 || owned.code !== 0) {
    console.log(`::warning title=wrokin-agent cleanup::couldn't reclaim ${workspace}: ${(wiped.out || owned.out).slice(0, 200)}`);
  }
}

/**
 * Puts a pristine copy of this action back where the runner expects it, when the
 * action lives inside the checkout (`uses: ./actions/wrokin-agent`): the runner reads
 * its `action.yml` again for the post step. From the runner's own copy, so the agent's
 * edits to the original never run.
 */
export function restoreLocalAction({ from, to, workspace, copy = cpSync }) {
  if (!to || !workspace || !to.startsWith(`${workspace}/`)) return false;
  mkdirSync(dirname(to), { recursive: true });
  copy(from, to, { recursive: true });
  return true;
}

/** The agent's HOME for this run: npm and git want one it can write. */
export const piHome = (temp) => join(temp, "pi-home");

/**
 * Runs every cleanup step, whatever the one before it did. A step that throws is
 * logged, not allowed to skip the rest: the agent controls what the early steps read
 * (an unreadable log file, say), and must not be able to keep its checkout that way.
 */
export function cleanUp(steps) {
  for (const [name, step] of steps) {
    try {
      step();
    } catch (err) {
      console.log(`::warning title=wrokin-agent cleanup::${name} failed: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }
}
