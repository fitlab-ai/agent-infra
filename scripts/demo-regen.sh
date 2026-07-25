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
gif="assets/demo-init.gif"
webm="assets/demo-init.webm"
target_duration=25  # seconds — fixed across all machines
max_bytes=4194304
repo_root=$(pwd)
local_cli="$repo_root/dist/bin/cli.js"

tmp=$(mktemp).tape
shim_dir=$(mktemp -d)
palette_base=$(mktemp "${TMPDIR:-/tmp}/demo-palette.XXXXXX")
palette="${palette_base}.png"
gif_tmp_base=$(mktemp "assets/demo-init.XXXXXX")
gif_tmp="${gif_tmp_base}.gif"
trap 'rm -rf "$tmp" "$webm" "$palette_base" "$palette" "$gif_tmp_base" "$gif_tmp" "$shim_dir"' EXIT

# ── Ensure local build exists and shim `ai` / `agent-infra` to it ──
# Demo tape types `ai init`; without this shim it resolves
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

# ── Use only canonical settings and switch output to WebM ──
sed 's|Output assets/demo-init\.gif|Output assets/demo-init.webm|' "$tape" > "$tmp"

# ── Record via VHS (lossless WebM) ──
vhs "$tmp"

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
fps=15,scale=1280:-1:flags=lanczos,palettegen=max_colors=128:reserve_transparent=0" \
  -frames:v 1 "$palette" 2>/dev/null

# Pass 2: Encode GIF from original WebM using the color-accurate palette.
ffmpeg -y -i "$webm" -i "$palette" \
  -lavfi "fps=15,scale=1280:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" \
  "$gif_tmp" 2>/dev/null

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
"$python" scripts/normalize-gif-duration.py "$gif_tmp" "$target_duration"

header=$(dd if="$gif_tmp" bs=6 count=1 2>/dev/null || true)
case "$header" in
  GIF87a|GIF89a) ;;
  *) echo "demo-regen: generated output is not a GIF." >&2; exit 1 ;;
esac

size=$(wc -c < "$gif_tmp" | tr -d ' ')
if [ "$size" -gt "$max_bytes" ]; then
  echo "demo-regen: generated GIF exceeds 4 MiB ($size bytes)." >&2
  exit 1
fi

mv "$gif_tmp" "$gif"
