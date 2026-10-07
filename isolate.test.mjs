import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_USER, ancestors, asPiUser, blockDestinations, cleanUp, prepare, reclaim, restoreLocalAction } from "./isolate.mjs";

/**
 * A fake command runner: `answers` maps "file arg arg…" prefixes to an exit code, and
 * every call is recorded. Unlisted commands succeed, except the environ read, which is
 * the one a working setup must see FAIL.
 */
const fakeRun = (answers = {}) => {
  const calls = [];
  const run = (file, args) => {
    const line = [file, ...args].join(" ");
    calls.push(line);
    for (const [prefix, code] of Object.entries(answers)) {
      if (line.startsWith(prefix)) return { code, out: code ? "nope" : "" };
    }
    if (line.endsWith("/proc/self/environ")) return { code: 0, out: "PATH=/usr/bin" };
    if (line.includes("/environ")) return { code: 1, out: "/bin/cat: /proc/4242/environ: Permission denied" };
    if (line === `id -nG ${PI_USER}`) return { code: 0, out: PI_USER };
    return { code: 0, out: "" };
  };
  return { run, calls };
};

const base = (run, over = {}) => ({
  workspace: "/home/runner/work/r/r",
  writable: ["/home/runner/work/_temp/agent"],
  readable: ["/home/runner/work/_temp/wrokin-agent/task.md"],
  home: "/home/runner/work/_temp/wrokin-agent/pi-home",
  ownPid: 4242,
  platform: "linux",
  run,
  // /home/runner is 750 on ubuntu-latest; everything else is searchable.
  stat: (d) => ({ mode: d === "/home/runner" ? 0o40750 : 0o40755 }),
  mkdir: () => {},
  ...over,
});

