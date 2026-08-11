# Label Editor Redesign and Code Import

## Status

The interaction direction and feature scope were approved on 2026-08-11. This written
specification is ready for final review before implementation planning.

## Context

The current Admin label editor exposes the complete label model and printer export path, but its
desktop shell is not usable at ordinary working widths. The element palette renders icon-only
buttons, the fixed side columns and minimum control widths create page-level horizontal overflow,
and the properties panel clips its second column. The canvas permits drag, keyboard movement, and
direct coordinate edits that place an element partly or wholly outside the physical label.

Operators also receive label definitions as ZPL or TSC TSPL source. Today they must reconstruct
those labels manually. The editor needs a safe code-import path that turns the supported printer
commands into ordinary editable `LabelTemplateSpec` elements, exposes Markiro's available template
fields while the code is written, and never hides commands that could not be converted.

The implementation must preserve the existing React/Vite Admin stack, `@markiro/ui` controls,
shared label model, client-side preview/export behavior, RU/EN localization, and light/dark themes.
It is a targeted redesign, not a replacement editor or a general-purpose printer-language runtime.

## Goals

1. Make every palette action understandable without relying on a tooltip.
2. Keep the editor shell within its available viewport width and give each panel independent
   vertical scrolling where needed.
3. Provide a compact 320 px properties panel that can be collapsed without clearing selection.
4. Keep the full rendered bounds of every editable element inside the physical label for every
   editor-originated position change.
5. Import a deliberate ZPL and TSPL subset into editable label elements.
6. Replace the current composition atomically only after a successful import review and explicit
   confirmation.
7. Show copyable template-field placeholders beside the code editor.
8. Report unsupported or lossy commands with source-line references before replacement.
9. Keep preview and download driven by the same resulting `LabelTemplateSpec` as today.

## Non-goals

- No complete ZPL or TSPL interpreter, printer emulator, or arbitrary firmware compatibility.
- No server-side parsing, rendering, persistence format, API, database, or migration changes.
- No preservation of unsupported source as hidden commands in a template.
- No import by uploading files in the first delivery; source is pasted as text.
- No OCR, bitmap-to-vector conversion, or editable import of ZPL `^GFA` or TSPL `BITMAP`.
- No rotation, downloaded fonts, RFID, media calibration, cutting, printer configuration, or
  multi-label batch semantics.
- No mixed literal-and-field expression such as `Товар: {{product.name}}`; the current domain model
  represents either literal text or one field binding.
- No freeform scripting, arithmetic, conditionals, or new template-field types.
- No change to the fact that imported raster commands cannot be reconstructed as semantic fields.

## Chosen direction

### Editor shell

Use a bounded three-region CSS Grid: a labelled tool rail, a flexible canvas workspace, and a
collapsible properties panel. The alternatives were an always-overlaying properties drawer and a
properties section below the canvas. The bounded grid was selected because properties remain
available during repeated edits while the collapse control can return width to the workspace.

### Import strategy

Use strict, observable subset parsing. Supported commands become domain elements; ignored document
framing commands and unsupported element commands are reported separately. The alternatives were
storing raw unknown commands invisibly and flattening unknown content into a background image.
Both were rejected because either would make generated output diverge from the visible model or
would imply editability that does not exist.

## Editor layout

The editor root must consume its containing route height and width with `min-width: 0` at every
flex/grid boundary. The page itself must not gain horizontal scrolling.

The top toolbar keeps Back, template name, size, DPI, language, Download, and Save. Add an
`Import code` secondary action next to Download. Toolbar controls may wrap into a second row at
narrow widths without clipping actions or changing document order.

Below the toolbar, use these regions:

1. A labelled palette wide enough for an icon plus visible RU/EN text. Each button contains both;
   the accessible name and tooltip remain available but are no longer the only description.
2. A flexible workspace with `minmax(0, 1fr)`, its own two-axis overflow when the physical canvas
   is larger than the available workspace, and a stable centered canvas. The print preview remains
   below the editing canvas with a distinct caption and spacing.
3. A 320 px properties panel with its own vertical scrolling and no horizontal scrolling. Its
   collapse button remains reachable in the panel header. Collapsing removes the panel column but
   does not clear `selectedId`, mutate the spec, or dirty the template.

Property controls default to a single column. A short coordinate pair may use two columns only
when both controls can honor `min-width: 0`; otherwise it wraps. Labels use sentence case and no
content may extend beyond the panel's padding box. The destructive action follows the editable
fields and remains reachable through panel scrolling.

## Element bounds contract

Bounds enforcement is an editor-time concern and does not tighten the shared persisted schema.
Existing templates created by older clients remain parseable, while every mutation made through
the redesigned editor produces an in-bounds composition.

Create one pure geometry boundary that receives a `LabelElement`, the current spec size, and the
same sample data used for editor rendering. It returns either an in-bounds element or a structured
failure when the element cannot fit. Bounds must use the renderer's established
`elementBoundsMm` semantics so hit testing, the selection outline, and containment agree.

Apply that boundary to:

