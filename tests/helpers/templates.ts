import path from "node:path";
import { exists, listSkillNames, read } from "./paths.ts";

type Replacements = {
  project: string;
  org: string;
};
type Frontmatter = {
  name: string;
  description: string;
};

function langTemplate(basePath: string, lang: string): string {
  const ext = path.extname(basePath);
  const variant = /\.(?:en|zh-CN)(?=\.[^.]+$)/.test(basePath)
    ? basePath.replace(/\.(?:en|zh-CN)(?=\.[^.]+$)/, `.${lang}`)
    : basePath.replace(ext, `.${lang}${ext}`);
  if (exists(variant)) {
    return variant;
  }

  return basePath;
}

function renderPlaceholders(content: string, replacements: Replacements): string {
  return content
    .replace(/\{\{project\}\}/g, replacements.project)
    .replace(/\{\{org\}\}/g, replacements.org);
}

function buildCommandSyncFiles(project: string): [string, string][] {
  return listSkillNames().flatMap((skill) => [
    [`.claude/commands/${skill}.md`, `templates/.claude/commands/${skill}.en.md`],
    [`.opencode/commands/${skill}.md`, `templates/.opencode/commands/${skill}.en.md`],
    [`.gemini/commands/${project}/${skill}.toml`, `templates/.gemini/commands/_project_/${skill}.en.toml`]
  ]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseFrontmatter(relativePath: string): Frontmatter | null {
  const content = read(relativePath);
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

  if (!match) {
    return null;
  }

  const lines = (match[1] ?? "").split(/\r?\n/);
  let name = "";
  let description = "";

  const normalizeValue = (value: string): string => value.replace(/^["']|["']$/g, "").trim();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.startsWith("name:")) {
      name = normalizeValue(line.slice("name:".length).trim());
      continue;
    }

    if (!line.startsWith("description:")) {
      continue;
    }

    const value = line.slice("description:".length).trim();
    if (value === ">") {
      const descriptionLines: string[] = [];

      for (let offset = index + 1; offset < lines.length; offset += 1) {
        const descriptionLine = lines[offset] ?? "";
        if (!/^\s+/.test(descriptionLine)) {
          break;
        }

        descriptionLines.push(descriptionLine.trim());
        index = offset;
      }

      description = descriptionLines.join(" ").trim();
      continue;
    }

    description = normalizeValue(value);
  }

  return { name, description };
}

function skillDocPaths(skill: string): string[] {
  return [
    `.agents/skills/${skill}/SKILL.md`,
    `templates/.agents/skills/${skill}/SKILL.en.md`,
    `templates/.agents/skills/${skill}/SKILL.zh-CN.md`
  ].filter(exists);
}

export {
  buildCommandSyncFiles,
  escapeRegExp,
  langTemplate,
  parseFrontmatter,
  renderPlaceholders,
  skillDocPaths
};
