#!/usr/bin/env bash
# Downloads the OFL-licensed IBM Plex static TTFs the app bundles (see FONT-LICENSES.md).
# Re-run to refresh them; the files are committed so builds never need the network.
set -euo pipefail
target="$(cd "$(dirname "$0")/.." && pwd)/app/src/main/res/font"
mkdir -p "$target"
base="https://raw.githubusercontent.com/IBM/plex/master/packages"
fetch() {
  curl -sSfLo "$target/$1" "$base/$2"
  head -c 4 "$target/$1" | grep -q $'\x00\x01\x00\x00' || { echo "not a TrueType file: $1" >&2; exit 1; }
}
fetch plex_sans_regular.ttf plex-sans/fonts/complete/ttf/IBMPlexSans-Regular.ttf
fetch plex_sans_medium.ttf plex-sans/fonts/complete/ttf/IBMPlexSans-Medium.ttf
fetch plex_sans_semibold.ttf plex-sans/fonts/complete/ttf/IBMPlexSans-SemiBold.ttf
fetch plex_sans_bold.ttf plex-sans/fonts/complete/ttf/IBMPlexSans-Bold.ttf
fetch plex_mono_regular.ttf plex-mono/fonts/complete/ttf/IBMPlexMono-Regular.ttf
fetch plex_mono_medium.ttf plex-mono/fonts/complete/ttf/IBMPlexMono-Medium.ttf
fetch plex_mono_semibold.ttf plex-mono/fonts/complete/ttf/IBMPlexMono-SemiBold.ttf
file "$target"/*.ttf
