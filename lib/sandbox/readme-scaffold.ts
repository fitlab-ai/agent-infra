import fs from 'node:fs';
import path from 'node:path';
import { shareBranchDir, shareCommonDir } from './constants.ts';

type ScaffoldResult = { created: boolean; path: string };
type WriteStderr = (chunk: string) => void;
type ScaffoldFs = Pick<typeof fs, 'mkdirSync' | 'writeFileSync'>;
type ScaffoldOptions = {
  writeStderr?: WriteStderr;
  fsModule?: ScaffoldFs;
};

const DOTFILES_README = `# User-level dotfiles channel

This directory is mounted **read-only** into every sandbox container at
\`/dotfiles\`. On entry, \`sandbox-dotfiles-link\` mirrors every file here as a
symlink under \`$HOME\` (e.g. \`.tmux.conf\` -> \`/home/devuser/.tmux.conf\`),
overriding image defaults so your editor, shell, and tool preferences follow
you across \`ai sandbox destroy + create\`.

See: https://github.com/fitlab-ai/agent-infra/blob/main/README.md#user-level-dotfiles-channel

Common usage - drop files or symlinks here:

\`\`\`sh
# Real files
echo "set -g mouse on" > ~/.agent-infra/dotfiles/.tmux.conf

# Symlinks to live host paths
ln -s ~/.tmux.conf       ~/.agent-infra/dotfiles/.tmux.conf
ln -s ~/.config/lazygit  ~/.agent-infra/dotfiles/.config/lazygit
\`\`\`

> Do **not** put secrets here. Use the dedicated SSH / credential mounts.

If you delete this file, the next \`ai sandbox create\` will re-create it
verbatim. To stop seeing it, edit or empty the file in place - the scaffold
only writes \`README.md\` when it is missing, never when it already exists.

---

# 用户级 dotfiles 通道

该目录被以**只读**方式挂载到每个 sandbox 容器的 \`/dotfiles\`。容器启动时，
\`sandbox-dotfiles-link\` 会把这里的每个文件 \`ln -sfn\` 到 \`$HOME\` 对应路径
（例如 \`.tmux.conf -> /home/devuser/.tmux.conf\`），覆盖镜像默认值，让你的编辑器、
shell、工具偏好跨 \`ai sandbox destroy + create\` 持久存在。

参考：https://github.com/fitlab-ai/agent-infra/blob/main/README.zh-CN.md#用户级-dotfiles-通道

常见用法：把文件或符号链接放进来：

\`\`\`sh
# 直接放文件
echo "set -g mouse on" > ~/.agent-infra/dotfiles/.tmux.conf

# 用符号链接指向 host 实际文件
ln -s ~/.tmux.conf       ~/.agent-infra/dotfiles/.tmux.conf
ln -s ~/.config/lazygit  ~/.agent-infra/dotfiles/.config/lazygit
\`\`\`

> **不要**在此放任何凭证。SSH / 凭证请使用专用挂载通道。

如果你删除该文件，下一次 \`ai sandbox create\` 会原样重新生成。如果你不想再
看到它，**就地编辑或清空内容**即可：scaffold 仅在 \`README.md\` **缺失**时
写入，文件存在（哪怕被清空）就不会被重写。
`;

const SHARE_COMMON_README = `# /share/common - host <-> sandbox shared scratch (cross-branch)

This directory is mounted **read-write** into every sandbox container of this
project at \`/share/common\`, regardless of branch. Drop files here to share
between host and any sandbox without polluting the git worktree.

See: https://github.com/fitlab-ai/agent-infra/blob/main/README.md#host-sandbox-file-exchange

This file is safe to delete; the next \`ai sandbox create\` will re-create it.

---

# /share/common - 宿主 <-> sandbox 共享暂存（跨分支）

该目录被以**读写**方式挂载到本项目所有 sandbox 容器的 \`/share/common\`，
跨分支可见。可用来在宿主和任意 sandbox 之间传文件，无需弄脏 git worktree。

参考：https://github.com/fitlab-ai/agent-infra/blob/main/README.zh-CN.md#宿主-沙箱文件交换

该文件可以安全删除；下一次 \`ai sandbox create\` 会重新生成。
`;

const SHARE_BRANCH_README = `# /share/branch - host <-> sandbox shared scratch (branch-exclusive)

This directory is mounted **read-write** into the sandbox container of this
project's current branch at \`/share/branch\`. Files here are exclusive to this
branch's sandbox and do not leak across branches.

See: https://github.com/fitlab-ai/agent-infra/blob/main/README.md#host-sandbox-file-exchange

This file is safe to delete; the next \`ai sandbox create\` will re-create it.

---

# /share/branch - 宿主 <-> sandbox 共享暂存（分支独占）

该目录被以**读写**方式挂载到本项目当前分支 sandbox 容器的 \`/share/branch\`，
仅当前分支可见，不会跨分支泄漏。

参考：https://github.com/fitlab-ai/agent-infra/blob/main/README.zh-CN.md#宿主-沙箱文件交换

该文件可以安全删除；下一次 \`ai sandbox create\` 会重新生成。
`;

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';
}

function ensureFile(target: string, content: string, options: ScaffoldOptions): ScaffoldResult {
  const writeStderr = options.writeStderr ?? ((chunk) => process.stderr.write(chunk));
  const fsModule = options.fsModule ?? fs;
  const result: ScaffoldResult = { created: false, path: target };

  try {
    fsModule.mkdirSync(path.dirname(target), { recursive: true });
  } catch (error) {
    writeStderr(`sandbox-readme-scaffold: skipping ${target} (${errorDetail(error)})\n`);
    return result;
  }

  try {
    fsModule.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
    result.created = true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return result;
    }
    writeStderr(`sandbox-readme-scaffold: skipping ${target} (${errorDetail(error)})\n`);
  }

  return result;
}

export function ensureDotfilesReadme(dotfilesDir: string, options: ScaffoldOptions = {}): ScaffoldResult {
  return ensureFile(path.join(dotfilesDir, 'README.md'), DOTFILES_README, options);
}

export function ensureShareCommonReadme(
  config: { shareBase: string },
  options: ScaffoldOptions = {}
): ScaffoldResult {
  return ensureFile(path.join(shareCommonDir(config), 'README.md'), SHARE_COMMON_README, options);
}

export function ensureShareBranchReadme(
  config: { shareBase: string },
  branch: string,
  options: ScaffoldOptions = {}
): ScaffoldResult {
  return ensureFile(path.join(shareBranchDir(config, branch), 'README.md'), SHARE_BRANCH_README, options);
}

export function ensureSandboxDiscoveryReadmes(
  config: { shareBase: string; dotfilesDir: string },
  branch: string,
  options: ScaffoldOptions = {}
): ScaffoldResult[] {
  return [
    ensureDotfilesReadme(config.dotfilesDir, options),
    ensureShareCommonReadme(config, options),
    ensureShareBranchReadme(config, branch, options)
  ];
}
