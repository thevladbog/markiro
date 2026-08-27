# Inventory GISMT XML contracts v1

Implemented on 2026-08-27 for manual upload to the Chestny ZNAK personal account. The source XML
and XSD files were downloaded by the repository owner from the official document templates
section. Successful portal upload has not yet been performed and remains the external acceptance
gate.
Their original SHA-256 digests are recorded below so a later upstream replacement is reviewable.
The text copies under `source/` are review-friendly LF-normalized copies; their separate digests
are recorded after the table and are not presented as byte-identical downloads.

## Source provenance

| Source file                    | SHA-256                                                            | Status                                                                            |
| ------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `Формирование_упаковки.xml`    | `d5797d6dfcd0f1e519e2ad4341fc691ed6754d7dce87720d618ca7b7e4a14069` | Official example; incomplete against its XSD                                      |
| `Формирование_упаковки.xsd`    | `b962e1a89678e4eff8c7984f2c41787417ab0776c64adb4560bb9a75157b14d2` | Normative aggregation structure used by v1                                        |
| `Расформирование_упаковки.xml` | `5b0820869dbbdf6cd5f9032ddfbc1e3399b6340dfc39abe7b74ad2988fba55ea` | Official example with a deliberately invalid zero INN                             |
| `Расформирование_упаковки.xsd` | `aba3ab6bc81361fc84e32be97147bb38cd16891dce36d5a826b8fc6b0740ec65` | Normative disaggregation structure; references unavailable `LP_base_types_v2.xsd` |
| `LP_base_types.xsd`            | `b4043ece9ce8e5c63ae5f641149aaafc69019f5d4e9c9007b35357387b2eb27b` | Current common-types XSD downloaded from the same official page                   |

Official source page: <https://docs.crpt.ru/gismt/Раздел_шаблоны_документов/>.

Repository-copy SHA-256 values: `aggregation.example.xml` `f337ae38a0cf66befeef23d1e6d58b90affe18f888b1085e27e5cdf337077dac`,
`aggregation.xsd` `b6e806d682a69271e7ef62863640b43b1e87c76b061d12d91e0aa8b5381409a7`,
`disaggregation.example.xml` `d5641a981d522190337c1f791070050053a3905651017dc90966e34d7d875d33`,
`disaggregation.xsd` `9491ce5bdf5bf4038c46b3e689dca0cd1f5bd3e55e349ec5ffba9bab3404f27c`,
and `LP_base_types.xsd` `7e6f1dabb42f986edb530fcfdfc5930fc5647ab43253cad0a91fe6a07c02b5b3`.

## Shared byte contract

- UTF-8 without BOM, NFC-derived filenames, LF line endings, and one final newline.
- One file per selected format; v1 does not split a logical document into parts.
- Filenames are `inventory-<sanitized inventory number>-aggregation.xml` and
  `inventory-<sanitized inventory number>-disaggregation.xml`.
- Retries use the document-run UUID and snapshots of the inventory number, close timestamp,
  organization name, and INN; later profile edits cannot change an existing run.
- XML-reserved characters are escaped. XML 1.0 control characters and malformed GS1/SSCC values
  fail generation.

## Aggregation

- Root attributes required by the XSD are emitted even though the official example omits them:
  `document_id`, `VerForm="1.03"`, `file_date_time`, `action_id="30"`, and `version="1"`.
- `Document` carries the frozen close timestamp as `operation_date_time` and inventory number as
  `document_number`; `LP_info` carries the frozen organization name and ten-digit legal-entity INN.
- Only closed, printed new boxes whose every child belongs to `verified` are emitted. Open,
  invalidated, unresolved-print, incomplete, unknown, ineligible, voided, or protected boxes are
  omitted as indivisible units.
- Internal 18-digit SSCCs become the 20-digit `00`-prefixed `pack_code`. Each KM becomes
  `01<GTIN14>21<serial>`; AI 93 and its crypto tail are not placed in `cis`.

## Disaggregation

- The document uses `action_id="31"`, `version="2"`, the frozen participant INN, and one 18-digit
  `kitu` per eligible old box used as the context of a completed, printed repack box. Merely
  scanning an old box for a simple inventory check never creates a disaggregation entry.
- Duplicate boxes are removed and remaining boxes are sorted by SSCC.
- An old box is omitted when the frozen source contains a protected/`MOVING_BY_UD` code whose
  `parentSscc` is that box. An empty actionable result fails generation.
- The supplied XSD cannot compile standalone because its official `LP_base_types_v2.xsd` link is
  unavailable. The checked golden output was compatibility-validated with the current official
  `LP_base_types.xsd`; `xmllint --schema` accepts the golden fixture when that file is supplied
  under the referenced v2 filename. Successful manual upload remains the external acceptance gate.

## Explicitly out of scope

`Ввод в оборот. Производство РФ` is not an inventory output for `INTRODUCED` codes and is not
advertised by this catalog version. Submission, signing, and True API integration are also outside
v1; users download these XML files and upload them manually.
