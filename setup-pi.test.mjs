import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePi,
  findOnPath,
  nodeAtLeast,
  parsePiVersion,
  prepareAgentDir,
  readPins,
  seedMatches,
} from "./setup-pi.mjs";

const pins = {
  node: "22.19.0",
  pi: "1.0.0",
  packages: ["@bytesbrains/a@1.0.0", "@bytesbrains/b@2.0.0"],
};

/** A fake process runner: records calls and answers `pi --version` with `piOnPath`. */
function fakeExec({ piOnPath = "", code = 0 } = {}) {
  const calls = [];
  const exec = (cmd, args, env) => {
    calls.push({ cmd, args, agentDir: env?.PI_CODING_AGENT_DIR });
    if (cmd.endsWith("pi") && args[0] === "--version") return { code: piOnPath ? 0 : 127, stdout: piOnPath };
    return { code, stdout: "" };
  };
  return { exec, calls };
}

describe("pins.json", () => {
  it("pins exact versions only", () => {
    const real = readPins();
    expect(real.pi).toMatch(/^\d+\.\d+\.\d+$/);
    for (const p of real.packages) expect(p).toMatch(/^@[\w-]+\/[\w-]+@\d+\.\d+\.\d+$/);
  });

  // pi-ci-gate reads Gitea Actions only, and pi-contrib-gate can open PRs itself, which
  // would put the GitHub token in pi's reach (#803, #810).
  it("leaves out the Gitea-only and PR-opening gates", () => {
    const names = readPins().packages.join(" ");
    expect(names).not.toMatch(/pi-ci-gate|pi-contrib-gate|pi-project-gate/);
  });
});

describe("parsePiVersion / nodeAtLeast", () => {
  it("reads a bare semver and nothing else", () => {
    expect(parsePiVersion("1.0.0\n")).toBe("1.0.0");
    expect(parsePiVersion("v1.2.3")).toBe("1.2.3");
    expect(parsePiVersion("command not found")).toBeNull();
    expect(parsePiVersion(undefined)).toBeNull();
  });

  it("compares node versions numerically", () => {
    expect(nodeAtLeast("v22.19.0", "22.19.0")).toBe(true);
    expect(nodeAtLeast("v22.20.5", "22.19.0")).toBe(true);
    expect(nodeAtLeast("v24.0.0", "22.19.0")).toBe(true);
    expect(nodeAtLeast("v22.9.0", "22.19.0")).toBe(false);
    expect(nodeAtLeast("v20.18.0", "22.19.0")).toBe(false);
  });
});

describe("ensurePi", () => {
  let bin;
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "wrokin-agent-bin-"));
    writeFileSync(join(bin, "pi"), "#!/bin/sh\n");
    chmodSync(join(bin, "pi"), 0o755);
  });
  afterEach(() => rmSync(bin, { recursive: true, force: true }));

  // An absolute path, never a bare "pi": later steps run it after PATH may have changed,
  // and must run the very binary whose version was checked (#811 review).
  it("returns the absolute path of the pinned pi on PATH", () => {
    const { exec, calls } = fakeExec({ piOnPath: "1.0.0\n" });
    expect(ensurePi(pins, "/r", { PATH: bin }, exec)).toEqual({ bin: join(bin, "pi"), installed: false });
    expect(calls.map((c) => c.cmd)).toEqual([join(bin, "pi")]);
  });

  // A customer's runner may keep another pi; we install beside it, never over it.
  it("installs the pin under the run's prefix when PATH has another version", () => {
    const { exec, calls } = fakeExec({ piOnPath: "0.99.1" });
    expect(ensurePi(pins, "/r", { PATH: bin }, exec)).toEqual({ bin: "/r/cli/node_modules/.bin/pi", installed: true });
    const npm = calls.find((c) => c.cmd === "npm");
    expect(npm.args).toContain("--prefix");
    expect(npm.args).toContain("@earendil-works/pi-coding-agent@1.0.0");
    expect(npm.args).not.toContain("-g");
  });

  it("installs when PATH has no pi at all, without probing a bare name", () => {
    const { exec, calls } = fakeExec({ piOnPath: "1.0.0" });
    expect(ensurePi(pins, "/r", { PATH: "" }, exec).installed).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["npm"]);
  });

  it("fails loudly when the install fails", () => {
    const { exec } = fakeExec({ code: 1 });
    expect(() => ensurePi(pins, "/r", { PATH: "" }, exec)).toThrow(/could not install pi 1.0.0/);
  });
});

