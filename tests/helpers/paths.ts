import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveProjectTaskWorkspaceRoot, resolveTaskWorkspaceLayout } from "../../lib/task/workspace-root.ts";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const fixtureRoots = new Set<string>();
const fixtureProjects = new Map<string, string>();
const taskRoots = new Map<string, string>();
const fixtureAgentClients = ["claude-code", "codex", "antigravity-cli", "opencode", "traecli"].map((id) => ({
  id,
  enabled: true,
  installInSandbox: false
}));
process.once("exit", () => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

// Ordinary fixtures share a real directory identity with Git and child processes.
function createTempDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function isolatedTestHome(): string {
  const home = process.env.AGENT_INFRA_TEST_HOME;
  if (!home || path.resolve(home) !== path.resolve(process.env.HOME || process.env.USERPROFILE || "")) {
    throw new Error("task workspace fixtures require the isolated HOME created by scripts/run-tests.js");
  }
  return home;
}

function taskWorkspaceProject(repoRoot: string): string {
  const key = path.resolve(repoRoot);
  let project = fixtureProjects.get(key);
  if (!project) {
    project = `${path.basename(repoRoot).toLowerCase().replace(/[^a-z0-9-]/gu, "-")}-${randomUUID()}`;
    fixtureProjects.set(key, project);
  }
  return project;
}

function createTaskWorkspaceFixture(prefix: string): { repoRoot: string; home: string; project: string; taskRoot: string } {
  const repoRoot = createTempDir(prefix);
  fixtureRoots.add(repoRoot);
  const home = isolatedTestHome();
  const project = taskWorkspaceProject(repoRoot);
  const agents = path.join(repoRoot, ".agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, ".airc.json"), JSON.stringify({ project, agentClients: fixtureAgentClients }));
  const taskRoot = resolveTaskWorkspaceLayout({ project, boundary: "host", home }).root;
  fs.mkdirSync(taskRoot, { recursive: true });
  taskRoots.set(path.resolve(taskRoot), repoRoot);
  return { repoRoot, home, project, taskRoot };
}

function taskWorkspaceRoot(repoRoot: string, home?: string): string {
  const configPath = path.join(repoRoot, ".agents", ".airc.json");
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      project: taskWorkspaceProject(repoRoot),
      agentClients: fixtureAgentClients
    }));
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as { project?: unknown };
  if (config.project === undefined) {
    config.project = taskWorkspaceProject(repoRoot);
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  }
  if (typeof config.project !== "string" || config.project.length === 0) throw new Error("fixture project identity is missing");
  const taskRoot = home
    ? resolveTaskWorkspaceLayout({ project: config.project, boundary: "host", home }).root
    : (isolatedTestHome(), resolveProjectTaskWorkspaceRoot(repoRoot));
  taskRoots.set(path.resolve(taskRoot), path.resolve(repoRoot));
  return taskRoot;
}

function taskWorkspaceRepoRoot(taskPath: string): string | undefined {
  const absolutePath = path.resolve(taskPath);
  return [...taskRoots.entries()]
    .filter(([root]) => absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`))
    .sort(([left], [right]) => right.length - left.length)[0]?.[1];
}

function filePath(relativePath: string): string {
  const directPath = path.join(rootDir, relativePath);
  if (fs.existsSync(directPath)) {
    return directPath;
  }
  if (relativePath.endsWith(".js")) {
    const tsPath = path.join(rootDir, `${relativePath.slice(0, -3)}.ts`);
    if (fs.existsSync(tsPath)) {
      return tsPath;
    }
  }
  return directPath;
}

function exists(relativePath: string): boolean {
  return fs.existsSync(filePath(relativePath));
}

function read(relativePath: string): string {
  return fs.readFileSync(filePath(relativePath), "utf8");
}

function listFilesRecursive(relativeDir: string): string[] {
  const entries = fs.readdirSync(filePath(relativeDir), { withFileTypes: true });

  return entries.flatMap((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      return listFilesRecursive(relativePath);
    }
    return [relativePath];
  });
}

function listSkillNames(): string[] {
  return fs.readdirSync(filePath(".agents/skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export {
  createTempDir,
  isolatedTestHome,
  taskWorkspaceProject,
  createTaskWorkspaceFixture,
  taskWorkspaceRoot,
  taskWorkspaceRepoRoot,
  exists,
  filePath,
  listFilesRecursive,
  listSkillNames,
  read
};
