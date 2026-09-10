# Handheld (TSD) printing foundation — design spec

**Date:** 2026-09-10

**Status:** Approved in brainstorming on 2026-09-10; implementation plan pending

**Scope:** Fourth implementation slice of design brief 10
(`docs/design-briefs/10-tsd-handheld.md`), after the foundation
(`2026-09-10-handheld-foundation-design.md`, #473), the shift validation slice
(`2026-09-10-handheld-shift-validation-design.md`, #479) and the inventory
check slice (`2026-09-10-handheld-inventory-check-design.md`, #485): the
handheld learns to print. It configures printers over Wi-Fi and Bluetooth,
renders a label to printer bytes on the device, sends them, and reports an
outcome the operator can act on. Nothing that produces a real label ships
here: box close, reprint of an existing box, unit labels, pallet labels and
the deferred-label queue all belong to the aggregation slice.

## Outcome

An operator opens «Настройки» → «Принтер», adds the printer standing at the
line by its address or pairs the one on their belt, picks the command language
and the resolution, and prints a test label. The label carries a Cyrillic
product line and an SSCC barcode, which is exactly the pair that can go wrong.
The operator looks at what came out of the printer and answers whether it is
clean. If the printer had no paper, the screen says so in the printer's own
words before anything was sent. If the connection broke while sending, the
screen says the result is unknown and refuses to resend on its own until the
operator has looked at the printer.

After this slice the hub's «принтер не настроен» line and the printer
indicator in the status strip tell the truth, and the aggregation slice can
close a box and call one function to get bytes on the wire.

## Decisions

| Decision              | Choice                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rendering             | Port the domain package's ZPL and TSPL emitters to Kotlin. Barcodes and printable-ASCII text stay native printer commands; text outside ASCII is rasterized with Android's graphics stack and emitted as an image field, exactly as the station does. |
| Verification          | Fixtures exported from `packages/domain`, the third such set after the code parser and the inventory classifier. ASCII output is byte-identical. Non-ASCII output is pinned structurally, never on glyph pixels.                                      |
| Transports            | Wi-Fi (TCP 9100) and Bluetooth (SPP) together, behind one interface.                                                                                                                                                                                  |
| Status before sending | The transport asks the printer for its status first, so a refusal can carry the printer's own reason rather than a generic timeout.                                                                                                                   |
| Where printers live   | On the device only. The station's `hardware-config.ts` states the rule: held on the station, not the server, so the device configures and runs offline.                                                                                               |
| Template source       | A test-label spec compiled into the app. The `label-templates` module is cabinet-only by explicit design and a station credential cannot read it.                                                                                                     |
| Server changes        | None.                                                                                                                                                                                                                                                 |

## Why no server work

Two existing decisions remove the API from this slice entirely.

Printer configuration is device-local. `apps/station/src/lib/hardware-config.ts`
documents it as deliberate: the workstation configures and runs offline, and
the hardware contract stays stateless. The handheld follows the same rule, so
printers live in Room and nothing is reported.

Label templates are cabinet-only. `LabelTemplatesController` carries
`@ApiCabinetAuth()` and a comment stating that the station never calls the
module; the station receives its box template inside the shift bundle instead.
A handheld with no shift and no inventory therefore has no template, which is
why the test label carries its own spec rather than fetching one.

## Rendering (`core/label`)

### What is ported

| Source (`packages/domain/src/labels/`) | Code lines | Kotlin home              |
| -------------------------------------- | ---------- | ------------------------ |
| `zpl.ts`                               | 200        | `ZplEmitter.kt`          |
| `tspl.ts`                              | 214        | `TsplEmitter.kt`         |
| `bounds.ts`                            | 92         | `LabelBounds.kt`         |
| `wrap.ts`                              | 86         | `TextWrap.kt`            |
| `raster.ts`, `raster-types.ts`         | 98         | `Monochrome.kt`          |
| `code128.ts`, `text.ts`                | 19         | folded into the emitters |

`withPrinterDpi` comes along with the geometry: a template spec is
printer-neutral millimetre geometry, and the configured resolution decides the
dot conversion. The template's own language and resolution are overridden by
the printer's, which is what lets one template serve mixed printers.

### Element kinds

The spec model has five: `text`, `field`, `barcode`, `line`, `box`. Barcode
formats are `code128`, `ean13`, `datamatrix`, `qr`. This slice implements
`code128` and refuses the other three by name, because the stock box templates
use `code128` only and unit labels with their DataMatrix are out of scope. A
custom template carrying a matrix code fails with a named error rather than
printing something wrong.

### Rasterized text

`RasterizeTextFn` is called only when a text run contains characters outside
printable ASCII. On this market that means every Cyrillic product name, so the
path is not an edge case.

The Kotlin implementation mirrors the shape of
`apps/station/src/lib/rasterizer.ts`: draw the run, read the pixels back, then
hand off to the ported monochrome conversion and packing. Only the drawing
surface differs, `android.graphics` instead of a browser canvas.

**This output cannot be byte-identical to the station's, and that is
expected.** The station's rasterizer and the cabinet editor's preview are
deliberately pixel-identical to each other, so that preview equals print. An
Android rasterizer is a third implementation with a different font engine.
The same text at the same size lands in the same place at the same dimensions;
the glyph pixels differ. A future difference in glyph pixels is therefore not
a regression, and the fixtures must not claim otherwise.

### Fixtures

`packages/domain` gains `buildLabelFixtures()` and a `fixtures:labels` script
next to the existing `fixtures:km` and `fixtures:inventory`, writing
`apps/handheld/app/src/test/resources/label-fixtures.json`. A domain test fails
when the fixtures drift from the emitters, so the two sides cannot diverge
silently.

Two groups of cases:

- **Byte-identical.** Specs whose every text run is printable ASCII, across
  both languages, both resolutions, all implemented element kinds, and the
  wrapping and alignment paths. The Kotlin output must equal the fixture
  string exactly.
- **Structural.** Specs with Cyrillic runs. The fixture records the emitted
  command sequence with the image payload replaced by its dimensions and
  placement. The Kotlin output must match that reduced form.

## Printers (Room v4, `MIGRATION_3_4`)

One table, `printers`:

| Column                     | Meaning                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `id`                       | Local identifier.                                                                |
| `name`                     | What the operator sees, from Bluetooth discovery or typed for a network printer. |
| `transport`                | `wifi` or `bluetooth`.                                                           |
| `address`                  | `host:port` for Wi-Fi, device address for Bluetooth.                             |
| `language`                 | `zpl` or `tspl`.                                                                 |
| `dpi`                      | `203` or `300`.                                                                  |
| `selected`                 | Exactly one row is true.                                                         |
| `lastSeenAt`, `lastStatus` | What the printer last reported, for the list subtitle.                           |

Language and resolution are per printer, as drawn: a plant can run a belt
printer and a line printer side by side.

## Transports (`core/print`)

One interface with two operations.

```
suspend fun status(printer: Printer): PrinterStatus
suspend fun send(printer: Printer, bytes: ByteArray): SendOutcome
```

`status` is asked before every send and answers one of three things: the
printer is ready, the printer cannot print right now and says why, or nothing
answered within the timeout. Both command languages support a host status
query, so a refusal can name paper out or an open head instead of a generic
failure. This is what the brief means by a confirmed reason the printer
reported before printing, and it is the only way the drawn «Нет бумаги» state
can exist.

`SendOutcome` has three cases, and the difference between the last two carries
the whole recovery design.

- **`Delivered`.** Every byte written, connection closed cleanly.
- **`Refused(reason)`.** Nothing was printed and we know it: connect failed, no
  route, device not paired, or the printer reported it could not print.
- **`Unknown(reason)`.** Bytes may or may not have reached the printer. The
  write broke partway, or the close timed out.

**An unknown outcome never resends by itself.** The rule exists so that a
retry cannot silently produce a second label for a box the server has already
accepted. Only a person who has looked at the printer resolves it.

Wi-Fi uses a plain socket to the configured host and port with the drawn
five-second timeout. Bluetooth uses an SPP connection to the paired device.
Neither language acknowledges a print job, so `Delivered` means the bytes left
the device, not that paper moved. That is precisely why the pre-flight status
query and the operator's confirmation both exist.

## Screens

All five are drawn in `docs/design-briefs/markiro-tsd.pen`.

- **`07-settings/printer`** — «ВЫБРАН» with the current printer and its last
  reported state, «ДОСТУПНЫЕ» with the others, a row carrying language and
  resolution, «Тестовая печать», and «Добавить по адресу».
- **`07-settings/printer-add`** — «По сети (Wi-Fi)» or «Bluetooth», address and
  port, language and resolution as segmented controls, «Проверить связь».
- **`07-settings/printer-bluetooth-pair`** — discovery list with «Сопрячь» for
  a new device and «Выбрать» for one paired earlier, «Искать снова».
- **`07-settings/printer-test`** — what was sent and to which printer, a
  preview of the label, and «Этикетка напечаталась чётко, кириллица и штрих-код
  читаются?» with «Да, всё чётко» and «Нет, повторить».
- **`07-settings/printer-error`** — «Принтер не отвечает» naming the address and
  the timeout, «Проверить снова» and «Изменить адрес».

On an unknown outcome the test-print screen keeps the wording drawn for the
box-close case: the result is unknown, look at the printer, then confirm or
print again. It never resends on its own.

The test-print preview is drawn by the same geometry pass that places elements
for rasterization, so preview and print agree on the handheld without a second
layout implementation.

Both language files gain the new strings; a missing translation is a lint
error, as before.

## Permissions

Bluetooth discovery and connection need runtime permissions on current
Android. A refusal produces a plain state naming what is missing, not an empty
list. Wi-Fi printing needs no permission.

## Testing

- **Renderer.** Fixture tests over both groups above, driven by
  `label-fixtures.json`.
- **Wi-Fi transport.** Against a real socket in the unit test: connect timeout,
  clean send, and a break partway through the write producing `Unknown`.
- **Bluetooth transport.** Behind the interface with a fake. An emulator has no
  Bluetooth, so this is reported as untested on hardware rather than implied.
- **Printer store and view models.** Room tests for selection and migration,
  Robolectric for the screens in both languages.

## Manual verification (emulator)

A socket on the host stands in for a network printer and dumps what it
receives. Add it as a Wi-Fi printer, print a test label, and compare the
captured bytes against what the TypeScript emitter produces for the same spec
at the same language and resolution. That turns the port claim into evidence.
Then exercise the failure paths: a closed port for `Refused`, a socket that
accepts and then drops mid-write for `Unknown`, and a wrong address for the
timeout state.

## Out of scope

- Box close, pallet labels, reprint of an existing box, unit and product
  labels.
- The deferred-label queue and «Отложить этикетку». Both are drawn around a
  closed box, and persistence earns its place only once a real label can be
  deferred.
- Matrix barcodes in custom templates.
- The Bluetooth scanner, which belongs to the scanner row of settings.
- Any server change.

## Risks and open points

- **Glyph parity.** Covered above: Android is a third rasterizer and its
  Cyrillic pixels differ from the station's by construction. Stated here so it
  is not later mistaken for a defect.
- **Status query coverage.** The reason vocabulary is limited to what each
  command language reports. A printer that answers neither query falls back to
  «не отвечает».
- **Bluetooth on hardware.** Verifiable only on a real device. The pull request
  must say so plainly rather than implying emulator coverage.
