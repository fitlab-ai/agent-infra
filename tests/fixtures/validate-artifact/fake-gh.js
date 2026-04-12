#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);

function readJson(envName) {
  const filePath = process.env[envName];
  return filePath ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null;
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

if (args[0] === "api" && args[1] && /repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(args[1])) {
  if (process.env.GH_FAKE_ISSUE_REST_FAIL) {
    console.error(process.env.GH_FAKE_ISSUE_REST_FAIL);
    process.exit(1);
  }

  const restIssue = readJson("GH_FAKE_ISSUE_REST_PATH") ?? readJson("GH_FAKE_ISSUE_PATH");
  const jqIndex = args.indexOf("--jq");
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
