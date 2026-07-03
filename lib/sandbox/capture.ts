import { spawn } from 'node:child_process';
import { loadConfig } from './config.ts';
import { containerNameCandidates, sandboxBranchLabel, sandboxLabel } from './constants.ts';
import { detectEngine } from './engine.ts';
import { hostTimezoneEnvFlags, terminalEnvFlags } from './commands/enter.ts';
import {
  fetchSandboxRows,
  selectSandboxContainer,
  startSandboxContainer,
  type SandboxRow
} from './commands/list-running.ts';

export type SandboxCaptureRequest = {
  taskRef: string;
  branch: string;
  command: string[];
  timeoutMs?: number;
};

export type SandboxCaptureResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  run?: SandboxRunMetadata;
};

export type SandboxRunMetadata = {
  runId: string;
  engine: string;
  container: string;
  runDir: string;
};

export type SandboxCaptureOptions = {
  engine?: string;
  repoRoot?: string;
  runId?: string;
  containerCandidates?: string[];
  rows?: SandboxRow[];
  startContainer?: (name: string) => void;
  spawn?: (file: string, args: string[]) => Promise<SandboxCaptureResult>;
};

async function spawnCapture(
  file: string,
  args: string[]
): Promise<SandboxCaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const resolveOnce = (result: SandboxCaptureResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectOnce);
    child.on('close', (exitCode, signal) => {
      resolveOnce({ exitCode, signal, stdout, stderr });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createRunId(date: Date = new Date()): string {
  return `run-${date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '').replace('T', '-').replace('Z', '')}-${process.pid}`;
}

function buildRunScript(params: {
  command: string[];
  runDir: string;
  runId: string;
}): string {
  const command = params.command.map(shellQuote).join(' ');
  const runDir = shellQuote(params.runDir);
  const runId = shellQuote(params.runId);
  return `#!/bin/sh
set -u
cd /workspace
date "+%Y-%m-%d %H:%M:%S%:z" > ${runDir}/started_at
printf '%s\\n' running > ${runDir}/status
${command}
code=$?
printf '%s\\n' "$code" > ${runDir}/exit_code
date "+%Y-%m-%d %H:%M:%S%:z" > ${runDir}/finished_at
if [ "$code" -eq 0 ]; then
  printf '%s\\n' completed > ${runDir}/status
else
  printf '%s\\n' failed > ${runDir}/status
fi
printf '\\n[agent-infra] run %s finished with exit code %s\\n' ${runId} "$code"
exec bash -l
`;
}

function buildTmuxLauncher(params: {
  request: SandboxCaptureRequest;
  runId: string;
}): string {
  const session = 'work';
  const window = `ai-${params.runId.replace(/^run-/, '').slice(0, 18)}`;
  const runRoot = '/tmp/agent-infra-runs';
  const runDir = `${runRoot}/${params.runId}`;
  const runScript = buildRunScript({ command: params.request.command, runDir, runId: params.runId });
  const runScriptBase64 = Buffer.from(runScript, 'utf8').toString('base64');
  const paneCommand = `cd /workspace && ${shellQuote(`${runDir}/run.sh`)}`;

  return `set -eu
session=${shellQuote(session)}
window=${shellQuote(window)}
run_id=${shellQuote(params.runId)}
run_dir=${shellQuote(runDir)}
task_ref=${shellQuote(params.request.taskRef)}
branch=${shellQuote(params.request.branch)}

sandbox-dotfiles-link >/dev/null 2>&1 || true
mkdir -p "$run_dir"
printf '%s\\n' pending > "$run_dir/status"
printf '%s\\n' "$task_ref" > "$run_dir/task_ref"
printf '%s\\n' "$branch" > "$run_dir/branch"
printf '%s\\n' ${shellQuote(params.request.command.join(' '))} > "$run_dir/command"
printf '%s' ${shellQuote(runScriptBase64)} | base64 -d > "$run_dir/run.sh"
chmod +x "$run_dir/run.sh"

if ! command -v tmux >/dev/null 2>&1; then
  printf '%s\\n' "tmux is not installed in this sandbox" >&2
  exit 127
fi

if ! tmux has-session -t "$session" 2>/dev/null; then
  tmux new-session -d -s "$session" -n shell
fi

if [ -n "\${TZ:-}" ]; then
  tmux set-environment -t "$session" TZ "$TZ" 2>/dev/null || true
fi

pane=$(tmux new-window -d -P -F '#{pane_id}' -t "$session" -n "$window")
printf '%s\\n' "$session" > "$run_dir/session"
printf '%s\\n' "$window" > "$run_dir/window"
printf '%s\\n' "$pane" > "$run_dir/pane"
tmux pipe-pane -o -t "$pane" "cat > $run_dir/output.log"
tmux send-keys -t "$pane" ${shellQuote(paneCommand)} Enter

cat <<EOF
Started sandbox run $run_id in tmux session '$session', window '$window', pane '$pane'.
Attach with: ai sandbox enter $task_ref
Status file: $run_dir/status
Output log: $run_dir/output.log
EOF
`;
}

export async function runInSandbox(
  request: SandboxCaptureRequest,
  options: SandboxCaptureOptions = {}
): Promise<SandboxCaptureResult> {
  const config = options.engine ? null : loadConfig();
  const engine = options.engine ?? detectEngine(config!);
  const rows =
    options.rows ??
    (() => {
      const fetched = fetchSandboxRows(engine, sandboxLabel(config!), sandboxBranchLabel(config!));
      return [...fetched.running, ...fetched.nonRunning];
    })();
  const candidates = options.containerCandidates ?? containerNameCandidates(config!, request.branch);
  const found = selectSandboxContainer(rows, candidates);
  if (!found) {
    throw new Error(
      `Sandbox for ${request.branch} not found. Create it first with ai sandbox create ${request.taskRef}.`
    );
  }
  if (!found.running) {
    (options.startContainer ?? ((name: string) => startSandboxContainer(engine, name)))(found.name);
  }
  const runId = options.runId ?? createRunId();
  const runDir = `/tmp/agent-infra-runs/${runId}`;
  const dockerArgs = [
    'exec',
    ...terminalEnvFlags(),
    ...hostTimezoneEnvFlags(),
    found.name,
    'bash',
    '-lc',
    buildTmuxLauncher({ request, runId })
  ];
  const result = await (options.spawn ?? spawnCapture)('docker', dockerArgs);
  return {
    ...result,
    run: {
      runId,
      engine,
      container: found.name,
      runDir
    }
  };
}
