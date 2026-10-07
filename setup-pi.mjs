// Puts the pinned pi and its extensions on the runner, in a pi config directory of
// this run's own (#810). Runs on three kinds of runner, and must not assume any:
//
//  - a wrokin-agent runner (bytesbrains/wrokin-actions#11): pi and the extensions are
//    baked into the image, and the image names its own config dir in WROKIN_PI_SEED;
//  - GitHub-hosted ubuntu-latest: nothing installed;
//  - a customer's self-hosted runner: anything installed, including a pi of the
//    wrong version and a personal ~/.pi/agent with their own credentials.
//
// So the run never uses the runner's ~/.pi/agent. It gets a fresh directory, and the
// image's seed is copied in only when it holds exactly the pinned packages.
import { spawnSync } from "node:child_process";
import { accessSync, appendFileSync, constants, cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordSetupError } from "./report-failure.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function readPins(file = join(here, "pins.json")) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** `pi --version` prints a bare semver; anything else means "not the pi we want". */
export function parsePiVersion(stdout) {
  const m = /^\s*v?(\d+\.\d+\.\d+)\s*$/.exec(stdout ?? "");
  return m ? m[1] : null;
}

/** Whether `actual` (a `node --version`) is at least `min` (a bare semver). */
export function nodeAtLeast(actual, min) {
  const a = actual.replace(/^v/, "").split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** The seed is usable only when it declares exactly the pinned packages, in any order. */
export function seedMatches(settings, packages) {
  const have = (settings?.packages ?? []).map(String).sort();
  const want = packages.map((p) => `npm:${p}`).sort();
  return have.length === want.length && have.every((p, i) => p === want[i]);
}

function run(cmd, args, env, { quiet = false } = {}) {
  const r = spawnSync(cmd, args, { env, encoding: "utf8", stdio: quiet ? "pipe" : "inherit" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "" };
}

/** The absolute path `name` resolves to on `pathVar`, as a shell would find it, or null. */
export function findOnPath(name, pathVar = "") {
  for (const d of pathVar.split(delimiter)) {
    if (!d) continue;
    const p = join(d, name);
    try {
      if (statSync(p).isFile()) {
        accessSync(p, constants.X_OK);
        return p;
      }
    } catch {
      // not here, or not executable: keep looking, as the shell would
    }
  }
  return null;
}

/**
 * The pi binary to use: the one on PATH when it is the pinned version, otherwise the
 * pinned version installed under the run's own prefix. Never `npm i -g`: on a
 * customer's runner that would replace whatever pi they keep there.
 *
 * Always an absolute path. Later steps run it from an output, after other steps may
 * have changed PATH, so a bare "pi" could resolve to a binary nobody version-checked.
 */
export function ensurePi(pins, root, env, exec = run) {
  const found = findOnPath("pi", env.PATH);
  if (found && parsePiVersion(exec(found, ["--version"], env, { quiet: true }).stdout) === pins.pi) {
    return { bin: found, installed: false };
  }
  const prefix = join(root, "cli");
  const r = exec(
    "npm",
    ["install", "--prefix", prefix, "--no-fund", "--no-audit", `@earendil-works/pi-coding-agent@${pins.pi}`],
    env,
  );
  if (r.code !== 0) throw new Error(`could not install pi ${pins.pi} (npm exit ${r.code})`);
  return { bin: join(prefix, "node_modules", ".bin", "pi"), installed: true };
}

/** A fresh pi config dir holding the pinned extensions, seeded from the image when it can be. */
export function prepareAgentDir(pins, root, env, pi, exec = run) {
  const dir = join(root, "agent");
  mkdirSync(dir, { recursive: true });
  const seed = env.WROKIN_PI_SEED;
  if (seed && existsSync(join(seed, "settings.json"))) {
    let settings = null;
    try {
      settings = JSON.parse(readFileSync(join(seed, "settings.json"), "utf8"));
    } catch {
      // An unreadable seed is a seed that doesn't match: install fresh below.
    }
    if (seedMatches(settings, pins.packages) && existsSync(join(seed, "npm"))) {
      // settings.json and npm/ only: never auth.json, sessions, or anything else a
      // previous user of the runner left behind.
      cpSync(join(seed, "settings.json"), join(dir, "settings.json"));
      cpSync(join(seed, "npm"), join(dir, "npm"), { recursive: true });
      return { dir, seeded: true };
    }
  }
  const piEnv = { ...env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  for (const p of pins.packages) {
    const r = exec(pi, ["install", `npm:${p}`], piEnv);
    if (r.code !== 0) throw new Error(`could not install ${p} (pi exit ${r.code})`);
  }
  return { dir, seeded: false };
}

function main() {
  const env = process.env;
  const pins = readPins();
  const root = join(env.RUNNER_TEMP ?? "/tmp", "wrokin-pi");
  if (!nodeAtLeast(process.version, pins.node)) {
    throw new Error(`pi ${pins.pi} needs node >= ${pins.node}, found ${process.version}`);
  }
  const pi = ensurePi(pins, root, env);
  const agent = prepareAgentDir(pins, root, env, pi.bin);
  const version = parsePiVersion(run(pi.bin, ["--version"], env, { quiet: true }).stdout);
  if (version !== pins.pi) throw new Error(`expected pi ${pins.pi}, got ${version ?? "nothing"}`);
  console.log(
    `pi ${version} (${pi.installed ? "installed for this run" : "from the runner"}), ` +
      `extensions ${agent.seeded ? "from the image seed" : "installed for this run"}`,
  );
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `pi=${pi.bin}\nagent_dir=${agent.dir}\npi_version=${version}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.log(`::error title=wrokin-agent setup::${err.message}`);
    recordSetupError(err.message);
    process.exit(1);
  }
}