- pointer drag;
- keyboard arrows, including Shift nudges;
- direct X/Y property changes;
- kind-specific geometry changes that affect bounds, including text size/width, barcode size, line
  endpoint/thickness, and box size/thickness;
- new elements;
- label-size changes;
- imported elements before import confirmation.

For ordinary movement, clamp to the nearest valid position. A line translates both endpoints and
then clamps the complete stroked bounds. A box keeps its complete stroked rectangle inside. Text
and barcode elements use their rendered heuristic bounds rather than only their anchor.

When reducing label size, reflow every element by clamping it into the new dimensions in one
atomic spec replacement. If any element is physically larger than the target label, reject that
size change, retain the previous spec, and show a persistent inline error. Do not silently resize
content.

Direct property entry follows the same rule: valid values are accepted and clamped where position
alone changes; a geometry value that makes an element impossible to fit is rejected with an inline
properties error. The user must never see a saved value that differs from the rendered result
without an explanation.

## Import entry and review flow

`Import code` opens a purpose-built wide dialog because importing is an atomic, multi-step
replacement operation rather than routine per-element editing. Opening the dialog never mutates
the current spec.

The dialog contains:

- ZPL and TSPL format selection, initially matching the current label language;
- 203 and 300 DPI selection, initially matching the current spec;
- a labelled multiline code editor using the existing monospace typeface;
- a template-fields reference panel with field name, translated meaning, placeholder, and a Copy
  action;
- `Check code`, Cancel, and the final `Replace label` action;
- an analysis summary below the code editor.

`Check code` parses the complete current input and produces one of three states:

1. Blocking error: no replacement is possible. Show the source line and a direct recovery message.
2. Parsed with unsupported commands: show label size, recognized element counts, adjustments, and
   every unsupported source line. Replacement remains available only through an explicit
   acknowledgement that those lines will be discarded.
3. Parsed without unsupported commands: show the same summary and enable replacement directly.

Any edit to code, format, or DPI invalidates the previous analysis and disables replacement until
the code is checked again. This prevents confirmation of stale parse results.

Replacement dispatches one `replaceSpec` operation, changes the label language to the imported
format, marks the editor dirty once, selects no element, closes the dialog, and preserves the
template name. Cancel, dialog close, and parse failure leave the entire editor state unchanged.
If the current editor is already dirty, the replacement summary states that the existing unsaved
composition will be replaced; the final explicit action is the confirmation and no nested dialog
is added.

## Template fields

The shared field inventory remains:

```text
{{product.name}}
{{product.gtin}}
{{km.code}}
{{sscc}}
{{shift.no}}
{{date}}
{{qty}}
{{operator}}
{{counterparty.name}}
```

Expose the inventory from one shared domain source instead of duplicating it in the importer and
properties panel. Copy writes the exact placeholder and gives translated, non-exclamatory success
feedback. Clipboard failure remains visible and also leaves the placeholder selectable for manual
copying.

A decoded command payload becomes a `field` element or field-backed barcode only when its entire
decoded value is exactly one known placeholder. An unknown placeholder is a blocking error with
its source line. A known placeholder embedded in other text is unsupported rather than silently
converted to a literal. Payloads without placeholder syntax become literal text or literal barcode
data.

Template placeholders are authoring syntax only. Existing `generateZpl` and `generateTspl`
continue resolving domain bindings against supplied data and do not emit placeholder source.

## Parser architecture

Put framework-independent import parsers and their tests in `@markiro/domain` alongside the
existing emitters. Export a narrow API such as:

```ts
type LabelCodeLanguage = "zpl" | "tspl";

interface LabelImportWarning {
  line: number;
  source: string;
  code: "UNSUPPORTED_COMMAND";
  message: string;
}

interface LabelImportResult {
  spec: LabelTemplateSpec;
  warnings: LabelImportWarning[];
  sourceLineByElementId: Record<string, number>;
}

parseLabelCode(input: string, options: { language: LabelCodeLanguage; dpi: 203 | 300 }):
  LabelImportResult;
```

These are the public names and result fields. Recognized framing and document-control commands do
not create warnings. The Admin analysis step uses `sourceLineByElementId` to add its own translated
position-adjustment notices after applying editor bounds.

The parser stays deterministic, DOM-free, and does not execute or fetch anything. It rejects input
over 256 KiB, more than 2,000 parsed commands, or more than 1,000 resulting elements with a stable
limit error. Use explicit parsing for the supported grammar rather than a permissive chain of
replacements.

Importer errors must distinguish an unreadable document, missing/invalid size, invalid numeric
parameters, unknown placeholder, and element geometry that cannot fit. Error messages are mapped
to RU/EN at the Admin boundary; domain results expose stable codes and source locations.

Element IDs are deterministic from the language and one-based parsed element order, unique within
the replacement spec. Parsing order is preserved as element draw order.

## Supported ZPL subset

Support the structural subset used by editable Markiro labels:

