# Instruction quote lens

Printed instructions (the `MKR-INS-*` series in `packages/legal-documents`)
quote the cabinet's interface: button labels, field names, status words. When
the product renames or removes a field, an instruction can silently start
describing a screen that no longer exists — and because these documents are
signed PDFs, the error ships and cannot be quietly patched afterward.

This tool checks one thing: **every quoted string in a compiled document's
text exists verbatim (or as an honest template match) in the admin i18n
dictionary of the same locale.** It found real drift in two consecutive
MKR-INS-10 reissue cycles while it lived in `/tmp`; it is now a repository
tool so it survives between sessions and can gain a regression test.

It does not check layout, screenshots, or whether the UI _behaves_ as
described — only that the interface strings the document puts in quotes
still exist in the dictionary the UI actually renders from.

## How to run it

The lens reads the document from the **compiled** `legal-documents` output,
not from TypeScript source, so build that package first if you've changed a
document or pulled new source:

```bash
pnpm --filter @markiro/legal-documents build
```

Then, from the repository root:

```bash
node tools/instruction-lens/lens.mjs <root> <CODE> <ru|en> [dictDir]
```

- `<root>` — repository root (the directory containing `packages/` and
  `apps/`). Usually `"$PWD"` when run from the repo root.
- `<CODE>` — the release-key prefix of the document, e.g. `MKR-INS-10`
  (matched with `releaseKey.startsWith(CODE)`).
- `<ru|en>` — which locale's content and dictionary to check.
- `[dictDir]` — the i18n directory relative to `<root>`, default
  `apps/admin/src/i18n`.

Example, checking both locales of MKR-INS-10:

```bash
node tools/instruction-lens/lens.mjs "$PWD" MKR-INS-10 ru
node tools/instruction-lens/lens.mjs "$PWD" MKR-INS-10 en
```

Output ends with a one-line summary, `<CODE> <locale>: quotes=<N>
missing=<M>`, preceded by one `MISSING` line per unmatched quote showing its
frame (an image id, or `§<section-id>` when the quote is not attached to a
screenshot) and the offending text. `missing=0` means every quote in the
document was found in the dictionary — nothing more. It does not mean the
document is otherwise accurate.

## Exit codes

The process exit code is what makes this usable as a CI gate; the printed
lines alone are not enough because nothing enforces that a workflow reads
them.

| Exit | Meaning                                                                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Every extracted quote matched the dictionary (`missing=0`), or the document has no content for the requested locale — a legitimate state (e.g. no English revision yet), not a finding. |
| `1`  | One or more quotes were `MISSING`, **or** the extraction step itself found zero quotes.                                                                                                 |

The zero-quotes case is deliberately a failure, not a pass. Every real
instruction in this series quotes the interface at least once, so a run that
extracts nothing means the quote pattern or the document content is broken —
not that the document is clean. Concretely: a mistyped quote character in the
extractor once made it match nothing and print what looked like a spotless
`quotes=0 missing=0` line; the defect was only caught because a human happened
to run the tool against a real document and notice. This exit path exists so
the tool catches that itself instead of relying on a human to notice a
suspiciously small quote count. It is printed as its own message
(`extraction found nothing`) rather than as `quotes=0 missing=0`, and it is
distinct from the "no content for this locale" exit above: a document
genuinely missing an English revision is not the same failure as a broken
extractor, and only the latter should fail the run.

## Verdict classes

Every quote gets exactly one verdict, checked in this order:

