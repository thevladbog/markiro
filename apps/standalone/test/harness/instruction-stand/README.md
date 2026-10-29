# Instruction stand

Real screens of Маркиро Автоном for the printed instructions, shot without Windows or
hardware. The stand runs the real `markiro-host` on macOS and the real webview under
vite. Chromium drives the webview. A Node copy of the Tauri shell answers the
webview's `invoke` calls:

- `host_request` and pairing go to the host over HTTPS. The certificate is pinned the
  way `src-tauri` pins it.
- The station's local database is `node:sqlite` over `src-tauri/migrations`.
- Printers, scanners, files and updates get canned answers shaped like the Rust
  structs. Printing always succeeds, and the bytes are kept in `shell.printed`.

Scanner input works as a keyboard wedge (`scan()` in `states.mjs`), so a scan travels the
same path as a HID scanner's. The stand is a development aid only and stays out of CI.

## Running

macOS, Node 24, `clang`, ImageMagick (for `compare.mjs`) and a built host:

```bash
cargo build -p markiro-host --manifest-path apps/standalone/Cargo.toml
pnpm turbo run build --filter='@markiro/standalone^...'
pnpm --dir tools/production-browser --ignore-workspace install   # playwright-core
```

The host and vite listen on local ports (45710 and 5274), so run the stand outside a
sandbox that forbids binding. The entry point is `stand.mjs`:

```bash
cd apps/standalone/test/harness/instruction-stand
node stand.mjs seed            # once: build the site, keep it as a snapshot
node stand.mjs list            # the states
node stand.mjs capture         # every state → $TMPDIR/markiro-instruction-stand/frames
node stand.mjs capture station/work-box-in-progress --out /some/dir
node compare.mjs <runA> <runB> --fuzz 2%
```

`--verbose` prints every failed shell command and console message. When a state fails,
the screen it reached is saved beside the frames as `<state>.failed-N.png`.
`PLAYWRIGHT_CORE` overrides where `playwright-core` is loaded from. The default is
`tools/production-browser`'s install.

## What the seed builds

The seed works through the product the way a site would. `site.mjs` holds every value
it types.

1. Host «Первый запуск» runs in the webview without demo data:
   - administrator `admin` / `stand-admin-1`;
   - ООО «Родник», with a valid INN and GLN;
   - lines «Линия розлива 1» and «Линия розлива 2».
2. The office's records go through the host API, as the office makes them. PINs and
   badges are hashed by the webview's own `src/lib/credentials.ts`.
   - Three water products. The first one has the host's bottle photo.
   - Three operators, two of them with badges.
   - Shifts OCT26-001 (line 1, today, with pallets), OCT26-002 (line 2, today) and
     OCT26-003 (line 1, tomorrow).
3. «Станция линии 1» pairs by a one-time code from the office and takes line 1.
   - Operator 1001 signs in with a badge.
   - A network Zebra is added in «Рабочее место» for boxes and pallets.
   - The operator opens OCT26-001 and scans 29 codes: two boxes of 12 close and print,
     and 5 codes stay in the third box.

The snapshot is the host's data directory and the shell's device records plus local
databases (`devices/<computer>.json|.db`). Every captured state starts from a fresh copy
of it, so states never see each other's actions.

## Time

The stand fixes the time on both sides:

- **Host.** `stand-clock.c` is built once into the stand's cache. It is loaded with
  `DYLD_INSERT_LIBRARIES` and moves the host's wall clock, so the host lives on the
  stand's day.
- **Seed.** It starts at 10:40 Moscow on 29.10.2026, and the browser clock flows from
  that instant, so scans keep their seconds.
- **Capture.** Frames are shot on the first whole minute at least one minute after the
  seed ended (`seeded.json` → `captureAt`). The browser's `Date` is fixed there and the
  host starts there, so the office sees the station as just heard from.

The trial license counts from the seed's first start, so its banner reads the same on
any day.

## Determinism

The `shoot()` routine waits for fonts, turns off transitions, animations and the caret,
and waits until two screenshots in a row agree. Two runs over the same snapshot give
pixel-identical frames. The exception is the station's work screen, which can differ
by antialiasing on rounded corners (at most 4/255 per channel). `compare.mjs --fuzz 2%`
treats that as equal.

A new seed changes ids, SSCC counters, the certificate fingerprint and the seed's
seconds, so reshoot every frame from one snapshot.

## Adding a state

Add an entry to `STATES` in `states.mjs`:

```js
"office/products": {
  title: "Офис: товары",
  async run({ computer, shoot }) {
    const office = await computer("host", "host");   // or ("station-1", "station")
    await openOffice(office);
    await officeSection(office.page, "Товары");
    await shoot(office.page);
  },
},
```

`computer(name, role)` opens a computer of the site whose shell keeps its pairing in the
snapshot. Use the following:

- `"host"` (role `host`) is the host PC, which opens on «Вход в офис».
- `"station-1"` (role `station`) is the line 1 station, which opens on «Вход оператора».
- `empty: true` runs the state against a host that was never set up, for the wizard.

A state that needs more data, such as a closed shift, a second station or a handheld,
gets it in the seed (`seed.mjs`, `seedStationWork`). After that, run `seed` again.

## Known gaps

- **Windows-only chrome.**
  - The installer and the Windows service are not part of the stand.
  - The kiosk/full-screen window policy always answers «not permitted».
  - Native file dialogs, the exports folder and opening files are canned.
- **Hardware.**
  - There are no USB or COM devices: the scanner and printer lists are empty.
  - A printer «Пробная печать» always succeeds, and printing never fails.
  - A failed printer or a lost scanner needs a canned failure added to `shell.mjs`.
- **Network and host.**
  - The host's own network answers (`/v1/office/host-network`, MAC and addresses) are
    this Mac's.
  - The host address the screens show is the fixed `https://192.168.10.5:45710`.
- **Not seeded yet.**
  - Handheld (ТСД) pairing and screens.
  - Yandex Disk backups.
  - Updates offered by the host.
  - The cloud import.
- **Focus ring.** After a badge scan, the station's heading shows the focus ring. The
  product does the same with a real keyboard-wedge scanner.