- `^XA` and `^XZ` as document framing;
- `^PW` and `^LL` for physical size, interpreted using the selected DPI;
- `^FO` for the following field origin;
- `^A0N` plus optional `^FB`, `^FD`, `^FS` for native text or field elements;
- `^BCN`, `^BEN`, `^BXN`, and `^BQN` with `^FD`/`^FS` for Code 128, EAN-13,
  DataMatrix, and QR;
- `^GB` for a box or axis-aligned line. A command whose one dimension is no greater than its
  stroke thickness imports as a line; otherwise it imports as a box;
- the established `^FH` escaping used by Markiro text and barcode output.

Require `^PW` and `^LL` for deterministic physical size. Unsupported orientations, rotations,
multiple print documents, `^GFA`, downloaded fonts, and commands that change interpretation are
reported and discarded only after acknowledgement. A command that would make a supported element
ambiguous is unsupported rather than guessed.

## Supported TSPL subset

Support the structural subset used by editable Markiro labels:

- `SIZE` for physical size;
- `GAP`, `DIRECTION`, `REFERENCE`, `CLS`, and `PRINT` as recognized document controls that do not
  create elements;
- `TEXT` using font `"0"`, zero rotation, supported size and optional alignment;
- `BARCODE` types `"128"` and `"EAN13"` with zero rotation;
- `DMATRIX` and `QRCODE` with the Markiro-supported parameter shapes and zero rotation;
- `BAR` for an axis-aligned line;
- `BOX` for a rectangular frame.

Treat TSC as the printer family name and TSPL as the code-language label in the UI, with supporting
copy `TSPL (TSC)` where disambiguation helps. `BITMAP`, other fonts, rotations, reverse printing,
multiple copies, and unrecognized parameter variants are unsupported and require acknowledgement
before replacement.

## Size, coordinates, and normalization

ZPL coordinates are dots and convert through the explicitly selected DPI. TSPL `SIZE` millimetres
remain physical millimetres while element coordinates convert from dots through the selected DPI.
Use the shared `mmToDots` inverse convention with deterministic rounding and test the tolerated
round-trip error.

Reject labels outside the domain model's 10-300 mm limits. Normalize imported element values only
where the current model requires it. Report every positional clamp as an adjustment with its source
line; do not report ordinary sub-millimetre dot-to-mm conversion as a warning.

If any imported element is physically larger than the parsed label, analysis is blocking and
replacement is unavailable. Elements that merely start outside the label are clamped through the
shared Admin geometry boundary and listed as adjusted.

## Accessibility and interaction states

- Palette buttons and collapse/import actions have visible labels or adjacent descriptive text,
  semantic button roles, keyboard operation, and visible focus.
- The properties panel header identifies the selected element and the collapse state.
- The import dialog has a labelled title, code input, format/DPI controls, results region, and
  deterministic initial and restored focus.
- Analysis errors use an assertive live region; successful summaries and copy feedback use polite
  status semantics.
- Unsupported rows are textually identified and never communicated by color alone.
- Long source lines wrap or scroll inside their own bounded code region without widening the page
  or dialog.
- All new copy is translated in RU and EN.

## Testing strategy

Follow test-first delivery.

### Domain tests

- one focused vector for every supported ZPL and TSPL command shape;
- literal text and every known field placeholder path;
- field-backed and literal barcode payloads;
- stable source lines for unknown placeholders, invalid numbers, missing size, unsupported commands,
  and ambiguous syntax;
- dot/mm conversion at 203 and 300 DPI;
- document/input limits and unique IDs;
- element order and no hidden preservation of unsupported commands;
- import of representative editable Markiro-generated native command output.

### Admin pure-state and component tests

- bounds clamping for text, field, every barcode format, line, and box;
- pointer, keyboard, property, geometry, new-element, label-resize, and import entry points all use
  the same boundary behavior;
- impossible size/geometry retains the previous spec and shows an error;
- palette exposes visible translated labels;
- properties panel collapse preserves selection and does not dirty the editor;
- controls remain contained in the panel and the editor shell exposes no page-level horizontal
  overflow contract;
- import analysis invalidates after any input option changes;
- unsupported acknowledgement gates replacement;
- replacement is atomic, clears selection, preserves name, and marks dirty;
- cancel and all failure paths leave editor state unchanged;
- template-field copy success and failure states.

Automated DOM tests establish structure and behavior, not visual fit. Final verification also
requires a real browser pass at representative desktop widths in both RU and EN and in light and
dark themes. Printer-language parser tests do not constitute physical Zebra or TSC printer
verification; no printer behavior changes are included in this scope.

## Delivery boundaries

Expected production areas are `packages/domain/src/labels`, its barrel exports and tests,
`apps/admin/src/pages/labels/editor`, Admin i18n files, and focused Admin tests. Reuse existing
dependencies and controls; do not add a parser package or code-editor dependency for this bounded
grammar and textarea-based first delivery.

Completion requires focused domain/Admin tests, package typecheck/lint/build gates for both changed
packages, final diff review, `git diff --check`, and the browser checks described above. Any browser
surface or physical printer check not exercised must be reported separately rather than inferred
from unit tests.
