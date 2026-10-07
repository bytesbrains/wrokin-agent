# Contributing

Thanks for looking. A few things to know first.

## Where the code lives

This repository is **published** from wrokin's main repository (private) at each
wrokin release. `main` here is replaced on every release, so a commit made directly
here would be overwritten.

- **Issues are welcome here**: bugs, runner setups that fail, docs that are wrong.
- **Pull requests** are welcome too. A maintainer ports an accepted change into the
  main repository, it ships in the next release, and the PR is closed with a link to
  that release. Your authorship is kept in the commit (`Co-authored-by`).
- `#123`-style references in code comments point at the main repository's tracker.
  They're kept as a record, not as links you can follow.

## Before you open a PR

```bash
npm install
npm test
```

- Node scripts use **built-ins only**: no runtime dependencies, no build step.
- Process runs are injected in the tests, so nothing installs software or calls a model.
  Keep it that way.
- Read [AGENTS.md](AGENTS.md): its invariants are the security model. A change that
  weakens one (puts a secret on a command line, widens the agent's environment, lets
  the agent hold the GitHub token) won't be accepted, however useful the feature.
- Say if a change was written with an AI tool.

## Security

Never in a public issue or PR. See [SECURITY.md](SECURITY.md).
