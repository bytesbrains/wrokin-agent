# wrokin-agent — notes for anyone changing it (human or agent)

A composite GitHub Action: pi runs autonomously on the runner and calls Cruise
directly. Node scripts, built-ins only, no build step.

## Layout
- `action.yml` — composite: Node check → copy of the action to `$RUNNER_TEMP` →
  `checkin.mjs` → `preflight.mjs` → `setup-pi.mjs` → `main.mjs` (only with an issue) →
  `report-failure.mjs` on a setup failure → artifact upload → `revoke-token.mjs`
  (always, when check-in returned a GitHub token).
- `main.mjs` — one run: context → branch → pi → commit leftovers → verify → push + PR.
- `github.mjs` — REST client (paginated), issue → task markdown.
- `pi-config.mjs` — Cruise `models.json`, and the allowlisted env for pi and verify.
- `run-pi.mjs` — pi argv, spawn with a wall-clock limit, event-stream summary.
- `verify.mjs` — install + test command detection and the independent test run.
- `publish.mjs` — git exclude for extension logs, commits, push, PR body, PR open.
- `roles/<role>.md` — the role prompt appended to pi's system prompt.
- `pins.json` — exact pi, extension and minimum Node versions. One place only.
- `checkin.mjs` — key, model and base URL: inputs, else `POST /agent/checkin` with an
  OIDC token (audience `wrokin-agent`), else defaults. Check-in also returns the run's
  GitHub token: a wrokin App token for this repo only, `contents`/`pull_requests`/
  `issues` write, never `workflows`.
- `revoke-token.mjs` — `DELETE /installation/token` at job end, never fails the job.
- `preflight.mjs` — `/v1/models` check: key accepted, model or lane listed.
- `isolate.mjs` — the agent's OS user: setup + self-check (`prepare`), the `sudo -u`
  argv (`asPiUser`), `killPiProcesses`, `reclaim`.
- `setup-pi.mjs` — pinned pi on PATH or under `$RUNNER_TEMP`; a fresh
  `PI_CODING_AGENT_DIR`, seeded from `WROKIN_PI_SEED` when it matches the pins.

## Invariants (the security model — don't weaken them)
- **No brain.** wrok.in is called once, at job start, for credentials and settings, and
  never during the run. Models go to Cruise only.
- **A checked-in key is masked first.** `::add-mask::` before anything else prints, and
  it leaves `checkin.mjs` only as a step output. An input key is never copied.
- **pi's environment is an allowlist** (`pi-config.mjs`), never a denylist: new runner
  secrets must stay out without anyone remembering to exclude them.
- **Nothing the agent runs runs as the runner user** (`isolate.mjs`). pi, the leftover
  commit and the test run run as `wrokin-pi` via `sudo -u`; secrets reach it through
  `--preserve-env`, never argv (`/proc/<pid>/cmdline` is world-readable). The runner
  never runs git inside the agent's checkout: it fetches the branch into its own bare
  repo and pushes from there. Every later step runs from the `$RUNNER_TEMP` copy of
  this action, because the checkout belongs to the agent. No isolation → no run. The
  checkout is deleted at the end, not handed back.
- **pi never holds the GitHub token.** Don't install an extension that opens PRs; the
  PR is opened by a separate step.
- **One GitHub token per run**: the check-in's App token when there is one, else
  `inputs.github_token`. Every step that talks to GitHub takes
  `steps.creds.outputs.github_token || inputs.github_token` (a test checks
  `action.yml`), and the last step revokes the check-in token in `always()`.
- **Never touch the runner's own pi setup.** No `npm i -g`, never read or write
  `~/.pi/agent`, and copy only `settings.json` and `npm/` from a seed.
- **The OIDC request pair stays out of pi.** `ACTIONS_ID_TOKEN_REQUEST_*` are outside
  the allowlist; `run.test.mjs` names them.
- **The Cruise key stays in the environment.** `models.json` uses `$CRUISE_API_KEY`;
  never write the key to disk or print it.

## Tests
`npm test`. Process runs are injected, so no test installs anything or calls Cruise.
