# Station stable release runbook

Ручной выпуск Windows x64 stable-версии Markiro Station из одной явно принятой
dual-origin beta. Workflow не выбирает newest beta, не добавляет более новые
изменения из `main` и не устанавливает обновление на станции автоматически.

## Защищённые environments и исходные условия

1. GitHub Environment `station-stable` хранит только
   `TAURI_SIGNING_PRIVATE_KEY` и `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` и даёт
   отдельную историю stable build/sign. В нём нет required reviewers, поэтому
   второй пользователь для build/sign не нужен. Приватный ключ остаётся в
   исходном base64-формате из `tauri signer generate` байт-в-байт: не
   декодируйте, не перекодируйте и не нормализуйте его. Не печатайте значение и
   не переносите его в publisher job.
2. Защищённый Environment `station-release` требует approval release owner и
   содержит secrets `YANDEX_STATION_RELEASE_ACCESS_KEY_ID`,
   `YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY`, variables
   `YANDEX_STATION_RELEASE_BUCKET`, `YANDEX_STATION_RELEASE_ENDPOINT`. Signing
   secrets туда не копируются; publisher credentials не попадают в build job,
   аргументы, artifacts или логи.
3. Production API должен принимать `http://tauri.localhost`. До обычной
   публикации или repair выполните `pnpm verify:station-production-cors`.
4. Для normal flow уже существует полный Yandex stable rollback baseline:
   `station/stable/latest.json` и `station/download`. Отсутствующий или
   неполный baseline останавливает workflow до первой mutable mutation.

## Одноразовый legacy stable rollback baseline

`mode=seed-baseline` — отдельный защищённый режим до включения release DNS. Он
нужен только для переноса текущего legacy GitHub-only stable в полный Yandex
rollback baseline. Это не retrofit старой beta и не доказательство, будто у
исторической beta существовали dual-origin evidence.

Передайте:

- пустой `source_beta_tag`;
- `acceptance_confirmed=false`;
- пустые `highlights`;
- точный `seed_stable_tag` текущего последнего normal stable release;
- точный applied infrastructure evidence JSON, где
  `enableStationReleasePublicDns` равно `false`.

Workflow проверяет, что `seed_stable_tag` является последним canonical stable,
скачивает его GitHub release в чистый каталог и вызывает общий закрытый
`seed-baseline ... stable ... --confirm-empty-channel-bootstrap`. Команда Task 5
сама валидирует legacy GitHub tree, строит Yandex metadata вокруг тех же bytes,
публикует только полностью отсутствующий immutable prefix, перечитывает его
через provider host, создаёт manifest и server-side-copy alias и сохраняет
bounded bootstrap record с recovery backup. DNS workflow не включает.

Если первая seed-попытка прервалась, не удаляйте objects и не перезаписывайте
immutable keys. Повтор разрешён только с тем же exact stable; generic seed gate
принимает пустое состояние либо полную уже совпадающую pair и обязан снова
публично доказать known-good baseline. До отдельного одобренного DNS apply
`releases.markiro.app` не направляет трафик на baseline.

## Публикация принятой beta как stable

1. Откройте `Publish station stable` из `main`, выберите `mode=publish`.
2. В `source_beta_tag` укажите точный immutable beta tag, например
   `station-v1.2.0-beta.1`, и установите `acceptance_confirmed=true`.
   `highlights` остаётся необязательным.
3. Workflow скачивает GitHub и Yandex beta evidence и assets в разные чистые
   каталоги, валидирует обе trees и сравнивает common assets. Только matching
   GitHub и Yandex beta evidence допускают дальнейшую работу. GitHub tag target
   обязан совпасть с `betaReleaseSha`, release-only diff ограничен stable
   overlay, а CI для verified `baseSha` обязан завершиться успешно.
4. Только после этого workflow checkout-ит принятый `baseSha`, применяет
   `tauri.stable.conf.json`, создаёт один release commit и ровно один раз
   собирает/подписывает Windows NSIS. Stable не строится из текущего более
   нового `main`.
5. Changelog и release notes строятся детерминированно от предыдущего stable
   source; optional highlights не меняют provenance. Один общий installer,
   updater bundle, detached signature, notes и accepted-beta provenance
   оборачиваются в GitHub и Yandex stable trees. Различаться могут только
   origin URL, manifest/checksum/evidence digests и `distribution`.
6. Immutable GitHub release `station-vX.Y.Z` создаётся без `--clobber`, затем
   absent Yandex prefix `station/stable/releases/X.Y.Z/` публикуется общим
   publisher. Обе публичные trees повторно скачиваются, независимо валидируются
   и сравниваются до любой mutable backup.

Mutable transaction имеет ровно такой порядок:

1. GitHub `station-stable-channel/latest.json`;
2. Yandex `station/stable/latest.json`;
3. default stable alias `station/download` — server-side copy проверенного
   immutable installer и всегда последний target.

Публичные URL:

- GitHub channel:
  `https://github.com/thevladbog/markiro/releases/download/station-stable-channel/latest.json`;
- Yandex channel: `https://releases.markiro.app/station/stable/latest.json`;
- default installer: `https://releases.markiro.app/station/download`.

Beta alias `station/beta/download` в stable transaction не используется и не
может стать default installer.

## Mutable-only repair и rollback

Если обе immutable stable trees опубликованы, а pointer transaction не
завершился, повторите exact `source_beta_tag`, `acceptance_confirmed=true` и
выберите `mode=promote-existing`. Этот режим снова строго валидирует dual-origin
accepted beta и обе уже опубликованные stable trees, не пересобирает и не
подписывает package, не создаёт release commit и не загружает immutable object.
После полных GitHub/Yandex backups он повторяет только mutable transaction.

Единый trap восстанавливает изменённые targets в точном обратном порядке:
Yandex alias, Yandex manifest, затем GitHub manifest. Каждый restored target
перечитывается публично и сравнивается с backup; ошибка restoration verification
становится отдельным hard failure. Immutable releases/objects не удаляются и не
перезаписываются. Partial-origin mismatch нельзя «чинить» копированием surviving
tree: сохраните evidence, расследуйте collision/audit и выпустите новую версию.

## Restricted network и ручной install-over

В ограниченной сети (restricted network), где GitHub заблокирован, скачайте
проверенный installer только по `https://releases.markiro.app/station/download`
и выполните ручной install-over, то есть установку поверх существующей
установки. Сверьте SHA-256 с origin evidence вне станции. Переход beta → stable
и stable → stable выполняется только вне активной смены; фоновой загрузки,
автоматической установки или restart нет.

До и после установки зафиксируйте неизменность application identity и пути
Station SQLite, pairing, settings, journals, boxes, exceptions и pending outbox.
Проверьте offline restart/reconnect и последующую синхронизацию outbox. Нельзя
считать удаление SQLite или outbox допустимым rollback.

## SmartScreen и границы доказательства

NSIS не имеет Authenticode: Tauri updater signature защищает updater bundle, но
Windows может показать SmartScreen или «неизвестный издатель». Не учите
оператора обходить предупреждение вслепую. Автоматизированные contracts не
доказывают Windows install-over, WebView2, scanner, printer, sound, touch,
сохранение данных или работу из реальной restricted network. Все такие строки
остаются `NOT RUN` в
[`station-stable-release.md`](../acceptance/station-stable-release.md), пока не
появятся оператор, UTC timestamp и evidence path/hash.
