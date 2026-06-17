#!/usr/bin/env bash
# qqb storyboard demo — capture key frames at planned moments and stitch
# into an MP4 with each frame held for ~1.2s. Crossfaded for smooth flow.
#
# Why not high-fps frame capture?
#   CDP Page.captureScreenshot in tight loops returns Internal Error in
#   QQ Browser. So we instead snapshot deliberately right after each
#   meaningful action — same visual story, no debugger pressure.
#
# Usage:  storyboard.sh [TAB_ID]

set -euo pipefail

TAB_ID="${1:-}"
FRAME_DIR="${TMPDIR:-/tmp}/qqb-demo"
OUT_DIR="$HOME/Downloads"
OUT_MP4="$OUT_DIR/qqb-demo.mp4"
HOLD=1.2          # seconds each key frame is shown
XFADE=0.35        # crossfade between frames

mkdir -p "$FRAME_DIR"
rm -f "$FRAME_DIR"/frame-*.png

if [ -z "$TAB_ID" ]; then
  TAB_ID=$(qqb tabs --refresh true 2>/dev/null | jq -r '.tabs[] | select(.attached==true) | .tabId' | head -1)
fi
if [ -z "$TAB_ID" ] || [ "$TAB_ID" = "null" ]; then
  echo "no attached tab; open extension popup and click 接管当前页 first" >&2
  exit 1
fi
echo "[demo] tab: $TAB_ID"

i=0
shot() {
  # $1 = label printed; just for our log. The screenshot is plain quiet so
  # it doesn't perturb the overlay we want to capture.
  OUT="$FRAME_DIR/frame-$(printf "%02d" "$i").png"
  # Retry up to 3x with backoff — CDP screenshot occasionally returns
  # Internal error on heavy pages; refreshing the request after a short
  # settle usually works.
  for attempt in 1 2 3; do
    if qqb screenshot --tab "$TAB_ID" --out "$OUT" --quiet true >/tmp/qqb-shot-err 2>&1; then
      echo "  📸 $i  $1"
      i=$((i+1))
      return 0
    fi
    sleep 0.4
  done
  echo "  ✗ $i  $1 (CDP error: $(cat /tmp/qqb-shot-err))" >&2
  i=$((i+1))
  return 1
}

# ── The storyboard ─────────────────────────────────────────────────────────

echo "[demo] frame 0 · idle (clean baseline)"
qqb pulse --tab "$TAB_ID" --stop true >/dev/null 2>&1 || true
sleep 0.3
shot "idle baseline"

echo "[demo] frame 1 · pulse breath at peak"
qqb pulse --tab "$TAB_ID" --label "qqb · 启动 demo" --duration 5000 >/dev/null
sleep 0.85   # land near pulse peak (1.8s breath / 2 ≈ 0.9s)
shot "breath @ peak"

echo "[demo] frame 2 · snapshot (reading)"
qqb snapshot --tab "$TAB_ID" >/dev/null
sleep 0.25   # right after — label still says reading page
shot "reading page"
sleep 0.5

echo "[demo] frame 3 · click first button → ripple expanding"
SNAP=$(qqb snapshot --tab "$TAB_ID" 2>/dev/null)
REF1=$(echo "$SNAP" | jq -r '.. | objects | select(.role=="button" and (.name=="研究" or .name=="产品" or .name=="文档")) | .nodeRef' | head -1)
if [ -n "$REF1" ] && [ "$REF1" != "null" ]; then
  qqb click "$REF1" --tab "$TAB_ID" >/dev/null || true
  sleep 0.25   # ripple at ~30% expansion
  shot "click ripple"
  sleep 0.5
fi

echo "[demo] frame 4 · second click ripple"
REF2=$(echo "$SNAP" | jq -r '.. | objects | select(.role=="button" and (.name=="支持" or .name=="定价")) | .nodeRef' | head -1)
if [ -n "$REF2" ] && [ "$REF2" != "null" ]; then
  qqb click "$REF2" --tab "$TAB_ID" >/dev/null || true
  sleep 0.18
  shot "second ripple"
  sleep 0.5
fi

echo "[demo] frame 5 · timeline filled (5 rows by now)"
sleep 0.4
shot "timeline 5 rows"

echo "[demo] frame 6 · error → red status"
qqb click "n_does_not_exist" --tab "$TAB_ID" >/dev/null 2>&1 || true
sleep 0.3
shot "error red flash"
sleep 0.4

echo "[demo] frame 7 · clean screenshot (overlay hidden)"
sleep 0.4
qqb pulse --tab "$TAB_ID" --stop true >/dev/null 2>&1 || true
sleep 0.6
qqb screenshot --tab "$TAB_ID" --clean --out "$FRAME_DIR/frame-$(printf "%02d" "$i").png" --quiet true >/dev/null
echo "  📸 $i  --clean (no overlay)"
i=$((i+1))

# ── Stitch ─────────────────────────────────────────────────────────────────

FRAMES=$(ls "$FRAME_DIR"/frame-*.png | wc -l | tr -d ' ')
echo "[demo] captured $FRAMES key frames"

# Build a concat list with each frame held for $HOLD seconds.
LIST="$FRAME_DIR/concat.txt"
> "$LIST"
for f in "$FRAME_DIR"/frame-*.png; do
  echo "file '$f'" >> "$LIST"
  echo "duration $HOLD" >> "$LIST"
done
# ffmpeg concat demuxer needs the last file repeated without duration.
LAST=$(ls "$FRAME_DIR"/frame-*.png | tail -1)
echo "file '$LAST'" >> "$LIST"

mkdir -p "$OUT_DIR"
echo "[demo] stitching → $OUT_MP4"

# Step 1: build a hold-only video.
HOLD_MP4="$FRAME_DIR/hold.mp4"
ffmpeg -y -f concat -safe 0 -i "$LIST" \
  -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p" \
  -r 30 -c:v libx264 -preset medium -crf 22 \
  -movflags +faststart \
  "$HOLD_MP4" >/dev/null 2>&1

# Step 2: add fade-in/out at the ends for polish.
TOTAL_DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$HOLD_MP4" | awk '{printf "%.2f", $1}')
FADE_OUT_START=$(awk "BEGIN { print $TOTAL_DUR - 0.5 }")
ffmpeg -y -i "$HOLD_MP4" \
  -vf "fade=t=in:st=0:d=0.4,fade=t=out:st=$FADE_OUT_START:d=0.5" \
  -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p \
  -movflags +faststart \
  "$OUT_MP4" >/dev/null 2>&1

if [ -f "$OUT_MP4" ]; then
  SIZE=$(du -h "$OUT_MP4" | awk '{print $1}')
  DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT_MP4" | head -c 6)
  echo ""
  echo "✓ wrote $OUT_MP4  ($SIZE, ${DUR}s, $FRAMES frames)"
else
  echo "✗ ffmpeg did not produce output" >&2
  exit 3
fi
