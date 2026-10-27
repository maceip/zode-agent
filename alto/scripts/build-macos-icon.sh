#!/bin/bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
source_png="$project_root/assets/alto-icon.png"
iconset="$(mktemp -d)/Alto.iconset"

cleanup() {
  rm -rf "$(dirname "$iconset")"
}
trap cleanup EXIT

mkdir -p "$iconset"

for spec in \
  "16 icon_16x16.png" \
  "32 icon_16x16@2x.png" \
  "32 icon_32x32.png" \
  "64 icon_32x32@2x.png" \
  "128 icon_128x128.png" \
  "256 icon_128x128@2x.png" \
  "256 icon_256x256.png" \
  "512 icon_256x256@2x.png" \
  "512 icon_512x512.png" \
  "1024 icon_512x512@2x.png"
do
  size="${spec%% *}"
  name="${spec#* }"
  /usr/bin/sips -z "$size" "$size" "$source_png" --out "$iconset/$name" >/dev/null
done

/usr/bin/iconutil -c icns "$iconset" -o "$project_root/assets/Alto.icns"
echo "Built $project_root/assets/Alto.icns"
