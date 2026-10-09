# TSPL SSCC barcode acceptance

SSCC-bound Code 128 elements use TSPL `EAN128`. The printer supplies the leading
FNC1; the content contains AI `00` followed by the bare 18-digit SSCC. The former
`128` command with a literal `!1` prefix encoded those characters into the barcode.
Other Code 128 fields and literals remain plain `128`. ZPL output is unchanged.

Reference: [TSC TSPL/TSPL2 programming manual, BARCODE](https://fs.tscprinters.com/system/files/31-0000001-00_tspl_tspl2_programming_3_0.pdf),
printed pages 54–64: `128` and `EAN128` are distinct symbologies; explicit control
codes belong to manual-subset mode and use three digits after `!`.

## Automated coverage

- Domain emitter tests pin EAN128, AI 00 and the unchanged bare SSCC, plus ordinary
  Code 128 behavior and barcode widths.
- Station tests check the actual rendered bytes at 203 and 300 dpi and the
  inventory box-label output, including unchanged ZPL.
- Generated label fixtures keep TypeScript and Kotlin output aligned.

## Physical acceptance — not run

Record station/handheld version, printer model, firmware, transport, configured DPI,
scanner model/settings and raw decoded text. Run separately for each supported
printer/DPI combination:

1. Print a box label with a known valid SSCC, including a case with leading zeros.
2. Scan the bars back. For SSCC `046006820000621515`, the data must be
   `00046006820000621515`: AI `00` plus the unchanged SSCC. It must not contain `!1`.
   If AIM identifiers are enabled, record `]C1` separately as scanner metadata.
3. Confirm the station accepts that scan for the same box. Check the printed
   human-readable SSCC and barcode placement/quiet zones.
4. Regenerate a label for an existing box through the normal reprint action and
   confirm the same identity and dates. Existing paper labels are not corrected
   automatically; replace affected labels through the established reprint flow.
5. Check a plain Code 128 label and the equivalent ZPL box label for regressions.

Persisted product-duplicate jobs continue replaying their saved bytes. This change
only affects newly rendered SSCC labels and does not rewrite historical jobs or
stored identifiers. A retry that reuses already prepared bytes also keeps them.
