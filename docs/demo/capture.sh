#!/bin/sh
# Renders the demo page with headless Chrome into docs/screenshots. Needs the repo root served on port 4718:
#   python3 -m http.server 4718 --bind 127.0.0.1
set -e
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
out="$(cd "$(dirname "$0")/.." && pwd)/screenshots"
# Full window shots at 1440x900, and tighter "web-" shots at 1280x820 that stay readable when shown small on the website.
for theme in light dark; do
  for shot in guide "tour&stop=1" diff settings overview; do
    for size in 1440,900 1280,820; do
      [ "$size" = 1440,900 ] && prefix="" || prefix="web-"
      name="$prefix${shot%%&*}-$theme.png"
      "$chrome" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$(mktemp -d)" --window-size=$size --force-device-scale-factor=2 --virtual-time-budget=6000 --screenshot="$out/$name" "http://127.0.0.1:4718/docs/demo/#shot=$shot&theme=$theme" >/dev/null 2>&1
      echo "$name"
    done
  done
done
rm -f "$out"/web-settings-*.png
# The tour's definition popover, for the website.
for theme in light dark; do
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$(mktemp -d)" --window-size=1280,820 --force-device-scale-factor=2 --virtual-time-budget=8000 --screenshot="$out/web-popover-$theme.png" "http://127.0.0.1:4718/docs/demo/#shot=tour&stop=3&sym=applyGiftCard&theme=$theme" >/dev/null 2>&1
  echo "web-popover-$theme.png"
done
# The sidebar alone, with both sources: the top left of the overview shot. An offset of 0 would crop from the centre.
for theme in light dark; do
  sips -c 1180 580 --cropOffset 1 1 "$out/web-overview-$theme.png" --out "$out/web-sources-$theme.png" >/dev/null
  echo "web-sources-$theme.png"
done
"$chrome" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$(mktemp -d)" --window-size=1600,1000 --force-device-scale-factor=2 --virtual-time-budget=3000 --screenshot="$out/hero.png" "http://127.0.0.1:4718/docs/demo/hero.html" >/dev/null 2>&1
echo hero.png
