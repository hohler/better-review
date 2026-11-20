#!/bin/sh
# Renders the demo page with headless Chrome into docs/screenshots. Needs the repo root served on port 4718:
#   python3 -m http.server 4718 --bind 127.0.0.1
set -e
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
out="$(cd "$(dirname "$0")/.." && pwd)/screenshots"
for theme in light dark; do
  for shot in guide "tour&stop=1" diff settings; do
    name="${shot%%&*}-$theme.png"
    "$chrome" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$(mktemp -d)" --window-size=1440,900 --force-device-scale-factor=2 --virtual-time-budget=6000 --screenshot="$out/$name" "http://127.0.0.1:4718/docs/demo/#shot=$shot&theme=$theme" >/dev/null 2>&1
    echo "$name"
  done
done
"$chrome" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$(mktemp -d)" --window-size=1600,1000 --force-device-scale-factor=2 --virtual-time-budget=3000 --screenshot="$out/hero.png" "http://127.0.0.1:4718/docs/demo/hero.html" >/dev/null 2>&1
echo hero.png
