import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedCheckConfigs, withConfigChanges } from "./publish.mjs";

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
