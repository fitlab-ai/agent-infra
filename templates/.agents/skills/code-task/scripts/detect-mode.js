import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { artifactName, maxRound, parseVerdict } from "../../../scripts/lib/review-artifacts.js";

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

    // replan-precedes-unreviewed-code:
    // 第 8 分支（replan）必须在第 2 分支（revMax < codeMax → error）之前评估。
    // 依据 task.md 盲区 B 修法 B1：「不论 review-code 状态如何（包括未审）」，
    // 只要最新 review-plan 已批准且 mtime > code，就进入新一轮实现。
    const planMax = maxRound(entries, "plan");
    const reviewPlanMax = maxRound(entries, "review-plan");
    const replanCheck = checkPlanAheadOfCode({
      resolvedTaskDir,
      codeMax,
      planMax,
      reviewPlanMax
    });
    if (replanCheck.replan) {
      const nextRound = codeMax + 1;
      const nextArtifact = artifactName("code", nextRound);
      writeResult({
        mode: "init",
        code_max: codeMax,
        rev_max: revMax,
        verdict: null,
        next_round: nextRound,
        next_artifact: nextArtifact,
        review_artifact: replanCheck.reviewPlanArtifact,
        message: `Latest ${replanCheck.reviewPlanArtifact} is approved and its mtime is newer than the latest code artifact. Entering replan-driven init (round ${nextRound} -> ${nextArtifact}).`
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

    // human-supplemented review: after a PR is opened, a maintainer may append a
    // review-code-r{N} round against the existing latest code, so rev_max > code_max.
    // This is NOT corruption — defer to the latest review's verdict instead of erroring.
    // rev_max === code_max (AI fix round) and rev_max > code_max (human review round)
    // both fall through to the verdict dispatch below; fix mode uses next_round = code_max + 1.
    // An unparsable verdict still returns error (exit 2) as the retained anomaly guard.
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

function checkPlanAheadOfCode({ resolvedTaskDir, codeMax, planMax, reviewPlanMax }) {
  if (planMax === 0 || reviewPlanMax === 0) {
    return { replan: false };
  }

  // plan 和 review-plan 轮次独立递增（plan-r5 可被 review-plan-r4 批准），不能假设同号。
  // 用最新 review-plan 产物的「审查输入」/「Review Input」段落里引用的 plan 文件名
  // 作为真正被批准的 plan；若该 plan 文件名不等于目录里最新 plan-rN.md，
  // 说明最新 plan 还未被审查，不触发 replan。
  const reviewPlanArtifact = artifactName("review-plan", reviewPlanMax);
  const reviewPlanPath = path.join(resolvedTaskDir, reviewPlanArtifact);
  if (!fs.existsSync(reviewPlanPath)) {
    return { replan: false };
  }

  const reviewedPlan = parseReviewedPlan(reviewPlanPath);
  if (!reviewedPlan) {
    return { replan: false };
  }
  const latestPlanArtifact = artifactName("plan", planMax);
  if (reviewedPlan !== latestPlanArtifact) {
    return { replan: false };
  }

  // review-plan 的「通过 + 主要/次要建议」（Approved-with-issues）仍是已批准，
  // 区别于 review-code（Approved-with-issues 触发 optional fix）。replan 检测对
  // review-plan 放宽到 Approved + Approved-with-issues 二者均放行。
  const APPROVED_PLAN_VERDICTS = new Set(["Approved", "Approved-with-issues"]);
  const reviewVerdict = parseVerdict(reviewPlanPath);
  if (!reviewVerdict.ok || !APPROVED_PLAN_VERDICTS.has(reviewVerdict.verdict)) {
    return { replan: false };
  }

  const codeArtifact = artifactName("code", codeMax);
  const codeStat = safeStat(path.join(resolvedTaskDir, codeArtifact));
  const reviewPlanStat = safeStat(reviewPlanPath);
  if (!codeStat || !reviewPlanStat) {
    return { replan: false };
  }

  // 严格 `>`：同秒回退到既有 7 分支逻辑（保守，参见 plan-r5.md Q2 决议）
  if (reviewPlanStat.mtimeMs > codeStat.mtimeMs) {
    return { replan: true, reviewPlanArtifact };
  }
  return { replan: false };
}

function parseReviewedPlan(reviewPlanPath) {
  let content;
  try {
    content = fs.readFileSync(reviewPlanPath, "utf8");
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/);
  const headerPattern = /^[-*]\s*\*\*(?:审查输入|Review Input)\*\*[:：]/;
  const planFilePattern = /`(plan(?:-r\d+)?\.md)`/;
  let inHeader = false;
  for (const line of lines) {
    if (headerPattern.test(line)) {
      inHeader = true;
      const inline = line.match(planFilePattern);
      if (inline) return inline[1];
      continue;
    }
    if (!inHeader) continue;
    if (/^\s*[-*]\s/.test(line)) {
      const match = line.match(planFilePattern);
      if (match) return match[1];
      continue;
    }
    if (line.trim() === "") continue;
    break;
  }
  return null;
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function writeResult(result, code) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = code;
}

main();
