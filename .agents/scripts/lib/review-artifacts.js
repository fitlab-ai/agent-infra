// Shared helpers for review-artifact parsing.
// Imported by both .agents/skills/code-task/scripts/detect-mode.js and
// .agents/scripts/validate-artifact.js so the round/verdict vocabulary stays
// in a single source of truth (prevents the cross-file drift this lifecycle
// is designed to eliminate).
import fs from "node:fs";
import path from "node:path";

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function maxRound(entries, stem) {
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

export function artifactName(stem, round) {
  return round === 1 ? `${stem}.md` : `${stem}-r${round}.md`;
}

export function normalizeVerdict(raw) {
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

export function extractSection(content, names) {
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

// Parse the canonical verdict out of a review-* artifact.
// Returns { ok, verdict, message }. Verdict collapses Approved into
// "Approved-with-issues" when the findings counts are non-zero.
export function parseVerdict(reviewPath) {
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
