#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);

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
    fork: process.env.GH_FAKE_REPO_FORK === "true",
    parent: { full_name: parentFullName },
    permissions
  };
}

if (process.env.GH_FAKE_FAIL) {
  console.error(process.env.GH_FAKE_FAIL);
  process.exit(1);
}

if (args[0] === "issue" && args[1] === "view") {
  process.stdout.write(JSON.stringify(readJson("GH_FAKE_ISSUE_PATH")));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify(readJson("GH_FAKE_PR_PATH")));
  process.exit(0);
}

// IMPORTANT: keep this route ahead of deeper repo-scoped routes because refine-task
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
  if (jqIndex !== -1) {
    process.stdout.write(restIssue?.type?.name || "");
    process.exit(0);
  }

  process.stdout.write(JSON.stringify(restIssue));
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

  process.stdout.write(JSON.stringify([comments]));
  process.exit(0);
}

if (args[0] === "api" && args[1] && /repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(args[1])) {
  const commentsPath = process.env.GH_FAKE_COMMENTS_PATH;
  const inputIndex = args.indexOf("--input");
  const inputPath = inputIndex === -1 ? "" : args[inputIndex + 1];
  const comments = commentsPath ? JSON.parse(fs.readFileSync(commentsPath, "utf8")) : [];
  const payload = inputPath ? JSON.parse(fs.readFileSync(inputPath, "utf8")) : {};
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
  const payload = inputPath ? JSON.parse(fs.readFileSync(inputPath, "utf8")) : {};
  const comment = comments.find((item) => Number(item.id) === commentId);

  if (!comment) {
    console.error(`comment not found: ${commentId}`);
    process.exit(1);
  }

  comment.body = payload.body || "";
  if (commentsPath) {
    fs.writeFileSync(commentsPath, JSON.stringify(comments));
  }
  process.stdout.write(JSON.stringify(comment));
  process.exit(0);
}

console.error(`unexpected gh args: ${args.join(" ")}`);
process.exit(1);
