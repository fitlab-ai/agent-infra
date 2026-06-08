import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function main() {
  const taskDir = process.argv[2];
  if (!taskDir) {
    writeResult({
      mode: "error",
      code_max: 0,
      rev_max: 0,
      verdict: null,
      next_round: null,
      next_artifact: null,
      review_artifact: null,
      message: "Task directory argument is required."
    }, 2);
    return;
  }

  try {
    const resolvedTaskDir = path.resolve(taskDir);
    const taskId = path.basename(resolvedTaskDir);
    const entries = fs.readdirSync(resolvedTaskDir);
    const codeMax = maxRound(entries, "code");
    const revMax = maxRound(entries, "review-code");

    if (codeMax === 0) {
      writeResult({
        mode: "init",
        code_max: codeMax,
        rev_max: revMax,
        verdict: null,
        next_round: 1,
        next_artifact: "code.md",
        review_artifact: null,
        message: "No prior code artifact. Starting initial implementation (round 1 -> code.md)."
      }, 0);
      return;
    }

    if (revMax < codeMax) {
      const expected = artifactName("review-code", codeMax);
      writeResult({
        mode: "error",
        code_max: codeMax,
        rev_max: revMax,
        verdict: null,
        next_round: null,
        next_artifact: null,
        review_artifact: expected,
        message: `Code round ${codeMax} has no matching review-code artifact (${expected} expected). Run /review-code ${taskId} first.`
      }, 2);
      return;
    }

    if (revMax > codeMax) {
      writeResult({
        mode: "error",
        code_max: codeMax,
        rev_max: revMax,
        verdict: null,
        next_round: null,
        next_artifact: null,
        review_artifact: artifactName("review-code", revMax),
        message: `Inconsistent state: review-code round ${revMax} > code round ${codeMax}. Manual inspection required.`
      }, 2);
      return;
    }

    const reviewArtifact = artifactName("review-code", revMax);
    const verdictResult = parseVerdict(path.join(resolvedTaskDir, reviewArtifact));
    if (!verdictResult.ok) {
      writeResult({
        mode: "error",
        code_max: codeMax,
        rev_max: revMax,
        verdict: verdictResult.verdict ?? null,
        next_round: null,
        next_artifact: null,
        review_artifact: reviewArtifact,
        message: verdictResult.message
      }, 2);
      return;
    }

    const verdict = verdictResult.verdict;
    if (verdict === "Approved") {
      writeResult({
        mode: "refused",
        code_max: codeMax,
        rev_max: revMax,
        verdict,
        next_round: null,
        next_artifact: null,
        review_artifact: reviewArtifact,
        message: `Latest ${reviewArtifact} verdict is Approved with no findings. Nothing to fix. Run /commit to proceed.`
      }, 1);
      return;
    }

    if (verdict === "Rejected") {
      writeResult({
        mode: "refused",
        code_max: codeMax,
        rev_max: revMax,
        verdict,
        next_round: null,
        next_artifact: null,
        review_artifact: reviewArtifact,
        message: `Latest ${reviewArtifact} verdict is Rejected. This requires a fresh implementation strategy; re-plan or discuss with maintainers before re-running /code-task ${taskId}.`
      }, 1);
      return;
    }

    const nextRound = codeMax + 1;
    const nextArtifact = artifactName("code", nextRound);
    const optional = verdict === "Approved-with-issues";
    writeResult({
      mode: "fix",
      code_max: codeMax,
      rev_max: revMax,
      verdict,
      next_round: nextRound,
      next_artifact: nextArtifact,
      review_artifact: reviewArtifact,
      message: optional
        ? `Latest ${reviewArtifact} approved with non-blocking findings. Entering optional fix mode (round ${nextRound} -> ${nextArtifact}).`
        : `Latest ${reviewArtifact} requests changes. Entering required fix mode (round ${nextRound} -> ${nextArtifact}).`
    }, 0);
  } catch (error) {
    writeResult({
      mode: "error",
      code_max: 0,
      rev_max: 0,
      verdict: null,
      next_round: null,
      next_artifact: null,
      review_artifact: null,
      message: `Mode detection failed: ${error instanceof Error ? error.message : String(error)}`
    }, 2);
  }
}

function maxRound(entries, stem) {
  let max = 0;
  for (const entry of entries) {
    if (entry === `${stem}.md`) {
      max = Math.max(max, 1);
      continue;
    }

    const match = entry.match(new RegExp(`^${escapeRegExp(stem)}-r(\\d+)\\.md$`));
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max;
}

function artifactName(stem, round) {
  return round === 1 ? `${stem}.md` : `${stem}-r${round}.md`;
}

function parseVerdict(reviewPath) {
  if (!fs.existsSync(reviewPath)) {
    return { ok: false, verdict: null, message: `Review artifact not found: ${path.basename(reviewPath)}` };
  }

  const content = fs.readFileSync(reviewPath, "utf8");
  const summary = extractSection(content, ["审查摘要", "Review Summary"]);
  const fileName = path.basename(reviewPath);
  if (!summary) {
    return { ok: false, verdict: null, message: `cannot locate review summary section in ${fileName}` };
  }

  const verdictMatch = summary.match(/^[-*]?\s*\*\*(?:总体结论|Overall Verdict)\*\*[:：]\s*(.+?)\s*$/im);
  if (!verdictMatch) {
    return { ok: false, verdict: null, message: `cannot parse verdict in ${fileName}` };
  }

  const verdict = normalizeVerdict(verdictMatch[1]);
  if (!verdict) {
    return {
      ok: false,
      verdict: null,
      message: `unrecognized verdict '${verdictMatch[1].trim()}' in ${fileName}`
    };
  }

  if (verdict !== "Approved") {
    return { ok: true, verdict };
  }

  const findingsMatch = summary.match(/^[-*]?\s*\*\*(?:发现（AI 可处理）|Findings \(AI-actionable\))\*\*[:：]\s*(.+?)\s*$/im);
  if (!findingsMatch) {
    return { ok: false, verdict, message: `cannot parse findings count in ${fileName}` };
  }

  const counts = findingsMatch[1].match(/(\d+)\s*(?:阻塞项|blockers?).*?(\d+)\s*(?:主要|majors?).*?(\d+)\s*(?:次要|minors?)/i);
  if (!counts) {
    return { ok: false, verdict, message: `cannot parse findings count in ${fileName}` };
  }

  const [, blockers, majors, minors] = counts.map(Number);
  return {
    ok: true,
    verdict: blockers === 0 && majors === 0 && minors === 0 ? "Approved" : "Approved-with-issues"
  };
}

function normalizeVerdict(raw) {
  const value = String(raw).trim().toLowerCase();
  if (value === "通过" || value === "approved") {
    return "Approved";
  }
  if (value === "需要修改" || value === "changes requested") {
    return "Changes Requested";
  }
  if (value === "拒绝" || value === "rejected") {
    return "Rejected";
  }
  return "";
}

function extractSection(content, names) {
  const lines = content.split(/\r?\n/);
  const nameSet = new Set(names);
  const start = lines.findIndex((line) => {
    const match = line.trim().match(/^##\s+(.+?)\s*$/);
    return match ? nameSet.has(match[1]) : false;
  });

  if (start === -1) {
    return "";
  }

  const sectionLines = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      break;
    }
    sectionLines.push(lines[index]);
  }
  return sectionLines.join("\n");
}

function writeResult(result, code) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = code;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main();
