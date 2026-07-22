#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

let args = process.argv.slice(2);

if (process.env.GH_FAKE_ARGS_PATH) {
  fs.appendFileSync(process.env.GH_FAKE_ARGS_PATH, `${JSON.stringify(args)}\n`);
}
const stripPrefixCount = Number(process.env.GH_FAKE_STRIP_PREFIX_COUNT || "0");
if (stripPrefixCount > 0) {
  args = args.slice(stripPrefixCount);
}

const transientMatcher = process.env.GH_FAKE_TRANSIENT_FAIL_MATCHER;
const transientCounterFile = process.env.GH_FAKE_TRANSIENT_FAIL_COUNTER_FILE;
if (transientMatcher && transientCounterFile && fs.existsSync(transientCounterFile)) {
  const joined = args.join(" ");
  if (joined.includes(transientMatcher)) {
    const remaining = Number(fs.readFileSync(transientCounterFile, "utf8").trim() || "0");
    if (remaining > 0) {
      fs.writeFileSync(transientCounterFile, String(remaining - 1));
      console.error("transient network error");
      process.exit(1);
    }
  }
}

function readJson(envName) {
  const filePath = process.env[envName];
  return filePath ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null;
}

function buildRepoPayload() {
  const fullName = process.env.GH_FAKE_REPO_FULL_NAME || "fitlab-ai/agent-infra";
  const parentFullName = process.env.GH_FAKE_UPSTREAM_REPO || fullName;
  const permissions = process.env.GH_FAKE_PERMISSIONS
    ? JSON.parse(process.env.GH_FAKE_PERMISSIONS)
    : { triage: true, push: true };

  return {
    full_name: fullName,
    owner: { type: process.env.GH_FAKE_REPO_OWNER_TYPE || "Organization" },
    fork: process.env.GH_FAKE_REPO_FORK === "true",
    parent: { full_name: parentFullName },
    permissions
  };
}

if (process.env.GH_FAKE_FAIL) {
  console.error(process.env.GH_FAKE_FAIL);
  process.exit(1);
}

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(`gh version ${process.env.GH_FAKE_VERSION || "2.16.0"}\n`);
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "view") {
  process.stdout.write(JSON.stringify(readJson("GH_FAKE_ISSUE_PATH")));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify(readJson("GH_FAKE_PR_PATH")));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "checks") {
  if (process.env.GH_FAKE_CHECKS_FAIL) {
    console.error(process.env.GH_FAKE_CHECKS_FAIL);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(readJson("GH_FAKE_CHECKS_PATH") || []));
  process.exit(0);
}

if (args[0] === "label" && args[1] === "list") {
  process.stdout.write(JSON.stringify(readJson("GH_FAKE_LABELS_PATH") || []));
  process.exit(0);
}

if (args[0] === "api" && args[1] === "user") {
  process.stdout.write(JSON.stringify({ login: process.env.GH_FAKE_USER || "fixture-user" }));
  process.exit(0);
}

