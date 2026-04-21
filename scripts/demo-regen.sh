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

tmp=$(mktemp).tape
trap 'rm -f "$tmp" "$webm" /tmp/demo-palette.png' EXIT

# ── Merge local settings + switch output to WebM ──
{
  [ -f "$local" ] && cat "$local"
  sed 's|Output assets/demo-init\.gif|Output assets/demo-init.webm|' "$tape"
} > "$tmp"

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
palettegen=max_colors=256:reserve_transparent=0" \
  -frames:v 1 /tmp/demo-palette.png 2>/dev/null

# Pass 2: Encode GIF from original WebM using the color-accurate palette.
ffmpeg -y -i "$webm" -i /tmp/demo-palette.png \
  -lavfi "paletteuse=dither=bayer:bayer_scale=3" \
  "$gif" 2>/dev/null

# ── Normalize frame delays to fixed target duration ──
python3 scripts/normalize-gif-duration.py "$gif" "$target_duration"
