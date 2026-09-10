# Duplicate Data Matrix design exports

Archived on 2026-09-10 from the existing local export set associated with
`docs/design-briefs/check_with_reprint.pen`. These are historical design references;
they do not establish the current production UI or printer acceptance.

The PNG files retain their original bytes, filenames and relative paths. The
export identifiers are listed below; their correspondence to nodes in the current
canvas has not been verified. The capture date and canvas revision were not
recorded in the export set.

## Screens

| Image                                             | Original filename | Raster size |
| ------------------------------------------------- | ----------------- | ----------- |
| [Admin: verification required](IotEk.png)         | `IotEk.png`       | 1920 × 1080 |
| [Admin: verification optional](PMa3F.png)         | `PMa3F.png`       | 1920 × 1080 |
| [Station: awaiting product scan](o2n95X.png)      | `o2n95X.png`      | 1280 × 800  |
| [Station: printing a label](X4Jr0.png)            | `X4Jr0.png`       | 1280 × 800  |
| [Station: awaiting label verification](bNmJq.png) | `bNmJq.png`       | 1280 × 800  |
| [Station: label verified](a6L7y.png)              | `a6L7y.png`       | 1280 × 800  |
| [Station: sent without verification](JbWWN.png)   | `JbWWN.png`       | 1280 × 800  |
| [Station: print result unknown](E7jA24.png)       | `E7jA24.png`      | 1280 × 800  |
| [Station: reprint reason](e3t0g.png)              | `e3t0g.png`       | 1280 × 800  |

The admin variants differ in the mandatory verification checkbox. The Station
sequence illustrates one accepted product code, one duplicate label, verification,
and recovery when the print result is unknown. Values shown belong to the design
sample, not to the production data export.

See the [behavior specification](../../../superpowers/specs/2026-09-08-validation-datamatrix-duplicate-design.md)
and [acceptance record](../../../acceptance/validation-dm-duplicate.md) for the
implemented contract and its verification limits.

The [editable canvas](../../check_with_reprint.pen) is archived alongside these
exports. The original [product image](../check-with-reprint-assets/gallery-product.webp),
[placeholder asset](../check-with-reprint-assets/QEJEX.png),
[admin reference](references/admin-shift-create.png) and
[Station reference](references/station-work-validation.png) retain their paths.
The reference captures show the sample account and test production line.

See the [design source index](../../design-sources.md) for the other canvases.
