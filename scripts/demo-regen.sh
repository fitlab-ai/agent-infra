#!/bin/sh
# Generate demo GIF with consistent colors and duration across machines.
#
# Pipeline: VHS → WebM (lossless) → ffmpeg 2-pass GIF → normalize delays
#
# Why WebM intermediate?
#   VHS's built-in GIF encoding uses ffmpeg palettegen which drops rare colors
#   (like the green ✓ checkmarks) on machines with fewer captured frames.
#   By encoding GIF ourselves with color-boosted palette generation, we ensure
#   all Catppuccin Mocha theme colors survive regardless of frame count.
set -e

tape="assets/demo-init.tape"
local="assets/demo-settings.tape"
gif="assets/demo-init.gif"
webm="assets/demo-init.webm"
target_duration=25  # seconds — fixed across all machines
repo_root=$(pwd)
local_cli="$repo_root/dist/bin/cli.js"

tmp=$(mktemp).tape
shim_dir=$(mktemp -d)
trap 'rm -rf "$tmp" "$webm" /tmp/demo-palette.png "$shim_dir"' EXIT

# ── Ensure local build exists and shim `ai` / `agent-infra` to it ──
# Demo tape types `ai version` / `ai init`; without this shim those resolve
# to whatever global `ai` is on PATH, not the current workspace build.
if [ ! -f "$local_cli" ]; then
  echo "demo-regen: $local_cli not found. Run 'npm run build' first." >&2
  exit 1
fi

for name in ai agent-infra; do
  cat >"$shim_dir/$name" <<SHIM
#!/bin/sh
exec node "$local_cli" "\$@"
SHIM
  chmod +x "$shim_dir/$name"
done

export PATH="$shim_dir:$PATH"

# ── Merge local settings + switch output to WebM ──
{
  [ -f "$local" ] && cat "$local"
  sed 's|Output assets/demo-init\.gif|Output assets/demo-init.webm|' "$tape"
} > "$tmp"

# ── Record via VHS (lossless WebM) ──
vhs "$tmp"

# ── Sanity check: local CLI version should match package.json ──
pkg_version=$(node -p "require('./package.json').version" 2>/dev/null || echo "")
shim_version=$("$shim_dir/ai" version --raw 2>/dev/null || echo "")
if [ -n "$pkg_version" ] && [ -n "$shim_version" ] && [ "$pkg_version" != "$shim_version" ]; then
  echo "demo-regen: WARNING dist/bin/cli.js reports $shim_version but package.json is $pkg_version (rebuild before recording)." >&2
fi

# ── Encode GIF with color-accurate palette ──
# Pass 1: Generate palette with Catppuccin Mocha key colors injected.
#   Small colored boxes ensure palettegen preserves minority colors (e.g. green ✓)
#   even when they occupy very few pixels. The boxes only affect palette generation,
#   NOT the final output (Pass 2 uses the original video).
ffmpeg -y -i "$webm" \
  -vf "drawbox=x=0:y=0:w=20:h=20:color=0xa6e3a1:t=fill,\
drawbox=x=20:y=0:w=20:h=20:color=0x94e2d5:t=fill,\
drawbox=x=40:y=0:w=20:h=20:color=0xf38ba8:t=fill,\
drawbox=x=60:y=0:w=20:h=20:color=0xf9e2af:t=fill,\
drawbox=x=80:y=0:w=20:h=20:color=0x89b4fa:t=fill,\
palettegen=max_colors=256:reserve_transparent=0" \
  -frames:v 1 /tmp/demo-palette.png 2>/dev/null

# Pass 2: Encode GIF from original WebM using the color-accurate palette.
ffmpeg -y -i "$webm" -i /tmp/demo-palette.png \
  -lavfi "paletteuse=dither=bayer:bayer_scale=3" \
  "$gif" 2>/dev/null

# ── Normalize frame delays to fixed target duration ──
# python3 may be absent or broken; try python3 first, fall back to python — whichever passes --version wins.
python=""
for cmd in python3 python; do
  if command -v "$cmd" >/dev/null 2>&1 && "$cmd" --version >/dev/null 2>&1; then
    python=$cmd
    break
  fi
done
: "${python:=python3}"
"$python" scripts/normalize-gif-duration.py "$gif" "$target_duration"