if (args[0] === "api" && args[1] && /repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(args[1])) {
  const stored = readJson("GH_FAKE_PR_PATH") || {};
  const match = args[1].match(/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
  const repository = match ? match[1] : "fitlab-ai/agent-infra";
  const number = match ? Number(match[2]) : 1;
  let sha = process.env.GH_FAKE_PR_HEAD_SHA || "fixture-sha";
  if (!process.env.GH_FAKE_PR_HEAD_SHA) {
    try {
      sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {}
  }
  process.stdout.write(JSON.stringify({
    number,
    node_id: `PR_${number}`,
    html_url: `https://github.com/${repository}/pull/${number}`,
    state: "open",
    title: "Fixture PR",
    body: "Fixture body",
    draft: false,
    head: { ref: "fixture-head", sha, repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } },
    ...stored
  }));
  process.exit(0);
}

if (args[0] === "api" && args[1] && /repos\/[^/]+\/[^/]+\/pulls(?:\?|$)/.test(args[1])) {
  const match = args[1].match(/repos\/([^/]+\/[^/]+)\/pulls/);
  const repository = match ? match[1] : "fitlab-ai/agent-infra";
  const pullsPath = process.env.GH_FAKE_PRS_PATH;
  const pulls = pullsPath && fs.existsSync(pullsPath) ? JSON.parse(fs.readFileSync(pullsPath, "utf8")) : [];
  const methodIndex = args.indexOf("-X");
  const method = methodIndex === -1 ? "GET" : args[methodIndex + 1];
  if (method === "POST") {
    const inputIndex = args.indexOf("--input");
    const payload = JSON.parse(fs.readFileSync(args[inputIndex + 1] === "-" ? 0 : args[inputIndex + 1], "utf8"));
    const number = pulls.reduce((max, item) => Math.max(max, Number(item.number || 0)), 0) + 1;
    const created = {
      number,
      node_id: `PR_${number}`,
      html_url: `https://github.com/${repository}/pull/${number}`,
      state: "open",
      title: payload.title,
      body: payload.body,
      draft: Boolean(payload.draft),
      head: { ref: String(payload.head).replace(/^.*:/, ""), sha: "created-sha", repo: { full_name: repository } },
      base: { ref: payload.base, repo: { full_name: repository } },
      labels: [],
      assignees: [],
      milestone: null
    };
    pulls.push(created);
    if (pullsPath) fs.writeFileSync(pullsPath, JSON.stringify(pulls));
    process.stdout.write(JSON.stringify(created));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(pulls));
  process.exit(0);
}

// IMPORTANT: keep this route ahead of deeper repo-scoped routes because code-task
// verification now resolves repo metadata before falling through to issue endpoints.
if (args[0] === "api" && args[1] && /^repos\/[^/]+\/[^/]+$/.test(args[1])) {
  const repoPayload = buildRepoPayload();
  const jqIndex = args.indexOf("--jq");

  if (jqIndex !== -1) {
    const query = args[jqIndex + 1] || "";
    if (query === "if .fork then .parent.full_name else .full_name end") {
      process.stdout.write(repoPayload.fork ? repoPayload.parent.full_name : repoPayload.full_name);
      process.exit(0);
    }

    if (query === ".permissions") {
      process.stdout.write(JSON.stringify(repoPayload.permissions));
      process.exit(0);
    }

    if (query === ".owner.type // empty") {
      process.stdout.write(repoPayload.owner.type);
      process.exit(0);
    }
  }

  process.stdout.write(JSON.stringify(repoPayload));
  process.exit(0);
}

if (args[0] === "api" && args[1] && /repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(args[1])) {
  const jqIndex = args.indexOf("--jq");
  if (process.env.GH_FAKE_ISSUE_REST_FAIL && jqIndex !== -1) {
    console.error(process.env.GH_FAKE_ISSUE_REST_FAIL);
    process.exit(1);
  }

  const restIssue = readJson("GH_FAKE_ISSUE_REST_PATH") ?? readJson("GH_FAKE_ISSUE_PATH");
  const methodIndex = args.indexOf("-X");
  const method = methodIndex === -1 ? "GET" : args[methodIndex + 1];
  if (method === "PATCH") {
    const inputIndex = args.indexOf("--input");
    const inputPath = inputIndex === -1 ? "" : args[inputIndex + 1];
    const payload = inputPath
      ? JSON.parse(fs.readFileSync(inputPath === "-" ? 0 : inputPath, "utf8"))
      : {};
    const updated = { ...restIssue, ...payload };
    const targetPath = process.env.GH_FAKE_ISSUE_REST_PATH || process.env.GH_FAKE_ISSUE_PATH;
    if (targetPath) fs.writeFileSync(targetPath, JSON.stringify(updated));
    process.stdout.write(JSON.stringify(updated));
    process.exit(0);
  }
  if (jqIndex !== -1) {
    process.stdout.write(restIssue?.type?.name || "");
    process.exit(0);
  }

  process.stdout.write(JSON.stringify(restIssue));
  process.exit(0);
}

if (args[0] === "api" && args[1] === "graphql") {
  if (process.env.GH_FAKE_ISSUE_FIELDS_FAIL) {
    console.error(process.env.GH_FAKE_ISSUE_FIELDS_FAIL);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(readJson("GH_FAKE_ISSUE_FIELDS_PATH")));
  process.exit(0);
}

if (args[0] === "api" && args.some((arg) => /\/issues\/\d+\/comments\?per_page=100$/.test(arg))) {
  const requestPath = args.find((arg) => /\/issues\/\d+\/comments\?per_page=100$/.test(arg)) || "";
  const match = requestPath.match(/\/issues\/(\d+)\/comments\?per_page=100$/);
  const issueNumber = match ? match[1] : "";
  const issueCommentsNumber = process.env.GH_FAKE_ISSUE_NUMBER || "";
  const prCommentsNumber = process.env.GH_FAKE_PR_NUMBER || "";
  let comments = null;

  if (issueNumber && issueNumber === issueCommentsNumber) {
    comments = readJson("GH_FAKE_COMMENTS_PATH");
  } else if (issueNumber && issueNumber === prCommentsNumber) {
    comments = readJson("GH_FAKE_PR_COMMENTS_PATH");
  } else {
    comments = readJson("GH_FAKE_COMMENTS_PATH");
  }

  const remoteComments = comments?.map((comment, index) => ({ id: index + 1, ...comment })) || [];
  process.stdout.write(JSON.stringify([remoteComments]));
  process.exit(0);
}

if (args[0] === "api" && args[1] && /repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(args[1])) {
  const commentsPath = process.env.GH_FAKE_COMMENTS_PATH;
  const inputIndex = args.indexOf("--input");
  const inputPath = inputIndex === -1 ? "" : args[inputIndex + 1];
  const comments = commentsPath ? JSON.parse(fs.readFileSync(commentsPath, "utf8")) : [];
  const payload = inputPath
    ? JSON.parse(fs.readFileSync(inputPath === "-" ? 0 : inputPath, "utf8"))
    : {};
  const nextId = comments.reduce((max, comment) => Math.max(max, Number(comment.id || 0)), 0) + 1;
  const comment = { id: nextId, body: payload.body || "" };

  comments.push(comment);
  if (commentsPath) {
    fs.writeFileSync(commentsPath, JSON.stringify(comments));
  }
  process.stdout.write(JSON.stringify(comment));
  process.exit(0);
}

if (args[0] === "api" && args[1] && /repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/.test(args[1])) {
  const commentsPath = process.env.GH_FAKE_COMMENTS_PATH;
  const inputIndex = args.indexOf("--input");
  const inputPath = inputIndex === -1 ? "" : args[inputIndex + 1];
  const match = args[1].match(/\/issues\/comments\/(\d+)$/);
  const commentId = match ? Number(match[1]) : 0;
  const comments = commentsPath ? JSON.parse(fs.readFileSync(commentsPath, "utf8")) : [];
  const commentIndex = comments.findIndex((item) => Number(item.id) === commentId);
  const comment = comments[commentIndex];

  if (!comment) {
    console.error(`comment not found: ${commentId}`);
    process.exit(1);
  }

  if (args.includes("DELETE")) {
    comments.splice(commentIndex, 1);
    if (commentsPath) fs.writeFileSync(commentsPath, JSON.stringify(comments));
    process.exit(0);
  }

  const payload = inputPath
    ? JSON.parse(fs.readFileSync(inputPath === "-" ? 0 : inputPath, "utf8"))
    : {};
  comment.body = payload.body || "";
  if (commentsPath) {
    fs.writeFileSync(commentsPath, JSON.stringify(comments));
  }
  process.stdout.write(JSON.stringify(comment));
  process.exit(0);
}

console.error(`unexpected gh args: ${args.join(" ")}`);
process.exit(1);
