#!/usr/bin/env bash
# Build qqb-demo.mp4 from curated frames in /tmp/qqb-demo-curated/.
# Each frame holds for HOLD seconds with a brief crossfade between them.
set -euo pipefail

FRAME_DIR=/tmp/qqb-demo-curated
OUT=$HOME/Downloads/qqb-demo.mp4
HOLD=2.2          # how long each scene is shown
XFADE=0.5         # crossfade duration

# Normalize all frames to the same dimensions (use first frame's size).
FIRST=$(ls "$FRAME_DIR"/*.png | head -1)
DIMS=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$FIRST")
W=$(echo "$DIMS" | cut -dx -f1)
H=$(echo "$DIMS" | cut -dx -f2)
W=$(( (W / 2) * 2 ))
H=$(( (H / 2) * 2 ))
echo "[build] target dims: ${W}x${H}"

# Resize all frames to a consistent size, save as resized-NN.png
WORK=/tmp/qqb-demo-work
rm -rf "$WORK"; mkdir -p "$WORK"
i=0
for f in "$FRAME_DIR"/*.png; do
  OUT_F="$WORK/r-$(printf "%02d" "$i").png"
  ffmpeg -y -i "$f" -vf "scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black" "$OUT_F" 2>/dev/null
  i=$((i+1))
done
echo "[build] resized $i frames"

# Build per-scene clips (each is a freeze of the frame for HOLD sec at 30fps).
for f in "$WORK"/r-*.png; do
  CLIP="${f%.png}.mp4"
  ffmpeg -y -loop 1 -i "$f" -t "$HOLD" -r 30 \
    -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p \
    -vf "format=yuv420p" \
    "$CLIP" 2>/dev/null
done

# Chain them together with xfade crossfades.
N=$(ls "$WORK"/r-*.mp4 | wc -l | tr -d ' ')
echo "[build] $N clips → chaining with xfade ${XFADE}s"

# Build the ffmpeg command incrementally.
INPUTS=()
i=0
for f in "$WORK"/r-*.mp4; do
  INPUTS+=(-i "$f")
  i=$((i+1))
done

# We need to compute offsets. Each clip is HOLD long; xfade overlap is XFADE.
# offset_n = sum(hold[0..n-1]) - n * XFADE  (each transition pulls the next clip back by XFADE)
FILTER=""
PREV="0:v"
ACC_OFFSET="$HOLD"
for k in $(seq 1 $((N - 1))); do
  OFFSET=$(awk "BEGIN { print $ACC_OFFSET - $XFADE }")
  if [ "$k" -eq 1 ]; then
    FILTER="[0:v][${k}:v]xfade=transition=fade:duration=${XFADE}:offset=${OFFSET}[v${k}]"
  else
    FILTER="${FILTER};[v$((k-1))][${k}:v]xfade=transition=fade:duration=${XFADE}:offset=${OFFSET}[v${k}]"
  fi
  ACC_OFFSET=$(awk "BEGIN { print $ACC_OFFSET + $HOLD - $XFADE }")
done

OUT_LABEL="v$((N - 1))"
echo "[build] running ffmpeg…"
ffmpeg -y "${INPUTS[@]}" \
  -filter_complex "$FILTER" \
  -map "[${OUT_LABEL}]" \
  -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p -movflags +faststart \
  "$OUT" 2>&1 | tail -5

if [ -f "$OUT" ]; then
  SIZE=$(du -h "$OUT" | awk '{print $1}')
  DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" | awk '{printf "%.1f", $1}')
  echo ""
  echo "✓ wrote $OUT  ($SIZE, ${DUR}s, $N scenes)"
else
  echo "✗ ffmpeg did not produce output" >&2
  exit 1
fi
