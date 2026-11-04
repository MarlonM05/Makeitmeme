#!/usr/bin/env sh
# Lädt alle in src/giffig.html gelisteten GIPHY-GIFs (200px-WebP) nach g/.
set -e
cd "$(dirname "$0")"
mkdir -p g
grep -o '\["[A-Za-z0-9]*","' src/giffig.html | cut -d'"' -f2 | while read -r id; do
  [ -f "g/$id.webp" ] || curl -sSf -o "g/$id.webp" "https://i.giphy.com/media/$id/200.webp"
done
echo "$(ls g | wc -l) GIFs in g/"
