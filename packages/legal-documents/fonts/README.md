# Вендоренные шрифты IBM Plex

Эти четыре TTF — единственные начертания, встраиваемые в legal-PDF
(проверено `pdffonts` по всем 17 PDF релиза): курсивы и другие веса
не используются.

| Файл | Семейство | Версия | sha256 |
| --- | --- | --- | --- |
| `IBMPlexSans-Regular.ttf` | IBM Plex Sans | 3.005 | `975dcda37d80f038dcd143c22e33ca2d97a0cc5a929aace1c749153b0fe1afa5` |
| `IBMPlexSans-Bold.ttf` | IBM Plex Sans | 3.005 | `9e6c74a889a700d707613d24548fe4ffa6bc59559a0689d2cf9e133bdcdafb2f` |
| `IBMPlexMono-Regular.ttf` | IBM Plex Mono | 2.004 | `fe11304a5fe956d5744e9b6a246cc83d90425245e75a62230044966ca96a7f50` |
| `IBMPlexMono-Bold.ttf` | IBM Plex Mono | 2.004 | `ca403c56931baef307d20ba64b69acb71abcad61f75e66414661d57484b690ec` |

Источник: https://github.com/IBM/plex (лицензия — SIL OFL 1.1, см.
`OFL.txt`; разрешает редистрибуцию). Файлы байт-в-байт совпадают со
шрифтами машины, на которой сгенерирован и аттестован текущий релиз
артефактов, поэтому вендоринг не изменил байты PDF.

`stageLibreOfficeFonts()` (`src/cli/generate-artifacts.ts`) копирует их
в папку пользовательских шрифтов одноразового LibreOffice-профиля перед
каждой конвертацией, так что генерация работает и на машине без
установленных IBM Plex.

Ограничение: если в системе установлена *другая* версия Plex, какая из
двух копий победит при совпадении имени семейства — внутреннее
поведение LibreOffice. Дрейф ловится байт-сверкой с манифестом и
аттестацией (`artifacts:verify`, `deploy/production/verify-legal-artifacts.mjs`).

Состав и хэши каталога пинит `test/fonts.test.ts` — при замене файлов
обнови таблицу и тест сознательно.
