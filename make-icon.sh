#!/bin/bash
# Genera assets/icon.icns dall'SVG usando solo strumenti nativi macOS.
set -euo pipefail
cd "$(dirname "$0")"

SVG="assets/icon.svg"
TMP="$(mktemp -d)"
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"

# 1) SVG -> PNG 1024 master via QuickLook
qlmanage -t -s 1024 -o "$TMP" "$SVG" >/dev/null 2>&1
MASTER="$TMP/icon.svg.png"
[ -f "$MASTER" ] || { echo "Rasterizzazione fallita"; exit 1; }

# 2) Tutte le dimensioni richieste dall'iconset macOS
gen() { sips -z "$2" "$2" "$MASTER" --out "$ICONSET/$1" >/dev/null; }
gen icon_16x16.png        16
gen icon_16x16@2x.png     32
gen icon_32x32.png        32
gen icon_32x32@2x.png     64
gen icon_128x128.png      128
gen icon_128x128@2x.png   256
gen icon_256x256.png      256
gen icon_256x256@2x.png   512
gen icon_512x512.png      512
gen icon_512x512@2x.png   1024

# 3) iconset -> icns
iconutil -c icns "$ICONSET" -o "assets/icon.icns"
rm -rf "$TMP"
echo "Creato assets/icon.icns"