describe("findOnPath", () => {
  let a;
  let b;
  beforeEach(() => {
    a = mkdtempSync(join(tmpdir(), "wrokin-agent-a-"));
    b = mkdtempSync(join(tmpdir(), "wrokin-agent-b-"));
  });
  afterEach(() => [a, b].forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("takes the first executable match, as a shell would", () => {
    writeFileSync(join(a, "pi"), "");
    chmodSync(join(a, "pi"), 0o644);
    writeFileSync(join(b, "pi"), "");
    chmodSync(join(b, "pi"), 0o755);
    expect(findOnPath("pi", `${a}:${b}`)).toBe(join(b, "pi"));
    expect(findOnPath("pi", `/nonexistent:${a}`)).toBeNull();
    expect(findOnPath("pi", undefined)).toBeNull();
  });
});

describe("prepareAgentDir", () => {
  let root;
  let seed;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wrokin-agent-"));
    seed = join(root, "seed");
    mkdirSync(join(seed, "npm", "node_modules"), { recursive: true });
    writeFileSync(join(seed, "npm", "package.json"), "{}");
    writeFileSync(join(seed, "auth.json"), '{"secret":"personal"}');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const writeSeed = (packages) =>
    writeFileSync(join(seed, "settings.json"), JSON.stringify({ packages }));

  it("copies a matching seed, and only settings.json and npm/", () => {
    writeSeed(["npm:@bytesbrains/b@2.0.0", "npm:@bytesbrains/a@1.0.0"]);
    const { exec, calls } = fakeExec();
    const out = prepareAgentDir(pins, join(root, "run"), { WROKIN_PI_SEED: seed }, "pi", exec);
    expect(out.seeded).toBe(true);
    expect(calls).toEqual([]);
    expect(existsSync(join(out.dir, "npm", "package.json"))).toBe(true);
    expect(existsSync(join(out.dir, "auth.json"))).toBe(false);
  });

  it("installs fresh when the seed holds other versions", () => {
    writeSeed(["npm:@bytesbrains/a@0.9.0", "npm:@bytesbrains/b@2.0.0"]);
    const { exec, calls } = fakeExec();
    const out = prepareAgentDir(pins, join(root, "run"), { WROKIN_PI_SEED: seed }, "pi", exec);
    expect(out.seeded).toBe(false);
    expect(calls.map((c) => c.args)).toEqual([
      ["install", "npm:@bytesbrains/a@1.0.0"],
      ["install", "npm:@bytesbrains/b@2.0.0"],
    ]);
    expect(calls.every((c) => c.agentDir === out.dir)).toBe(true);
    expect(readFileSync(join(seed, "auth.json"), "utf8")).toContain("personal");
  });

  it("installs fresh when the seed's settings.json is not valid JSON", () => {
    writeFileSync(join(seed, "settings.json"), '{"packages": [');
    const { exec, calls } = fakeExec();
    const out = prepareAgentDir(pins, join(root, "run"), { WROKIN_PI_SEED: seed }, "pi", exec);
    expect(out.seeded).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("installs fresh when there is no seed", () => {
    const { exec, calls } = fakeExec();
    const out = prepareAgentDir(pins, join(root, "run"), {}, "pi", exec);
    expect(out.seeded).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("fails loudly when an extension won't install", () => {
    const { exec } = fakeExec({ code: 1 });
    expect(() => prepareAgentDir(pins, join(root, "run"), {}, "pi", exec)).toThrow(
      /could not install @bytesbrains\/a@1.0.0/,
    );
  });
});

describe("seedMatches", () => {
  it("needs exactly the pinned set", () => {
    expect(seedMatches({ packages: ["npm:@bytesbrains/a@1.0.0", "npm:@bytesbrains/b@2.0.0"] }, pins.packages)).toBe(true);
    expect(seedMatches({ packages: ["npm:@bytesbrains/a@1.0.0"] }, pins.packages)).toBe(false);
    expect(seedMatches({}, pins.packages)).toBe(false);
  });
});

describe("action.yml", () => {
  // GitHub evaluates expressions even inside descriptions: a usage hint written as
  // `${{ secrets.X }}` made the whole action fail to load ("Unrecognized named-value:
  // 'secrets'"), and actionlint did not catch it (#811 smoke run).
  it("has no expressions in descriptions", () => {
    const yml = readFileSync(new URL("./action.yml", import.meta.url), "utf8");
    const offending = yml.split("\n").filter((l) => /^\s*description:/.test(l) && l.includes("${{"));
    expect(offending).toEqual([]);
  });

  // #817: the check-in token is the run's GitHub token wherever one is used, and the
  // last step revokes it whatever happened.
  it("uses the check-in token for every GitHub step and revokes it in an always() step", () => {
    const yml = readFileSync(new URL("./action.yml", import.meta.url), "utf8");
    const tokenLines = yml.split("\n").filter((l) => /^\s*INPUT_GITHUB_TOKEN:/.test(l));
    expect(tokenLines.length).toBe(3);
    for (const l of tokenLines) expect(l).toMatch(/steps\.creds\.outputs\.github_token/);
    const last = yml.slice(yml.lastIndexOf("    - "));
    expect(last).toContain("if: always() && steps.creds.outputs.github_token != ''");
    expect(last).toContain("revoke-token.mjs");
  });
});
