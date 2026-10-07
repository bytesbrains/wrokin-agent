# Security Policy

This action runs an autonomous coding agent on your runner with a model key and a
GitHub token in the same job, so we treat isolation bugs as security issues. Examples:
the agent reaching the GitHub token or another runner secret, escaping its OS user,
reading the action's environment, or changing a step that runs after it.

## Reporting

Report privately through GitHub's **Report a vulnerability** (Security tab) on this
repository. Please don't open a public issue for a security report.

We aim to acknowledge within 48 hours and to patch critical issues promptly. Fixes are
released as a new tagged version; the advisory names the first fixed version.

## Supported versions

Only the latest tagged release receives fixes. Pin a full commit SHA or a tag, and
update when an advisory is published.
