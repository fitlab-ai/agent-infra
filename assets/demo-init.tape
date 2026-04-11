# demo-init.tape — Install & Initialize agent-infra
# Usage: vhs assets/demo-init.tape
#
# Prerequisites:
#   - agent-infra already installed (npm install -g @fitlab-ai/agent-infra)
#   - tree installed (brew install tree)

Output assets/demo-init.gif

Require node
Require tree

Set Shell "zsh"
Set FontSize 16
Set Width 960
Set Height 600
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 50ms
Set WindowBar Colorful
Set WindowBarSize 40

# ── Show version ──
Type "ai version"
Enter
Sleep 1.5s

# ── Prepare a demo project directory ──
Type "mkdir -p /tmp/my-awesome-project && cd /tmp/my-awesome-project"
Enter
Sleep 500ms

Type "git init -q && git remote add origin git@github.com:acme-corp/my-awesome-project.git"
Enter
Sleep 500ms

# ── Initialize agent-infra ──
Type "ai init"
Enter
Sleep 1.5s

# Prompt 1: Project name (accept auto-detected default)
Enter
Sleep 1s

# Prompt 2: Organization (accept auto-detected default)
Enter
Sleep 1s

# Prompt 3: Language — choose English
Type "en"
Enter
Sleep 3s

# ── Show generated structure ──
Type "tree .agents/ .claude/ .gemini/ .opencode/ -L 2 --dirsfirst"
Enter
Sleep 4s