describe("prepare: fails closed (#832)", () => {
  it("refuses off Linux", () => {
    const { run } = fakeRun();
    expect(prepare(base(run, { platform: "darwin" }))).toMatchObject({ ok: false, reason: expect.stringMatching(/needs Linux/) });
  });

  it("refuses without passwordless sudo", () => {
    const { run, calls } = fakeRun({ "sudo -n true": 1 });
    expect(prepare(base(run))).toMatchObject({ ok: false, reason: expect.stringMatching(/passwordless `sudo`/) });
    expect(calls).toHaveLength(1); // nothing else was attempted
  });

  it("refuses a pre-existing user that sits in other groups", () => {
    const { run } = fakeRun();
    const withDocker = (file, args) =>
      [file, ...args].join(" ") === `id -nG ${PI_USER}` ? { code: 0, out: `${PI_USER} docker` } : run(file, args);
    expect(prepare(base(withDocker))).toMatchObject({ ok: false, reason: expect.stringMatching(/other groups \(.*docker/) });
  });

  it("refuses when the agent's user can still read this process's environment", () => {
    const { run } = fakeRun({ [`sudo -n -u ${PI_USER} /bin/cat /proc/4242/environ`]: 0 });
    expect(prepare(base(run))).toMatchObject({ ok: false, reason: expect.stringMatching(/can still read/) });
  });

  it("doesn't take a read that failed for another reason as proof", () => {
    // `sudo: env: command not found` once made every command fail: a self-check that
    // only looked at the exit code would have passed on nothing.
    const { run } = fakeRun({ [`sudo -n -u ${PI_USER} /bin/cat /proc/4242/environ`]: 1 });
    const notFound = (file, args) =>
      [file, ...args].join(" ").includes("/proc/4242/environ") ? { code: 1, out: "sudo: /bin/cat: command not found" } : run(file, args);
    expect(prepare(base(notFound))).toMatchObject({ ok: false, reason: expect.stringMatching(/can still read/) });
  });

  it("refuses when it can't run anything as the agent's user", () => {
    const { run } = fakeRun({ [`sudo -n -u ${PI_USER} /bin/cat /proc/self/environ`]: 1 });
    expect(prepare(base(run))).toMatchObject({ ok: false, reason: expect.stringMatching(/couldn't run a command/) });
  });
});

describe("prepare: the working path", () => {
  it("creates the user, opens only the 750 ancestor, hands over the dirs, then proves it", () => {
    const { run, calls } = fakeRun({ [`id -u ${PI_USER}`]: 1 });
    expect(prepare(base(run))).toEqual({ ok: true, home: "/home/runner/work/_temp/wrokin-agent/pi-home" });
    expect(calls).toContain(
      `sudo -n useradd --system --user-group --no-create-home --shell /usr/sbin/nologin ${PI_USER}`,
    );
    // Search permission only, and only where it was missing.
    expect(calls.filter((c) => c.includes("chmod"))).toEqual(["sudo -n chmod o+x /home/runner"]);
    expect(calls).toContain(`sudo -n chown -R ${PI_USER}:${PI_USER} /home/runner/work/r/r`);
    expect(calls).toContain(`sudo -n chown -R ${PI_USER}:${PI_USER} /home/runner/work/_temp/agent`);
    // The read-only task file is never chowned.
    expect(calls.some((c) => c.includes("chown") && c.includes("task.md"))).toBe(false);
    expect(calls).toContain(`sudo -n -u ${PI_USER} /bin/cat /proc/4242/environ`);
  });

  it("still succeeds without iptables — the network block is best effort", () => {
    const { run } = fakeRun({ "sudo -n iptables": 1 });
    expect(prepare(base(run)).ok).toBe(true);
  });
});

describe("blockDestinations", () => {
  const rule = (dest) => `OUTPUT -m owner --uid-owner ${PI_USER} -d ${dest} -j REJECT`;

  it("inserts a rule that isn't there yet", () => {
    const { run, calls } = fakeRun({ "sudo -n iptables -C": 1 });
    expect(blockDestinations({ run })).toEqual(["169.254.169.254", "168.63.129.16"]);
    expect(calls).toContain(`sudo -n iptables -I ${rule("169.254.169.254")}`);
  });

  it("doesn't insert it again on a runner that kept it from an earlier job", () => {
    const { run, calls } = fakeRun();
    expect(blockDestinations({ run })).toEqual(["169.254.169.254", "168.63.129.16"]);
    expect(calls.filter((c) => c.includes("iptables -I"))).toEqual([]);
  });
});

describe("cleanUp", () => {
  it("runs every step even when an earlier one throws", () => {
    const ran = [];
    cleanUp([
      ["first", () => ran.push("first")],
      ["logs", () => { throw new Error("EACCES: permission denied"); }],
      ["reclaim", () => ran.push("reclaim")],
      ["restore", () => ran.push("restore")],
    ]);
    expect(ran).toEqual(["first", "reclaim", "restore"]);
  });
});

describe("asPiUser", () => {
  it("keeps secrets off the command line, where every user can read them", () => {
    const w = asPiUser("pi", ["--mode", "json"], { PATH: "/usr/bin", CRUISE_API_KEY: "cru_secret", HOME: "/h" });
    expect(w.file).toBe("sudo");
    expect(w.args.join(" ")).not.toContain("cru_secret");
    expect(w.args).toContain("--preserve-env=CRUISE_API_KEY");
    // sudo itself gets a PATH (not secret) — without it, it can't find /usr/bin/env's
    // target when sudoers sets no secure_path — and the preserved secret, nothing else.
    expect(w.env).toEqual({ PATH: "/usr/bin", CRUISE_API_KEY: "cru_secret" });
    // Plain values travel as `env NAME=value`, which also gets PATH past secure_path.
    expect(w.args).toEqual(["-n", "-u", PI_USER, "--preserve-env=CRUISE_API_KEY", "--", "/usr/bin/env", "PATH=/usr/bin", "HOME=/h", "pi", "--mode", "json"]);
  });

  it("treats as secret every name scrubbedEnv does, AUTH and PASSWD included", () => {
    const w = asPiUser("pi", [], { NPM_AUTH: "a", DB_PASSWD: "b", LANG: "C" });
    expect(w.args).toContain("--preserve-env=NPM_AUTH,DB_PASSWD");
    expect(w.args.join(" ")).not.toMatch(/=a\b|=b\b/);
  });

  it("does not clear the environment sudo preserved (no `env -i`)", () => {
    expect(asPiUser("pi", [], { CRUISE_API_KEY: "k" }).args).not.toContain("-i");
  });
});

describe("reclaim", () => {
  it("deletes the agent's checkout rather than handing its .git back", () => {
    const { run, calls } = fakeRun();
    reclaim({ workspace: "/w", uid: 1001, gid: 1001, run });
    expect(calls).toEqual(["sudo -n find /w -mindepth 1 -delete", "sudo -n chown 1001:1001 /w"]);
  });
});

describe("ancestors", () => {
  it("lists every directory from / down to the parent", () => {
    expect(ancestors("/home/runner/work/r")).toEqual(["/", "/home", "/home/runner", "/home/runner/work"]);
  });
});

describe("restoreLocalAction", () => {
  it("puts the runner's copy back only when the action lived in the checkout", () => {
    const copies = [];
    const copy = (from, to) => copies.push([from, to]);
    const ws = mkdtempSync(join(tmpdir(), "wa-restore-"));
    expect(restoreLocalAction({ from: "/t/src", to: `${ws}/actions/wrokin-agent`, workspace: ws, copy })).toBe(true);
    expect(existsSync(`${ws}/actions`)).toBe(true); // parents made in the emptied checkout
    rmSync(ws, { recursive: true, force: true });
    expect(copies).toHaveLength(1);
    // A marketplace-style action under _actions is outside the checkout: left alone.
    expect(restoreLocalAction({ from: "/t/src", to: "/r/_actions/b/w/main", workspace: "/w", copy })).toBe(false);
    expect(restoreLocalAction({ from: "/t/src", to: "/w2/x", workspace: "/w", copy })).toBe(false);
  });
});
