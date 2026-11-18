import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closePrompt, prompt, select } from './prompt.ts';
import { resolveTemplateDir } from './paths.ts';
import { listAgentClientAdapters } from './agent-clients/registry.ts';

type Registration = { name: string; type: 'project' | 'local'; path: string };
type SkillConfig = {
  skills?: { sources?: { type: string; path: string }[]; registrations?: Registration[] };
  files?: { managedBaselines?: Record<string, unknown> };
};

const NAME = /^[a-zA-Z0-9_.@-]+$/;
const hash = (data: Buffer | string) => `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
const norm = (value: string) => value.split(path.sep).join('/').replace(/^\.\//, '');

function safeProjectTarget(target: string, root = process.cwd()): string | null {
  if (path.isAbsolute(target)) return null;
  const absolute = path.resolve(root, target);
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  let current = path.resolve(root);
  const parent = path.relative(current, path.dirname(absolute));
  for (const segment of parent ? parent.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      return null;
    }
  }
  return absolute;
}

function sameIdentity(registration: Registration, candidate: { name: string; type: 'project' | 'local'; path: string }): boolean {
  if (registration.name !== candidate.name || registration.type !== candidate.type) return false;
  const resolve = (type: 'project' | 'local', value: string) => type === 'project' ? path.resolve(value) : resolveLocal(value);
  return resolve(registration.type, registration.path) === resolve(candidate.type, candidate.path);
}

function readConfig(root = process.cwd()): { file: string; config: SkillConfig } {
  const file = path.join(root, '.agents', '.airc.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as SkillConfig;
  if (config.skills?.registrations !== undefined && !Array.isArray(config.skills.registrations)) {
    throw new Error('skills.registrations must be an array.');
  }
  return { file, config };
}

function writeConfig(file: string, config: SkillConfig): void {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* preserve original error */ }
    throw error;
  }
}

function resolveLocal(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.resolve(os.homedir(), input.slice(2));
  return path.resolve(input);
}

function templateNames(): Set<string> {
  const template = resolveTemplateDir();
  if (!template) throw new Error('Built-in skill templates are unavailable.');
  const dir = path.join(template, '.agents', 'skills');
  return new Set(fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ['SKILL.md', 'SKILL.en.md', 'SKILL.zh-CN.md'].some((file) => fs.existsSync(path.join(dir, entry.name, file))))
    .map((entry) => entry.name));
}

function isSkillDocument(file: string, followSymlink: boolean): boolean {
  try {
    const stat = followSymlink ? fs.statSync(file) : fs.lstatSync(file);
    return stat.isFile() && (followSymlink || !stat.isSymbolicLink());
  } catch {
    return false;
  }
}

function localCandidates(config: SkillConfig): { name: string; type: 'project' | 'local'; path: string }[] {
  const result: { name: string; type: 'project' | 'local'; path: string }[] = [];
  const projectDir = path.resolve('.agents/skills');
  if (fs.existsSync(projectDir)) {
    for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (entry.isDirectory() && isSkillDocument(path.join(projectDir, entry.name, 'SKILL.md'), false)) {
        result.push({ name: entry.name, type: 'project', path: path.join(projectDir, entry.name) });
      }
    }
  }
  for (const source of config.skills?.sources ?? []) {
    if (source?.type !== 'local' || typeof source.path !== 'string') continue;
    const root = resolveLocal(source.path);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(root, entry.name);
      if (isSkillDocument(path.join(skillPath, 'SKILL.md'), true)) {
        result.push({ name: entry.name, type: 'local', path: skillPath });
      }
    }
  }
  return result;
}

function removeEmptyDirs(dir: string, stop: string): void {
  let current = dir;
  while (current !== stop && current.startsWith(`${stop}${path.sep}`) && fs.existsSync(current)) {
    if (fs.readdirSync(current).length > 0) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function removeUnchangedSkillFile(absolute: string, baseline: string): boolean {
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || hash(fs.readFileSync(absolute)) !== baseline) return false;
    fs.unlinkSync(absolute);
    return true;
  } catch { /* unavailable or changed files remain protected */ }
  return false;
}

function cleanupLocalSkillLink(
  name: string,
  registration: Registration,
  removed: string[]
): void {
  const skillRoot = safeProjectTarget(path.join('.agents', 'skills', name));
  if (registration.type !== 'local' || !skillRoot) return;
  const skillRootStat = fs.lstatSync(skillRoot, { throwIfNoEntry: false });
  if (!skillRootStat?.isSymbolicLink()) return;
  try {
    const linkedPath = path.resolve(path.dirname(skillRoot), fs.readlinkSync(skillRoot));
    if (linkedPath !== resolveLocal(registration.path)) return;
    fs.unlinkSync(skillRoot);
    removed.push(norm(path.relative(process.cwd(), skillRoot)));
  } catch { /* only an exact, readable project link is removable */ }
}

function cleanupClientCommands(name: string, baselines: Record<string, unknown>, removed: string[]): void {
  for (const adapter of listAgentClientAdapters()) {
    const descriptor = adapter.project.customCommand;
    if (!descriptor) continue;
    const target = descriptor.target.replaceAll('${skillName}', name);
    const baseline = baselines[target];
    if (typeof baseline === 'string' && baseline.startsWith('sha256:')) {
      const absolute = safeProjectTarget(target);
      if (absolute && removeUnchangedSkillFile(absolute, baseline)) {
        removed.push(target);
        try { removeEmptyDirs(path.dirname(absolute), process.cwd()); } catch { /* client directory cleanup is best-effort */ }
      }
    }
    delete baselines[target];
  }
}

function cleanupOwnedOutputs(name: string, registration: Registration, config: SkillConfig): string[] {
  const removed: string[] = [];
  cleanupLocalSkillLink(name, registration, removed);
  const baselines = config.files?.managedBaselines;
  if (baselines && typeof baselines === 'object') {
    cleanupClientCommands(name, baselines, removed);
  }
  return removed;
}

function listSkills(builtins: Set<string>, candidates: ReturnType<typeof localCandidates>, registrations?: Registration[]): number {
  for (const name of [...builtins].sort()) process.stdout.write(`builtin\t${name}\n`);
  for (const item of candidates) {
    if (item.type === 'project' && builtins.has(item.name)) continue;
    const registration = registrations?.find((entry) => sameIdentity(entry, item));
    const conflicts = candidates.filter((candidate) => candidate.name === item.name).length > 1;
    process.stdout.write(`${registration ? 'registered' : 'unregistered'}\t${conflicts ? 'conflict' : 'available'}\t${item.type}\t${item.name}\t${item.path}\n`);
  }
  for (const registration of registrations ?? []) {
    if (!candidates.some((item) => sameIdentity(registration, item))) {
      process.stdout.write(`registered\tunavailable\t${registration.type}\t${registration.name}\t${registration.path}\n`);
    }
  }
  return 0;
}

async function addSkill(
  file: string,
  config: SkillConfig,
  candidates: ReturnType<typeof localCandidates>,
  builtins: Set<string>,
  requestedName?: string
): Promise<number> {
  if (!Array.isArray(config.skills?.registrations)) config.skills = { ...(config.skills ?? {}), registrations: [] };
  const list = config.skills!.registrations!;
  const available = candidates.filter((item) => !builtins.has(item.name));
  if (!available.length) throw new Error('No custom skills are available from the project or configured local sources.');
  const choices = available.map((item) => `${item.name} — ${item.path}`);
  const selectedName = requestedName || await select('Choose a custom skill', choices);
  const matches = available.filter((item) => selectedName === item.name || selectedName === `${item.name} — ${item.path}`);
  if (matches.length > 1) throw new Error(`Skill '${selectedName}' has multiple sources. Run ai skill add interactively and choose an exact path.`);
  const selected = matches[0];
  if (!selected) throw new Error(`Unknown custom skill candidate: ${selectedName}`);
  if (!NAME.test(selected.name)) throw new Error('The skill name is invalid or reserved by a built-in skill.');
  if (list.some((entry) => entry.name === selected.name)) throw new Error(`Skill '${selected.name}' is already registered. Remove it before changing its source.`);
  list.push({ name: selected.name, type: selected.type, path: selected.type === 'project' ? norm(path.relative(process.cwd(), selected.path)) : selected.path });
  writeConfig(file, config);
  process.stdout.write(`Registered ${selected.name} from ${selected.path}. Run update-agent-infra to link it into the project.\n`);
  return 0;
}

async function removeSkill(
  file: string,
  config: SkillConfig,
  builtins: Set<string>,
  requestedName?: string
): Promise<number> {
  if (!Array.isArray(config.skills?.registrations)) config.skills = { ...(config.skills ?? {}), registrations: [] };
  const list = config.skills!.registrations!;
  const name = requestedName || await prompt('Custom skill name to remove', '');
  const index = list.findIndex((entry) => entry.name === name);
  if (builtins.has(name)) throw new Error(`Built-in skill '${name}' cannot be removed.`);
  if (index < 0) throw new Error(`Custom skill '${name}' is not registered.`);
  const [registration] = list.splice(index, 1);
  writeConfig(file, config);
  const removed = cleanupOwnedOutputs(name, registration!, config);
  writeConfig(file, config);
  process.stdout.write(`Unregistered ${name}; source files were preserved.${removed.length ? ` Removed verified generated files: ${removed.join(', ')}` : ''}\n`);
  return 0;
}

export async function cmdSkill(args: string[]): Promise<number> {
  const [action, requestedName] = args;
  if (typeof action !== 'string' || !['add', 'list', 'remove'].includes(action)) {
    process.stderr.write('Usage: ai skill <add|list|remove> [name]\n');
    return 2;
  }
  try {
    const { file, config } = readConfig();
    const builtins = templateNames();
    if (action === 'list') return listSkills(builtins, localCandidates(config), config.skills?.registrations);
    if (action === 'add') return await addSkill(file, config, localCandidates(config), builtins, requestedName);
    return await removeSkill(file, config, builtins, requestedName);
  } catch (error) {
    closePrompt();
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
