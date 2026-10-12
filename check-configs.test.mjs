import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedCheckConfigs, checkConfigsOnDisk, globRe, unpushedCheckConfigs, withConfigChanges } from "./check-configs.mjs";
import { collectCommits } from "./publish.mjs";

/**
 * #870: the tamper check held the scripts fixed, but `"strict": false` in a tsconfig, or
 * an `exclude` in the vitest config, turns a failing check green without touching them.
 */
describe("check configs", () => {
  const sh = (cwd, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  const write = (dir, f, body = "{}") => {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), body);
  };

  it("names every check config the branch adds, changes or deletes, at any depth", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wa-configs-")));
    try {
      sh(dir, "init", "-q", "-b", "main");
      for (const f of ["tsconfig.json", "packages/a/tsconfig.build.json", "vitest.config.ts", "karma.conf.js", "src/a.ts", "src/tsconfig-notes.md"]) write(dir, f);
      sh(dir, "add", "-A");
      sh(dir, "commit", "-q", "-m", "base");
      const base = sh(dir, "rev-parse", "HEAD").stdout.trim();
      sh(dir, "checkout", "-q", "-b", "wrokin/builder/issue-1-9");
      write(dir, "packages/a/tsconfig.build.json", '{"compilerOptions":{"strict":false}}');
      write(dir, "jest.config.js", "module.exports = {}");
      write(dir, "src/a.ts", "export const a = 1;");
      write(dir, "src/tsconfig-notes.md", "changed");
      rmSync(join(dir, "vitest.config.ts"));
      // Renamed away (PR #879 review): listed as the deletion, so it can't slip past.
      sh(dir, "mv", "karma.conf.js", "notes.js");
      write(dir, "packages/b/vitest.config.mts");
      sh(dir, "add", "-A");
      sh(dir, "commit", "-q", "-m", "agent");
      const files = changedCheckConfigs({ dir, base, branch: "wrokin/builder/issue-1-9", env: { PATH: process.env.PATH, HOME: dir } });
      expect(files.sort()).toEqual(["jest.config.js", "karma.conf.js", "packages/a/tsconfig.build.json", "packages/b/vitest.config.mts", "vitest.config.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds an ignored config the PR doesn't hold (#891: .gitignore + vitest.config.ts went green)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wa-unpushed-")));
    const ws = join(root, "ws");
    try {
      mkdirSync(ws);
      sh(ws, "init", "-q", "-b", "main");
      write(ws, "package.json");
      write(ws, "packages/a/tsconfig.json");
      sh(ws, "add", "-A");
      sh(ws, "commit", "-q", "-m", "base");
      const base = sh(ws, "rev-parse", "HEAD").stdout.trim();
      sh(ws, "checkout", "-q", "-b", "wrokin/builder/issue-1-9");
      // What the probe did: ignore the config, then write one that skips the failing test.
      write(ws, ".gitignore", "vitest.config.ts\n");
      write(ws, "vitest.config.ts", 'export default { test: { exclude: ["**/a.test.js"] } }');
      sh(ws, "add", "-A");
      sh(ws, "commit", "-q", "-m", "agent");
      const env = { PATH: process.env.PATH, HOME: root };
      const { dir } = collectCommits({ workspace: ws, branch: "wrokin/builder/issue-1-9", base, dir: join(root, "publish.git"), env });
      // The diff can't see it: the only change in the PR is .gitignore.
      expect(changedCheckConfigs({ dir, base, branch: "wrokin/builder/issue-1-9", env })).toEqual([]);
      expect(unpushedCheckConfigs({ workspace: ws, dir, branch: "wrokin/builder/issue-1-9", env })).toEqual(["vitest.config.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("walks past installed and generated dirs, lists symlinks unfollowed, and reports a dir it can't read", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wa-disk-")));
    try {
      for (const f of ["tsconfig.json", "a/.mocharc.yml", "node_modules/x/tsconfig.json", ".svelte-kit/tsconfig.json", "vite.config.ts.timestamp-1700000000.mjs", "src/a.ts", "tsconfigXjson", "locked/jest.config.js"]) write(dir, f);
      mkdirSync(join(dir, "real"));
      write(dir, "real/vitest.config.ts");
      symlinkSync(join(dir, "real"), join(dir, "link"));
      symlinkSync(join(dir, "real/vitest.config.ts"), join(dir, "vite.config.ts"));
      chmodSync(join(dir, "locked"), 0o000);
      const found = checkConfigsOnDisk(dir);
      chmodSync(join(dir, "locked"), 0o755);
      // Root reads any directory, so the unreadable case only shows for other users.
      const locked = process.getuid?.() === 0 ? ["locked/jest.config.js"] : ["locked/ (unreadable)"];
      expect(found).toEqual(["a/.mocharc.yml", ...locked, "real/vitest.config.ts", "tsconfig.json", "vite.config.ts"].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches a name the way git's :(glob) does: * and ? within a name, the rest literal", () => {
    expect(globRe("tsconfig*.json").test("tsconfig.build.json")).toBe(true);
    expect(globRe("tsconfig*.json").test("tsconfigXjson")).toBe(false);
    expect(globRe("tsconfig*.json").test("tsconfig/a.json")).toBe(false);
    expect(globRe("a?.json").test("ab.json")).toBe(true);
    expect(globRe("a?.json").test("a.json")).toBe(false);
    expect(globRe("a+(b).json").test("a+(b).json")).toBe(true);
    expect(globRe("a+(b).json").test("aab.json")).toBe(false);
  });

  it("names the configs the PR doesn't hold in the reason", () => {
    const passed = { verified: true, reason: "tests passed", proof: null };
    expect(withConfigChanges(passed, [], ["vitest.config.ts"])).toEqual({
      ...passed,
      verified: false,
      reason: "tests passed; the checkout the checks ran in holds `vitest.config.ts`, which the PR doesn't",
    });
    expect(withConfigChanges(passed, ["tsconfig.json"], ["vitest.config.ts"]).reason).toBe(
      "tests passed; the agent changed `tsconfig.json`, which the checks read; the checkout the checks ran in holds `vitest.config.ts`, which the PR doesn't",
    );
  });

  it("turns a passing proof-run unverified, and leaves an untouched one alone", () => {
    const passed = { verified: true, reason: "tests passed", proof: { cmd: "npm test", exitCode: 0, tail: "" } };
    expect(withConfigChanges(passed, [])).toBe(passed);
    expect(withConfigChanges(passed, ["tsconfig.json", "vitest.config.ts"])).toEqual({
      ...passed,
      verified: false,
      reason: "tests passed; the agent changed `tsconfig.json`, `vitest.config.ts`, which the checks read",
    });
  });
});
