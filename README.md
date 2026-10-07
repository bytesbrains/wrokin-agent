# wrokin-agent

A GitHub Action that implements a GitHub issue on **your own runner** and opens a pull
request. It is the runner half of the [wrokin](https://wrok.in) Builder: the coding
agent ([pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) works in
your checkout, calls [Cruise](https://cruise.bytesbrains.net) directly for its model,
and the action then runs your tests itself before deciding what kind of PR to open.

Nothing on wrok.in steers the run. wrok.in triggers it and, at job start, hands over
the Cruise key and model saved for the repository. The action can also run with no
wrok.in at all (see [Without wrok.in](#without-wrokin)).

> **Status:** in use for wrokin's Builder, which is offered on demand. If you enable the
> Builder from the wrokin dashboard, the workflow it adds already uses this action, pinned
> to a commit. You only need this README to write the workflow by hand.

## Usage

```yaml
name: wrokin agent build

on:
  workflow_dispatch:
    inputs:
      issue_number:
        description: "Issue to implement"
        required: true

permissions:
  contents: read
  issues: write     # report a refused check-in on the issue
  id-token: write   # check in with wrok.in for the key, model and GitHub token

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: bytesbrains/wrokin-agent@v0.9.0   # or pin a full commit SHA
        with:
          issue_number: ${{ inputs.issue_number }}
```

Pin a release tag or, better, a full commit SHA. Do not use `@main`.

### Inputs

| Input | Default | What it does |
|---|---|---|
| `issue_number` | the triggering issue | Issue to implement. Empty: set up and check only, run nothing. |
| `cruise_api_key` | empty | A Cruise key. Empty: fetch it from wrok.in at job start (needs `id-token: write`). Given: the run never contacts wrok.in. |
| `model` | the repo's wrok.in setting, else `bb/builder` | A Cruise lane (`bb/…`) or a model id your key lists. |
| `cruise_base_url` | from wrok.in, else `https://cruise.bytesbrains.net/v1` | Cruise endpoint. |
| `wrokin_api_base` | `https://api.wrok.in` | Where the check-in goes. |
| `test_command` | the repo's `npm`/`pnpm`/`yarn` test script, or `go test ./...` | The command that proves the change. |
| `base_branch` | the branch the workflow ran on | Branch the PR targets. |
| `timeout_minutes` | `30` | Wall-clock limit for the agent, and separately for the test run. |
| `github_token` | `github.token` | Used only without check-in (see below). |
| `role` | `builder` | Which agent role runs. Today only `builder`. |

Outputs: `pi` (binary path), `agent_dir` (the run's pi config directory), `pi_version`.

### Runner requirements

Linux, and passwordless `sudo` for the runner user. GitHub-hosted Ubuntu runners have
both. The action creates a separate OS user for the agent (below), and **a runner
where it can't do that runs nothing**. The issue gets a comment saying why.

## What a run does

1. **Setup.** Ensures Node ≥ the version in `pins.json`. Checks in with wrok.in for
   the Cruise key, model and a GitHub token, or uses the `cruise_api_key` input. Asks
   Cruise's `/v1/models` whether the key works and the model is listed, so a wrong
   model fails in seconds. Installs the pinned pi under `$RUNNER_TEMP`, never globally.
2. **Context.** Reads the issue and its human comments into a task file. Bot comments
   are left out.
3. **Branch.** Creates `wrokin/<role>/issue-<n>-<run id>` and removes any credential
   `actions/checkout` left in `.git/config`.
4. **Agent.** Runs pi as its own unprivileged user (see [Security model](#security-model)).
5. **Verify.** Installs from the lockfile and runs the test command itself, as the
   agent's user, since the tests are code the agent wrote.
6. **Publish.** Pushes the branch and opens a **ready PR** when the tests pass, or a
   **draft PR** marked "Authored, NOT proven to build" when they fail or there are
   none. A run whose last model call failed is marked **cut off** and stays a draft.
   No changes means no PR. Every outcome ends as a comment on the issue.

pi's event log and the extensions' audit logs are uploaded as the job's artifact.

## Security model

The run holds two credentials, a Cruise key and a GitHub token, and an agent that
executes arbitrary commands. The design keeps the second away from the first.

- **The agent runs as its own OS user** (`wrokin-pi`, in no group). The kernel then
  refuses it the action's process environment, where the credentials live, along with
  the Docker socket and `sudo`. The action **proves** that boundary before the agent
  starts (reading its own environment must work, reading the action's must fail) and
  refuses to run otherwise.
- **The agent's environment is an allowlist**, never a denylist. No `GITHUB_TOKEN`,
  `ACTIONS_*` token or other runner secret reaches it. It has the Cruise key because
  it calls Cruise itself; the key stays in the environment and is never written to disk.
- **The agent never holds the GitHub token.** The branch is fetched out of the agent's
  checkout into a repository the runner owns and pushed from there. The PR is opened by
  a separate step.
- **Secrets never go on a command line**, which every user can read in `/proc`.
- **Later steps run from a copy of this action** in `$RUNNER_TEMP`, so an agent that
  rewrites files in the checkout can't change what runs after it.
- Where the runner has iptables, the agent's user is blocked from cloud metadata
  endpoints.

### The GitHub token

With check-in (no `cruise_api_key`), wrok.in returns a **wrokin App token for this one
repository**, with `contents`, `pull_requests` and `issues` write and nothing else
(never `workflows`). So the PR and comments come from **wrokin[bot]**, your CI runs on
the PR, and **Allow GitHub Actions to create and approve pull requests** can stay off.
It is masked the moment it arrives, and a final `always()` step revokes it.

## Without wrok.in

Pass `cruise_api_key` (from a secret) and the run never contacts wrok.in. It then uses
the job's `GITHUB_TOKEN`, so the workflow must grant `contents: write`,
`pull-requests: write` and `issues: write`, and the repository setting above must be
on for the PR to open. Without it the branch is still pushed and the issue comment
links to open the PR by hand.

## Pins

`pins.json` holds the exact pi and extension versions and the minimum Node:

- [`pi-agent-supervisor`](https://www.npmjs.com/package/@bytesbrains/pi-agent-supervisor)
  blocks dangerous commands and keeps an audit log.
- [`pi-tool-awareness-gate`](https://www.npmjs.com/package/@bytesbrains/pi-tool-awareness-gate)
  annotates tool results.

Extensions that can open PRs themselves are deliberately left out: they would put the
GitHub token in the agent's reach.

## Versions

This repository is published from wrokin's main repository at each wrokin release,
and tagged with that release's version (`v0.9.0`, …). See [CONTRIBUTING.md](CONTRIBUTING.md).

## Links

- [wrok.in](https://wrok.in) · [agent integration manual](https://wrok.in/agents.md) ·
  [error reference](https://wrok.in/docs/errors)
- Security reports: [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE) © BytesBrains Pte Ltd
