# Decisions parked for the owner (collected by the controller; none blocks the other streams)

1. ИМП (cloud import) Task 2 PARKED: the plan's transfer file carries credential VERIFIERS from the cloud — operators' PIN hashes (`pinPhc`), badge hashes (`badgePhc`) and the tenant's badge salt (`badgeSalt`); plaintext badge codes are read from the raw cloud rows only to re-hash and are not written. The plan's design goal is «без новых PIN» (pilot spec §8.3 option 1). Alternative B: do not export them — operators get new PINs/badges created in the standalone (changes host import contract of ИМП Tasks 4–6, golden file, and the goal). The implementer stopped (NEEDS_CONTEXT) because the controller's dispatch said to stop on credential-bearing fields. Owner decides A (carry hashes, treat the transfer file as sensitive: owner-only permissions, delete after import, runbook line) or B (re-create credentials).
2. Ч1 (ЧЗ): a taken-apart pallet stays a pallet in the shift's pallet export formats (like the cloud) — contradicts the ПЛ-Х host contract; the dialog warns with a count; changing it = one line in the cloud + one in the port.
3. N21 (2a6): a `rejected` receipt flags nothing on the floor (only `conflict` does); default = visible count in the status bar.
4. Former printer on a reprint-rebind is not recorded (audit gap; needs a migration or protocol field) — accepted for the pilot.
5. A damaged stored print-job row blocks the shift's line until the operator leaves the shift (no bypass) — owner/2b.
6. «Сформирован» time on the shift blank is always Moscow time (domain parity with the cloud).
7. РК: stations do not re-register SSCC blocks after a restore until plan РК-С; margin cost ~1 % of the 7-digit serial range per restore when the previous database is unreadable.
8. Pilot inputs still needed from the owner: restored cloud DB copy + tenantId, sample ЧЗ files, `lc_collate` of the cloud DB, printer and scanner models, Windows PCs for manual verification (nothing has ever run on Windows).

- (main drift) П15: logo on standard thermal labels (#703) — the standalone rasterizer would print a blank area: bundle the Markiro print logo into the product, or accept blank? Also: does the client need Windows driver label printing (#696)? Thermal output changes under #692 (SSCC native EAN128) → physical scan check on a real TSC/Zebra printer needed at pilot acceptance.
- (РК-С I1) NEW-PC RESTORE LOSES THE OLD PAIRING'S WORK. After restoring the host from a backup copy on a new PC, stations must re-pair (new hostId + cert). Everything the station does for a restored host is keyed to the CURRENT pairing, so: records acknowledged after the copy are lost; unsent records stay on the station disk (forget refuses until the engineer confirms); the open shift (boxes already labelled) is lost to the host; post-copy SSCC blocks are never registered (uniqueness rests on the +100 000 counter margin + runbook check 1). Options: (1) include host identity (host.json + tls/ private key) in the backup copy so stations keep their pairing and restore works unchanged — smallest fix, but the TLS key then lives in backup copies (on a network share / second folder); (2) rk-minors 11 (a)/(b): carry the old pairing's records/blocks into the new pairing; (3) accept the loss and document in the runbook. Recommended: (1) if the backup folder is protected like the host PC, else (3) with a mandatory runbook step to drain stations before the old PC dies.

## DECISIONS 2026-10-11 (owner message after the final gate; "maximum speed")

- Do ALL deferred items, especially the cloud → offline migration (ИМП Tasks 2–9). Controller's resolutions of the open options (owner may override): ИМП = option A (carry PIN/badge verifiers pinPhc/badgePhc/badgeSalt; never log them); I1 = option 1 (host identity host.json+tls goes into the backup copy so stations keep their pairing); logo = bundle the Markiro print logo (as #703 does) + organization logo upload; driver printing (#696), A4 pallet sheets (#702/#704/#705 + footer/logo), warehouse reprint (#693/#695/#697) and the rest of the cloud station's new logic are to be PORTED into the standalone station.
- After all work: PUSH the branch to the repository and build the first beta; the owner tests locally.
- (ИМП T6 review minor 2) OWNER QUESTION: should POST /v1/office/import be allowed only from the host's own PC (loopback) or from any office session? Currently any office admin session. Default: keep as is; document in runbook (Task 9).

## 2026-10-13 — стратегия после MVP

- Этап ТСД на хосте и сворачивание веб-контура («режем онлайн») идут одновременно, одним этапом.
- Подписант (ЧЗ) со временем встраивается в офис автонома; Postgres в автоном не тащим; on-prem из облачного кода — только если придёт крупный клиент.
- Один завод, несколько кабинетов на одном хосте; сеть площадок не нужна. Роли офиса пока admin/technologist — расширим позже.
- Киоск — в будущем, если актуален: приложения Windows и Android, подключение к хосту по IP/имени через сопряжение (DeviceKind::Kiosk).
- После выпуска MVP: презентации-инструкции по ролям + документ для системных администраторов со всеми подводными камнями (сырьё — docs/runbooks/standalone-beta-1.md и «Отклонения при исполнении» планов).

## 2026-10-13 — лицензия и обновления (по фидбеку беты)

- Лицензия: на площадку (один хост = одна площадка), модель подписка. Остальное (льготный срок, что блокируется по истечении, выдача файла) — предложено мной, ждёт подтверждения: мягкое применение, никогда не останавливать открытую смену/линию, после льготного срока запрет только на открытие НОВЫХ смен; лицензия — подписанный файл (Ed25519), привязан к идентичности хоста, проверка офлайн.
- Обновления: только вручную из файла (без обращения в интернет, без кнопки «проверить»).

## 2026-10-13 — лицензия и обновления: приняты ВСЕ рекомендации спеки (ЛО1–ЛО17)

Мягкое применение (открытую смену не останавливать; после льготного срока 14 дней — запрет только новых смен), предупреждение за 30 дней, без лимитов на площадку, пробный период 60 дней, аварийное продление 72 ч один раз, JSON-конверт Ed25519, привязка к hostId, подписка на год без отзыва офлайн, обновление запускает приложение через UAC, раздача обновления через хост в первой версии (окно совместимости N−1, предзагрузка только по нажатию, «Обновить с хоста» с UAC), Authenticode OV-сертификат до коммерческих продаж. Спека: docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md (ветка claude/fb-license).
Режимы смены (план РЕЖ, ветка claude/fb-mode): все рекомендации приняты; ДВА режима «Агрегация»/«Проверка», при «Проверка» появляется флаг перепечатки дубликата (не третий режим); части A и B; режим на смену, не меняется после открытия; по умолчанию «Агрегация»; проверка этикетки сканом по умолчанию выключена.
Окна (решение владельца): офис и хост — всегда обычное окно; станция — обычное окно до настройки, полноэкран после настройки.
Облачную станцию не замораживаем; всё нужное форкаем в автоном, мелочи допереносим потом.
21:52 РЕШЕНИЕ ВЛАДЕЛЬЦА: формы создания/редактирования и длинные данные — в боковые шторы (SidePanel), модалки только для подтверждений/сабмитов; товары первыми (b3-office), глобальный аудит модалок — отдельной задачей после слияния b3-office/b3-shifts; фото товара (одно) должно быть заметно.
