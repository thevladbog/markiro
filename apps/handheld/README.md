# Markiro Handheld (ТСД)

Native Android app for industrial handheld terminals. Design: `docs/design-briefs/10-tsd-handheld.md`;
this slice: `docs/superpowers/specs/2026-09-10-handheld-foundation-design.md`.

## Build and test

    ./gradlew testDebugUnitTest lintDebug assembleDebug
    adb install -r app/build/outputs/apk/debug/app-debug.apk

Requires JDK 17 and the Android SDK (platform 35); point `local.properties` at it
(`sdk.dir=…`, the file is gitignored). Fonts are bundled (see FONT-LICENSES.md;
`tools/fetch-fonts.sh` re-downloads them).

## Debug aids (debug build only)

- The pairing screen has an editable server address; point it at the local API
  (`http://10.0.2.2:3000` from the emulator).
- Any flow accepts a broadcast scan:

      adb shell am broadcast -a app.markiro.handheld.DEBUG_SCAN --es data "48124812"

  Settings → Сканер also has a text field that submits a scan.

## Scanner sources

Built-in vendor intent (Datalogic Intent Wedge, Honeywell Data Intent, Zebra DataWedge; the
device-side setup hint is shown in Settings → Сканер), keyboard wedge as the fallback. Vendor
intent names are taken from documentation and are not yet verified on hardware.
