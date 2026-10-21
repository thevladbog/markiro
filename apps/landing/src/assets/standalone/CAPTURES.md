# Standalone page images

Screens and labels on the home page of «Маркиро Автоном» (`components/autonom/`). Copied on
2026-10-21 from the mockup assets `docs/design-briefs/landing-new-assets/` in the main checkout
(the folder is not in git) and resized with sharp where the source was larger than any rendered
width. Astro turns them into AVIF and WebP at build time; the PNG here is only the source.

| File                              | Source in `landing-new-assets/`                         | Shown in                       |
| --------------------------------- | ------------------------------------------------------- | ------------------------------ |
| `station-aggregation-dark-r3.png` | `standalone/station-aggregation-dark-r3.png` (original) | hero                           |
| `station-hub-offline-dark-r4.png` | same name, resized to 1600 px                           | «Без облака»                   |
| `station-duplicate-dark-r3.png`   | same name, resized to 1800 px                           | «Станция на линии»             |
| `tsd-work-dark.png`               | `standalone/tsd-work-dark.png` (original)               | «ТСД на складе»                |
| `office-overview-dark.png`        | `standalone/office-overview-dark.png` (original)        | «Офис»                         |
| `label-box-100x150.png`           | same name, resized to 600 px                            | «Этикетки»                     |
| `label-pallet-100x150.png`        | same name, resized to 600 px                            | «Этикетки»                     |
| `clients/*`                       | `clients/*`, Михайловский перевал resized to 360 px     | logo strip, light and dark set |

Product screens are the dark variants in both page themes. The SmartScreen windows on
`/skachat/` are drawn in HTML until real Windows 10/11 screenshots
(`standalone/smartscreen-1.png`, `smartscreen-2.png`) are captured.