| Verdict    | Meaning                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exact`    | The quote equals a dictionary value byte-for-byte.                                                                                                                                    |
| `prefix`   | The quote is the leading substring of a longer dictionary value (the document truncated a label).                                                                                     |
| `template` | The quote matches a `{{placeholder}}` dictionary value with its interpolation(s) filled in — e.g. dictionary value `"Выбрано: {{count}} из 100"` matches quote `«Выбрано: 0 из 100»`. |
| `fragment` | The quote is an 8+ character excerpt drawn from the middle of a longer dictionary value.                                                                                              |
| `MISSING`  | None of the above. Either real drift, or one of the accepted exceptions below.                                                                                                        |

Two rules keep `template` honest, because both were real defects that each
silently voided an entire run's verdict (a green `missing=0` that proved
nothing — see `lens.test.mjs` for the regression tests):

1. **A bare placeholder does not count as a template.** A dictionary value
   that is nothing but `"{{name}}"` would compile to the regular expression
   `^.+$` and match _any_ quote. A template only counts once its literal text
   (everything outside the placeholders) is at least 3 characters.
2. **A short literal cannot swallow an unrelated quote with the same tail.**
   A dictionary value like `"{{count}} смены"` would compile to the regular
   expression `^.+ смены$`, matching any string ending the same way —
   including an unrelated real label such as `"[TXT][Паллеты] Отчет смены"`
   from the shift-export format catalogue (see below). A template only
   counts once its literal text is at least half as long as the quote it's
   being matched against.

## Accepted exceptions

A `MISSING` verdict is a real finding **unless** the quote falls into one of
these categories, all of which this document series has knowingly accepted
because the text is not sourced from the admin i18n dictionary at all:

- **Raw Chestny ZNAK (True API) status codes.** Codes such as `INTRODUCED`
  are shown to the user verbatim, exactly as the regulator's API returns
  them — they are not translated strings and have no dictionary entry. See
  `«INTRODUCED»` in `cabinet-inventory-prep.ts`.
- **The single-language shift-export format catalogue.** Format labels such
  as `"[TXT][Паллеты] Отчет смены"` live in
  `packages/domain/src/shift-exports.ts` (`SHIFT_EXPORT_FORMATS[].label`),
  not in `apps/admin/src/i18n`. They are Russian-only by design and rendered
  as-is in both the `ru` and `en` cabinet, so an `en` document quoting one
  will also read `MISSING` there.
- **Server-rendered Russian print forms.** A printed sheet is generated
  server-side as an artifact; its headings never enter the admin React UI's
  i18n dictionary, and they stay Russian on a printout an English-speaking
  reader is still expected to recognise. MKR-INS-06 quotes the inventory
  task-order heading `«Задание на инвентаризацию»` (frame `task-form`) in its
  `en` text for exactly that reason, and the lens reports it `MISSING` there.
  Note that the cabinet _button_ that opens the sheet is an ordinary
  dictionary string (`openForm`) and resolves `exact` — the exception covers
  what the print artifact renders, not the control that triggers it.
- **Strings the UI composes at runtime from parts.** Some cabinet text is
  built by concatenating two or more independent dictionary values at
  render time rather than by filling a single `{{placeholder}}` template —
  for example `CategoryBinding.tsx`'s transfer preview, which renders
  `` `${valueText(current)} → ${valueText(proposed)}` ``. No single
  dictionary entry contains the composed string, so the lens cannot classify
  it as `template`; it must be accepted by inspection instead.

When a `MISSING` quote does **not** match one of these four categories,
treat it as a real finding: either the document is describing a renamed,
removed, or never-existing piece of UI, or it mis-transcribed a live string.
Cross-check the quote against the current `apps/admin/src/i18n/<locale>.json`
and the live component before editing the document, since the dictionary is
the source of truth the lens compares against.

## Tests

```bash
node --test tools/instruction-lens/lens.test.mjs
```

The suite exercises the tool's real exported functions (`classify`,
`extractQuotes`, `flattenDictionaryValues`, `lint`, `main`) against small
in-test dictionaries — never a reimplementation of the matching rules — plus
a CLI smoke test that runs `lens.mjs` as a child process against a throwaway
fixture repository to prove the `root`/`dictDir` argument handling still
resolves the registry and dictionary paths correctly after the move out of
`/tmp`. `main()` takes an explicit `argv` array and returns the process exit
status instead of calling `process.exit` itself, so the exit-code tests for
both failure paths (a `MISSING` quote, and a zero-quote extraction) can
assert on the returned number directly, in addition to the CLI-level tests
that spawn the real subprocess and check its actual exit code.
