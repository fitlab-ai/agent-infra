import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extractPullRequestFileNames, labelDelta, planInLabelUpdate, validateRepositoryLabelPayload } from '../../lib/platform/in-label-sync.ts';

const repository = process.env.GITHUB_REPOSITORY ?? '';
const number = Number(process.env.PR_NUMBER);
if (!/^[^/]+\/[^/]+$/.test(repository) || !Number.isSafeInteger(number) || number < 1) throw new Error('Invalid event repository or PR number');
const [owner, name] = repository.split('/');
const config = JSON.parse(readFileSync('.agents/.airc.json', 'utf8'));

function api(args: string[], input?: string): any {
  return JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] }) || 'null');
}
function names(value: unknown): string[] {
  const result = validateRepositoryLabelPayload(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function readLabels(n: number): string[] {
  return names(api([`repos/${repository}/issues/${n}/labels?per_page=100`, '--paginate', '--slurp']));
}
function closingIssue(): number | null {
  const query = 'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100,after:$cursor){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage endCursor}}}}}';
  let cursor: string | null = null;
  const seen = new Map<string, { number: number; repo: string }>();
  let unidentified = false;
  do {
    const args = ['graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const page = api(args)?.data?.repository?.pullRequest?.closingIssuesReferences;
    if (!page || !Array.isArray(page.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('Invalid closing issue response');
    for (const node of page.nodes) {
      const repo = node?.repository?.nameWithOwner;
      if (!Number.isSafeInteger(node?.number) || node.number < 1 || typeof repo !== 'string' || !repo) { unidentified = true; continue; }
      seen.set(`${repo.toLowerCase()}#${node.number}`, { number: node.number, repo });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo.hasNextPage && (typeof cursor !== 'string' || !cursor)) throw new Error('Invalid closing issue cursor');
  } while (cursor);
  const issues = [...seen.values()];
  if (unidentified || issues.length !== 1 || issues[0]!.repo.toLowerCase() !== repository.toLowerCase()) {
    console.log('No uniquely identifiable issue in the event repository; syncing PR only');
    return null;
  }
  return issues[0]!.number;
}
function sync(n: number, before: string[], files: string[], repositoryLabels: Set<string>): void {
  const plan = planInLabelUpdate({ changedFiles: files, currentLabels: before, mapping: config.labels?.in, repositoryLabels });
  if (plan.error) throw new Error(plan.error.message);
  const delta = labelDelta(before, plan.target);
  try {
    for (const label of delta.remove) api([`repos/${repository}/issues/${n}/labels/${encodeURIComponent(label)}`, '-X', 'DELETE']);
    for (const label of delta.add) api([`repos/${repository}/issues/${n}/labels`, '-X', 'POST', '--input', '-'], JSON.stringify({ labels: [label] }));
  } catch (error) {
    try { console.error(`Labels after failed write to #${n}: ${JSON.stringify(readLabels(n))}; outcome may be partial or unknown`); }
    catch { console.error(`Label readback failed for #${n}; outcome unknown`); }
    throw error;
  }
  const after = readLabels(n);
  if (JSON.stringify(after) !== JSON.stringify(plan.labels)) throw new Error(`Label readback mismatch for #${n}: ${JSON.stringify(after)}`);
  console.log(JSON.stringify({ number: n, before, after, delta }));
}
const files = extractPullRequestFileNames(api([`repos/${repository}/pulls/${number}/files?per_page=100`, '--paginate', '--slurp']));
if (!files) throw new Error('Invalid PR files response');
const repoLabels = new Set(names(api([`repos/${repository}/labels?per_page=100`, '--paginate', '--slurp'])));
const issue = closingIssue();
const prBefore = readLabels(number);
const issueBefore = issue === null ? null : readLabels(issue);
sync(number, prBefore, files, repoLabels);
if (issue !== null && issueBefore !== null) sync(issue, issueBefore, files, repoLabels);
