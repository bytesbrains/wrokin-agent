// The GitHub REST calls a run makes (#805), all with one token: the wrokin App token
// from check-in (#817), or the job's GITHUB_TOKEN when the run didn't check in. pi never
// sees it: these run before pi starts (context) and after it exits (publish).

const API = "https://api.github.com";

export function client(token, fetchFn = fetch) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "wrokin-agent",
  };
  async function call(method, path, body) {
    const res = await fetchFn(`${API}${path}`, {
      method,
      headers: body ? { ...headers, "content-type": "application/json" } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.status >= 200 && res.status < 300, data };
  }
  return {
    call,
    /** Every page, because a long issue thread is exactly where the context is. */
    async all(path) {
      const items = [];
      for (let page = 1; page <= 10; page++) {
        const sep = path.includes("?") ? "&" : "?";
        const r = await call("GET", `${path}${sep}per_page=100&page=${page}`);
        if (!r.ok || !Array.isArray(r.data)) return { ok: r.ok && page > 1, status: r.status, items };
        items.push(...r.data);
        if (r.data.length < 100) break;
      }
      return { ok: true, status: 200, items };
    },
  };
}

const MAX_BODY = 20_000;
const MAX_COMMENT = 4_000;

/** The task file pi reads: the issue as people wrote it, nothing added but structure. */
export function taskMarkdown(repo, issue, comments) {
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n\n[… truncated]` : s);
  const thread = comments
    .filter((c) => c.user?.type !== "Bot")
    .map((c) => `### @${c.user?.login ?? "unknown"}\n\n${clip(c.body ?? "", MAX_COMMENT)}`)
    .join("\n\n");
  return [
    `# Issue #${issue.number} in ${repo}: ${issue.title}`,
    "",
    clip(issue.body ?? "(no description)", MAX_BODY),
    ...(thread ? ["", "## Comments", "", thread] : []),
    "",
  ].join("\n");
}

export async function fetchIssue(gh, repo, number) {
  const issue = await gh.call("GET", `/repos/${repo}/issues/${number}`);
  if (!issue.ok) return { error: `could not read issue #${number} (HTTP ${issue.status})` };
  if (issue.data.pull_request) return { error: `#${number} is a pull request, not an issue` };
  const comments = await gh.all(`/repos/${repo}/issues/${number}/comments`);
  return { issue: issue.data, comments: comments.items };
}

/** The task file pi reads for a PR fix: PR metadata, failing checks, review comments (#809). */
export function prTaskMarkdown(repo, pr, { reviewComments = [], issueComments = [], failingChecks = [] } = {}) {
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n\n[… truncated]` : s);
  const headSha = pr.head?.sha ? pr.head.sha.slice(0, 7) : "";
  const parts = [
    `# Pull Request #${pr.number} in ${repo}: ${pr.title}`,
    "",
    `- **Head branch:** \`${pr.head?.ref ?? "unknown"}\`${headSha ? ` (${headSha})` : ""}`,
    `- **Base branch:** \`${pr.base?.ref ?? "unknown"}\``,
    "",
    "## Description",
    "",
    clip(pr.body ?? "(no description)", MAX_BODY),
  ];

  if (failingChecks.length) {
    parts.push("", "## Failing Checks / CI", "");
    for (const c of failingChecks) {
      const title = c.output?.title ? ` — ${c.output.title}` : "";
      parts.push(`### \`${c.name}\` (${c.conclusion ?? "failed"})${title}`);
      if (c.output?.summary) parts.push("", clip(c.output.summary, MAX_COMMENT));
      if (c.output?.text) parts.push("", "```", clip(c.output.text, MAX_COMMENT), "```");
      parts.push("");
    }
  }

  if (reviewComments.length) {
    parts.push("", "## Review Comments", "");
    for (const rc of reviewComments) {
      const loc = rc.path ? ` on \`${rc.path}${rc.line ? `:${rc.line}` : ""}\`` : "";
      parts.push(`### @${rc.user?.login ?? "reviewer"}${loc}`, "");
      if (rc.diff_hunk) parts.push("```diff", rc.diff_hunk, "```", "");
      parts.push(clip(rc.body ?? "", MAX_COMMENT), "");
    }
  }

  const thread = issueComments
    .filter((c) => c.user?.type !== "Bot")
    .map((c) => `### @${c.user?.login ?? "unknown"}\n\n${clip(c.body ?? "", MAX_COMMENT)}`)
    .join("\n\n");
  if (thread) {
    parts.push("", "## Discussion Comments", "", thread);
  }

  parts.push("");
  return parts.join("\n");
}

export async function fetchPR(gh, repo, number) {
  const pr = await gh.call("GET", `/repos/${repo}/pulls/${number}`);
  if (!pr.ok) return { error: `could not read pull request #${number} (HTTP ${pr.status})` };
  const reviewComments = await gh.all(`/repos/${repo}/pulls/${number}/comments`);
  const issueComments = await gh.all(`/repos/${repo}/issues/${number}/comments`);
  let failingChecks = [];
  const headSha = pr.data.head?.sha;
  if (headSha) {
    const cr = await gh.call("GET", `/repos/${repo}/commits/${headSha}/check-runs`);
    if (cr.ok && Array.isArray(cr.data?.check_runs)) {
      failingChecks = cr.data.check_runs.filter((c) =>
        ["failure", "timed_out", "action_required"].includes(c.conclusion),
      );
    }
  }
  return {
    pr: pr.data,
    reviewComments: reviewComments.items,
    issueComments: issueComments.items,
    failingChecks,
  };
}

