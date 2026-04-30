# demo-init.tape — Install & Initialize agent-infra
# Usage: npm run demo:regen  (not `vhs` directly)
#
# Prerequisites:
#   - agent-infra already installed (npm install -g @fitlab-ai/agent-infra)
#   - tree installed (brew install tree)
#
# Machine-specific settings (e.g. Set Framerate) can be placed in
# assets/demo-settings.tape (gitignored). See demo-settings.tape.example.

Output assets/demo-init.gif

Require node
Require tree

Set Shell "zsh"
Set FontSize 32
Set Width 1920
Set Height 1200
Set Padding 40
Set Theme "Catppuccin Mocha"
Set TypingSpeed 50ms
Set WindowBar Colorful
Set WindowBarSize 40

# Suppress oh-my-zsh's omz_termsupport_cwd precmd hook (OSC 7 cwd reporting).
# When the recording shell inherits TERM_PROGRAM=iTerm.app / Apple_Terminal,
# the hook emits an escape sequence that VHS's terminal renderer mis-decodes
# as a stray glyph in the first frame. Unregistering the hook here keeps the
# recording identical across iTerm, Terminal.app, tmux, and CI.
Hide
Type "autoload -Uz add-zsh-hook 2>/dev/null; add-zsh-hook -d precmd omz_termsupport_cwd 2>/dev/null; clear"
Enter
Sleep 200ms
Show

# ── Show version ──
Type "ai version"
Enter
Wait+Screen /agent-infra/
Sleep 1.5s

# ── Prepare a demo project directory ──
Type "rm -rf /tmp/my-awesome-project && mkdir -p /tmp/my-awesome-project && cd /tmp/my-awesome-project"
Enter
Wait
Sleep 500ms

Type "git init -q && git remote add origin git@github.com:acme-corp/my-awesome-project.git"
Enter
Wait
Sleep 500ms

# ── Initialize agent-infra ──
Type "ai init"
Enter
Wait+Screen /Project name/
Sleep 1s

# Prompt 1: Project name (accept auto-detected default)
Enter
Wait+Screen /Organization/
Sleep 1s

# Prompt 2: Organization (accept auto-detected default)
Enter
Wait+Screen /Language/
Sleep 1s

# Prompt 3: Language — choose English
Type "en"
Enter
Wait+Screen /Sandbox engine/
Sleep 1s

# Prompt 4: Sandbox engine — accept default (colima)
Enter
Wait+Screen /Platform/
Sleep 1s

# Prompt 5: Platform type — accept default (github)
Enter
Wait+Screen /Template sources/
Sleep 1s

# Prompt 6: Template sources — skip (Enter)
Enter
Sleep 1s

# Prompt 7: Skill sources — skip (Enter)
Enter
Sleep 5s

# ── Show generated structure ──
Type "tree .agents/ .claude/ .gemini/ .opencode/ -L 2 --dirsfirst"
Enter
Wait
Sleep 4s
