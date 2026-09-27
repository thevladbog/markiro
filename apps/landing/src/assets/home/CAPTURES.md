# Home page captures

Frames shown on the home page. Retake them when the screens change.

| File                                             | Source                                                         | How                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `map-wide.jpg`, `map-phone.jpg`, `film-page.jpg` | Film scene                                                     | `pnpm --dir tools/production-browser --ignore-workspace render:home-images`        |
| `screens/*/station-*.png`                        | Station screen gallery, `profile=landing`                      | `pnpm --dir tools/production-browser --ignore-workspace capture:station-screens`   |
| `screens/*/cabinet-*.png`                        | Admin panel on a seeded stand                                  | Plan task 6, steps 1, 2 and 4                                                      |
| `screens/ru/kiosk.png`                           | Kiosk harness twin with a realistic cart                       | Plan task 6, step 5                                                                |
| `screens/ru/handheld.png`                        | Handheld on the Android emulator                               | Plan task 6, step 3                                                                |
| `labels/*.png`                                   | Copies of `examples/labels/*/box-100x150.png`                  | `apps/landing/test/home-assets.test.ts` checks them                                |
| `docs/*.png`                                     | First pages of the published instructions, Russian and English | `pnpm --dir tools/production-browser --ignore-workspace render:instruction-covers` |

Film times: the map stills are rendered at film time 0.8 (`apps/landing/src/content/home-map.json`, shared with the hotspot projection), the film page image at 3.8 (`FILM_PAGE_TIME` in `tools/production-browser/scripts/render-home-images.mjs`).

`station-offline.png` is a close-up of the gallery's `offline` state at double density: the status pills, the shift counter and the first three journal rows. The same script measures where the section's three numbered marks go (a journal row, the sync pill, the server pill) and writes them to `apps/landing/src/content/home-offline.json`, so the image and the marks are always retaken together.

Stand used on 2026-09-26/27: organization «Демо-производство», lines «Линия 1…3», products «Сок яблочный, 1 л», «Нектар вишнёвый, 1 л», «Крем для рук, 75 мл» and six more for the catalog, operator «Мария Соколова». Production data comes from handheld scans on the emulator (codes generated for the stand's GTINs); the overview therefore shows two days. The stand has no Chestny ZNAK connection, so the catalog's National Catalog links were inserted into the stand database (`national_catalog_product_links`: seven published, one on moderation, one not linked). `cabinet-chz.png` shows the product catalog list rather than one product's card: on the stand the card's Chestny ZNAK panel also says the connection is not configured, and the owner chose the list on 2026-09-27. The catalog, kiosk and station frames use the example prefix 4600000 (the apple juice is 04600000000015, as on its case label); the case labels are copies of `examples/labels`, whose SSCC uses that folder's example prefix. The catalog, kiosk and station frames were retaken on 2026-09-27 for that. The kiosk frame comes from a temporary copy of `apps/kiosk/test/touch-flow.html` with a three-line cart for the demo employee «Ковалёв Дмитрий Сергеевич»; the copy was deleted after the capture.

Plan: `docs/superpowers/plans/2026-09-26-landing-home-redesign.md`.
