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

Это first-run rollback baseline, а не обычная публикация. Его exact accepted
stable tag и backup/record сохраняются до первого dual-origin stable; immutable
historical releases не retrofit и не получают задним числом Yandex evidence.

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

1. До публикации завершите transitional beta acceptance record: его Overall
   result и все строки `BETA_SIGN_OFF` должны быть `PASS`. Stable-строки,
   `PUBLISH-01` и stable rollback ещё остаются `NOT_RUN` и не блокируют саму
   первую stable publication, потому что проверяются после неё.
2. Откройте `Publish station stable` из `main`, выберите `mode=publish`.
3. В `source_beta_tag` укажите точный immutable beta tag, например
   `station-v1.2.0-beta.1`, и установите `acceptance_confirmed=true`.
   `highlights` остаётся необязательным.
4. Workflow скачивает GitHub и Yandex beta evidence и assets в разные чистые
   каталоги, валидирует обе trees и сравнивает common assets. Только matching
   GitHub и Yandex beta evidence допускают дальнейшую работу. GitHub tag target
   обязан совпасть с `betaReleaseSha`, release-only diff ограничен stable
   overlay, а CI для verified `baseSha` обязан завершиться успешно.
5. Только после этого workflow checkout-ит принятый `baseSha`, применяет
   `tauri.stable.conf.json`, создаёт один release commit и ровно один раз
   собирает/подписывает Windows NSIS. Stable не строится из текущего более
   нового `main`.
6. Changelog и release notes строятся детерминированно от предыдущего stable
   source; optional highlights не меняют provenance. Один общий installer,
   updater bundle, detached signature, notes и accepted-beta provenance
   оборачиваются в GitHub и Yandex stable trees. Различаться могут только
   origin URL, manifest/checksum/evidence digests и `distribution`.
7. Immutable GitHub release `station-vX.Y.Z` создаётся без `--clobber`, затем
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
Для `promote-existing` exact stable выводится из переданного
`source_beta_tag`; это может быть предыдущий опубликованный stable, а не только
newest stable. Workflow требует, чтобы выбранная beta была опубликованным
non-draft prerelease, а соответствующий stable — опубликованным non-draft
normal release. Оба stable origin и записанный accepted-beta provenance должны
совпасть.

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

До и после установки зафиксируйте application ID `app.markiro.station`,
фактический абсолютный путь к базе и относительное имя
`sqlite:station-mirror.db`, pairing, settings, journals, boxes, exceptions и
pending outbox. Не выводите путь из предположения о Windows user profile:
снимите его с установленной Station до и после install-over.
Проверьте offline restart/reconnect и последующую синхронизацию outbox. Нельзя
считать удаление SQLite или outbox допустимым rollback.

Update остается manual-only: автоматической загрузки, установки, restart или
forced downgrade нет. При active shift установка запрещена, но Station должна
продолжать production work — сканирование, печать, локальные journals, boxes,
exceptions и outbox.

## SmartScreen и границы доказательства

NSIS не имеет Authenticode: Tauri updater signature защищает updater bundle, но
Windows может показать SmartScreen или «неизвестный издатель». Не учите
оператора обходить предупреждение вслепую. Автоматизированные contracts не
доказывают Windows install-over, WebView2, scanner, printer, sound, touch,
сохранение данных или работу из реальной restricted network. Все такие строки
остаются `NOT RUN` в
[`station-dual-origin-release.md`](../acceptance/station-dual-origin-release.md),
пока не появятся оператор, UTC timestamp и evidence path/hash.

## Exact rollback

Для незавершённой mutable transaction при обеих валидных и совпадающих
immutable trees повторите точные release inputs с `mode=promote-existing`.
Режим не строит, не подписывает и не загружает immutable assets. При ошибке
восстановите только изменённые targets в точном обратном порядке: Yandex
`station/download` alias, Yandex stable manifest, GitHub stable manifest. Каждый
target публично сравнивается с сохранённым backup. Partial-origin incident не
лечится `promote-existing`, overwrite или копированием surviving tree.

Для отдельной post-success acceptance-проверки rollback выберите предыдущий
принятый strict dual-origin stable. Возьмите его точный `source_beta_tag` из
обоих совпадающих `release-evidence.json`, поместите в
`PREVIOUS_STABLE_SOURCE_BETA_TAG` и до dispatch повторно проверьте обе immutable
trees, stable tag/target и evidence hashes. Затем выполните:

```bash
gh workflow run station-stable-release.yml --ref main \
  -f mode=promote-existing \
  -f source_beta_tag="$PREVIOUS_STABLE_SOURCE_BETA_TAG" \
  -f acceptance_confirmed=true
```

Protected run валидирует exact beta и derived stable, создаёт полные временные
backup текущих mutables и продвигает GitHub manifest, Yandex manifest и default
stable alias последним. После успеха публично скачайте оба stable channel
manifest и `https://releases.markiro.app/station/download`, сравните с выбранной
immutable stable и сохраните workflow URL/evidence hashes. Backup нужен для
in-run compensation, очищается после успешного run и не является durable
artifact. При любом mismatch остановитесь; не overwrite/cross-copy immutable
tree. При ошибке mutation порядок compensation остаётся прежним: Yandex alias,
Yandex manifest, GitHub manifest, с публичным сравнением каждого временного
backup.

Rollback channel pointer влияет только на ещё не обновившихся клиентов. Для уже
обновлённой Station закройте активную смену, проверьте SQLite compatibility
window и SHA-256, затем вручную установите предыдущий accepted immutable stable.
Application ID, SQLite path, pairing, settings, journals, boxes, exceptions и
outbox сохраняются; удаление данных запрещено.
