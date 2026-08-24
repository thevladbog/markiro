# Bootstrap Yandex origin для Station releases

Это одноразовая операторская процедура. Она не является разрешением на
Terraform apply, изменение DNS, запись GitHub secrets, cloud probe или
публикацию release. Каждый отмеченный stop point требует отдельного человеческого
подтверждения. Не запускайте команды из этого документа во время реализации или
code review.

Никогда не включайте shell tracing (`set -x`). Не копируйте access key, secret
key, расшифрованный payload или чувствительные Terraform outputs в аргументы,
environment variables, буфер обмена, логи, summaries, artifacts или файлы
репозитория.

## Четыре фазы rollout

Этот порядок нельзя сжимать в один запуск. Task 11 документирует и проверяет
контракты, но **Task 12 is not authorized**: Terraform apply, DNS, GitHub
Environment/secrets, release publication и customer-device acceptance требуют
отдельных явных разрешений после merge.

1. **Phase 1 — provision without DNS.** Подготовить и отдельно одобрить
   инфраструктурный plan, применить его только после STOP 1, перенести
   credentials только после STOP 2, проверить certificate/provider host, но
   оставить `enable_station_release_public_dns=false`. Текущие GitHub-only
   клиенты и publication не меняются.
2. **Phase 2 — dual-publish tooling and seed.** Сначала интегрировать Tasks 1–7,
   затем при выключенном release DNS создать независимые first-run rollback
   baseline для stable и beta. Stable baseline использует точный принятый
   legacy stable; beta baseline требует новую strict dual-origin pre-transition
   beta. Immutable historical releases must not be retrofitted or
   переупакованы задним числом. После provider-host proof DNS включается только
   отдельным plan/apply за STOP 3.
3. **Phase 3 — transitional beta.** Только после integration Tasks 8–11
   опубликовать новую beta с fixed dual-origin adapter. GitHub-reachable
   GitHub-only установки получают её через старый updater; GitHub-blocked
   установки требуют ручной install-over по explicit Yandex beta installer.
   Завершить весь
   [dual-origin Windows/hardware acceptance record](../acceptance/station-dual-origin-release.md).
4. **Phase 4 — first dual-origin stable.** Только явно принятая transitional
   beta может быть точным `source_beta_tag`. Stable rebuild не берёт новый
   `main`; обе immutable trees и три mutable targets проверяются до физического
   допуска. CI/publication proof не является Windows/customer proof.

Канонические public installers:

- stable: `https://releases.markiro.app/station/download`;
- explicit beta: `https://releases.markiro.app/station/beta/download`.

Фиксированные public channels:

- Yandex stable: `https://releases.markiro.app/station/stable/latest.json`;
- Yandex beta: `https://releases.markiro.app/station/beta/latest.json`;
- GitHub stable:
  `https://github.com/thevladbog/markiro/releases/download/station-stable-channel/latest.json`;
- GitHub beta:
  `https://github.com/thevladbog/markiro/releases/download/station-beta-channel/latest.json`.

## 1. Подготовить защищённый план без release DNS

На точном SHA текущего `main` запустите **Yandex infrastructure** со значениями
`mode=plan`, `enable_station_release_public_dns=false` и пустыми `plan_key`,
`plan_sha256` и `plan_version_id`. Для `enable_public_dns` укажите его текущее
отдельно одобренное значение: этот gate относится к прямому app VM и не должен
измениться из-за Station release origin.

Просмотрите сохранённый plan. Допустимы только ожидаемые release bucket,
publisher, certificate/challenge и CDN resources. Release CNAME должен
отсутствовать. Запрещены удаление/замена state, media, audit, release bucket,
PostgreSQL или app VM, public list/config доступа к release bucket, delete права
publisher и любые release permissions для app/runtime identity.

Зафиксируйте все три выданных workflow non-secret значения: `plan_key`,
`plan_sha256` и точный `plan_version_id`. Сам saved plan находится только в
защищённом state bucket и не переносится в GitHub artifact, лог, summary или
локальный файл оператора.

## 2. Остановиться перед первым apply

**STOP 1 — APPLY.** Не запускайте `mode=apply` и не approve Environment
автоматически. Получите явное подтверждение владельца инфраструктуры на
применение именно проверенного saved plan. После подтверждения запустите
отдельный dispatch `mode=apply` с теми же точными SHA и обоими DNS flags, а также
выданными `plan_key`, `plan_sha256` и `plan_version_id`. Одобренный reviewer
вручную разрешает apply в отдельном GitHub Environment
`production-infrastructure-apply`. Изменение кода не заменяет этот approval.

Workflow не печатает и не сохраняет Terraform outputs. Дождитесь успешного apply
до локального доступа к защищённому state.

## 3. Получить зашифрованные outputs из защищённого state

Эти команды выполняет утверждённый оператор локально в уже настроенной
защищённой Terraform session. Не передавайте state-backend credentials в
аргументах и не сохраняйте их в repository. Подготовьте отдельный каталог и
файлы с ограниченными правами:

```bash
set -euo pipefail
set +x
umask 077

work_dir="$(mktemp -d)"
chmod 700 "$work_dir"
access_key_file="$work_dir/station-release-access-key-id"
encrypted_secret_file="$work_dir/station-release-encrypted-secret.b64"
encrypted_packet_file="$work_dir/station-release-encrypted-secret.gpg"
secret_key_file="$work_dir/station-release-secret-access-key"
bucket_file="$work_dir/station-release-bucket"

cleanup() {
  status="$?"
  trap - EXIT HUP INT TERM
  unset delete_confirmation secret_write_confirmation
  rm -f -- "$encrypted_secret_file" "$encrypted_packet_file" "$bucket_file"
  if test -e "$access_key_file" || test -e "$secret_key_file"; then
    printf '%s\n' "STOP: plaintext remains in protected directory $work_dir" >&2
  else
    rmdir "$work_dir" 2>/dev/null || true
  fi
  return "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

install -m 600 /dev/null "$access_key_file"
install -m 600 /dev/null "$encrypted_secret_file"
install -m 600 /dev/null "$encrypted_packet_file"
install -m 600 /dev/null "$secret_key_file"
install -m 600 /dev/null "$bucket_file"

terraform -chdir=infra/yandex/production output -raw station_release_publisher_access_key_id > "$access_key_file"
terraform -chdir=infra/yandex/production output -raw station_release_publisher_encrypted_secret_key > "$encrypted_secret_file"
terraform -chdir=infra/yandex/production output -raw station_release_bucket_name > "$bucket_file"
chmod 600 "$access_key_file" "$encrypted_secret_file" "$bucket_file"
```

Не используйте `terraform output -json`, не сохраняйте output в CI artifact и не
печайте содержимое файлов. Получение выполняется только из защищённого state,
после одобренного apply.

## 4. Расшифровать секрет локально

Расшифруйте только файловым потоком. Private PGP key должен находиться в
локальном защищённом keyring оператора:

```bash
openssl base64 -d -A -in "$encrypted_secret_file" -out "$encrypted_packet_file"
gpg --batch --quiet --decrypt "$encrypted_packet_file" > "$secret_key_file"
chmod 600 "$secret_key_file"
test -s "$access_key_file"
test -s "$secret_key_file"
```

Не используйте command substitution для secret и не экспортируйте его в env.

## 5. Остановиться перед записью GitHub secrets

Сначала вручную убедитесь, что GitHub Environment `station-release` уже создан,
защищён approval и ограничен веткой `main`. Эта задача Environment и secrets не
создаёт.

**STOP 2 — SECRETS.** Получите явное подтверждение release owner, затем введите
маркер и передайте значения только через stdin:

```bash
read -r -p 'Type WRITE-STATION-RELEASE-SECRETS to continue: ' secret_write_confirmation
test "$secret_write_confirmation" = 'WRITE-STATION-RELEASE-SECRETS'
unset secret_write_confirmation

gh secret set YANDEX_STATION_RELEASE_ACCESS_KEY_ID --env station-release < "$access_key_file"
gh secret set YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY --env station-release < "$secret_key_file"
```

Эквивалентно можно вставить значения напрямую в защищённом GitHub UI, не
используя shell. Не передавайте secret через `--body`, `--value`, `NAME=value`
или позиционный аргумент.

Добавьте только две non-secret variables из
`yandex-infrastructure-secrets.md`: `YANDEX_STATION_RELEASE_BUCKET` из
`$bucket_file` и `YANDEX_STATION_RELEASE_ENDPOINT` со значением
`https://storage.yandexcloud.net`. Значения передавайте через GitHub UI или
stdin, а не через аргументы.

Теперь явно подтвердите удаление локального plaintext. Это действие нельзя
заменять автоматическим trap, потому что оператор должен убедиться, что GitHub
принял оба secrets:

```bash
read -r -p 'Type DELETE-PLAINTEXT after GitHub accepted both secrets: ' delete_confirmation
test "$delete_confirmation" = 'DELETE-PLAINTEXT'
rm -f -- "$secret_key_file" "$access_key_file"
unset delete_confirmation
```

Trap удалит оставшиеся зашифрованные вспомогательные файлы и каталог. Если
процедура прервана до подтверждения, trap не удаляет plaintext молча: он
показывает путь к mode-`0600` файлам для осознанного продолжения.

## 6. Проверить разрешения только в release prefix

После удаления локального plaintext запускайте permission probe только из
защищённого release workflow, который читает Environment `station-release`.
Не восстанавливайте credentials локально и не передавайте их workflow input.

Probe обязан использовать фиксированный prefix:

```bash
release_prefix='station/'
```

Разрешены только bounded list/location проверки с `prefix=station/` и операции,
которые выполняет проверенный transactional publisher. Проверка должна отказать
для prefix вне `station/` и для delete. Не используйте `aws s3 sync`, bucket-wide
list, случайный upload или overwrite immutable key. На этом этапе внешний probe
запускается только после отдельного approval; реализация Task 4 его не выполняет.

## 7. Проверить certificate challenge

В Yandex Certificate Manager сравните certificate ID из защищённого Terraform
state с `releases.markiro.app`, проверьте точные DNS challenge records в
управляемой зоне и дождитесь статуса `ISSUED`. Не включайте release CNAME при
статусе `VALIDATING`, `INVALID` или при несовпадении challenge.

Это read-only cloud probe, но он всё равно выполняется оператором отдельно от
реализации и фиксируется в approval record без secret values.

## 8. Засеять baseline и проверить provider host

До DNS activation выполните `seed-baseline` отдельно для `stable` и `beta`.
Только stable seed разрешено прочитать старую GitHub-only stable evidence и
только для rollback baseline. Beta seed уже требует строгую новую origin-aware
GitHub evidence от нового dual-published pre-transition beta; legacy beta
отклоняется до любого store/provider вызова. Обычная beta/stable публикация и
stable promotion также принимают только строгие новые GitHub и Yandex schemas.
Не передавайте команде URL или ожидаемые hashes: она выводит канонические
URL/keys сама и пересчитывает hashes из проверенных файлов.

Seed получает уже скачанный caller-provided acquisition directory. Создайте его
в защищённом release job через `mktemp -d`, скачайте в него ровно семь
канонических assets явно выбранного `source_tag`, а release metadata сохраните
отдельным mode-`0600` regular JSON файлом через:

```bash
gh release view "$source_tag" \
  --json tagName,isDraft,isPrerelease,targetCommitish > "$release_metadata_file"
gh release download "$source_tag" --dir "$github_tree"
chmod 600 "$release_metadata_file"
```

Этот download boundary остаётся в защищённом workflow; сам publisher не
запускает `gh` и не принимает release URL. Каталог должен быть новым, не symlink,
и содержать только канонические release assets. Release metadata и
infrastructure evidence должны быть non-empty regular files не больше 256 KiB;
symlink, extra JSON field или лишний asset останавливают процедуру.

Infrastructure evidence формируется из отдельно одобренного и применённого
DNS-disabled saved plan. У файла точная схема:

```json
{
  "schemaVersion": 1,
  "targetSha": "<40-hex applied main SHA>",
  "planSha256": "<64-hex applied saved-plan SHA-256>",
  "planVersionId": "<exact applied Object Storage VersionId>",
  "enableStationReleasePublicDns": false
}
```

Не заменяйте этот файл environment default и не меняйте boolean вручную после
apply evidence review. Создайте новые абсолютные пути для backup и bootstrap
record, но не создавайте сами targets. Затем выполните точную команду:

```bash
node tools/station-release/yandex-publisher.mjs seed-baseline \
  "$github_tree" \
  "$source_tag" \
  "$release_metadata_file" \
  "$infrastructure_evidence_file" \
  "$channel" \
  "$backup_directory" \
  "$bootstrap_record_file" \
  --confirm-empty-channel-bootstrap
```

`--confirm-empty-channel-bootstrap` — обязательный точный mode token. `true`,
workflow variable или environment value его не заменяют. Команда отказывает,
если release tag/channel/version/source SHA не совпадают, release является
draft или имеет неверный prerelease status, release DNS уже включён, один из
двух mutable keys отсутствует при наличии второго, существующая пара не равна
known-good target или provider-host read-back не подтверждает exact bytes и
metadata.

Publisher строит из проверенного GitHub source две строгие metadata trees вокруг
тех же installer, bundle, detached signature и notes. Он проверяет обе trees и
их равенство, делает preflight всех immutable keys, загружает только отсутствующие
Yandex objects и читает их обратно только через
`https://storage.yandexcloud.net/<bucket>/station/...`. Затем он создаёт и
проверяет пару mutable keys. Повтор после уже завершённой компенсации допустим
только для полной пары, byte-for-byte совпадающей с target; immutable objects при
этом не перезаписываются.

Backup directory и `bootstrap_record_file` создаются эксклюзивно с закрытыми
правами. Record связывает SHA-256 исходной GitHub evidence и release metadata,
обе строгие origin evidence, common installer/bundle/signature/notes, channel,
version, base/release SHA, infrastructure evidence, mutable backup и recovery
result. В нём нет credentials, request/response headers или нового signing key.
Protected workflow загружает record и backup как bounded artifact отдельным
шагом, включая failed job через `if: always()`. Если первая mutable verification
не прошла, но повторное применение complete known-good pair подтвердилось,
команда всё равно завершается ошибкой, а record фиксирует успешную компенсацию.
При `recovery: failed` не включайте DNS и не продолжайте обычную публикацию.

### Порядок initial baselines

Stable и beta — две независимые процедуры и два независимых backup precondition:

- stable seed может зеркалировать текущий явно принятый GitHub-only stable только
  для создания rollback baseline. После проверки `station/download` указывает на
  installer именно этого accepted stable;
- beta baseline нельзя делать retrofit старого immutable beta. В Phase 2 создайте
  новый pre-transition beta через новое dual-publish tooling, оставив runtime
  client GitHub-only, и используйте этот новый release для первичного baseline.
  После seed `station/beta/download` указывает на этот pre-transition beta.

**Integration checkpoint 1 — publication tooling.** Сначала отдельно merge и
разверните Tasks 1–7, создайте оба baseline при release DNS disabled, сохраните
оба protected backup/record artifacts и проверьте provider host. Обычный workflow
конкретного channel остаётся disabled, пока его собственный complete backup
precondition не подтверждён. Завершение кода не публикует release автоматически.

**Integration checkpoint 2 — transitional runtime.** Только после merge Tasks
8–11 опубликуйте новый transitional beta с dual-origin adapter. Beta alias
переходит на этот transitional beta лишь после полной dual-origin publication и
promotion transaction. Stable alias остаётся на принятом stable baseline, пока
transitional beta не пройдёт отдельную Windows/hardware acceptance и не будет
явно выбран для stable rebuild.

Проверьте отсутствие bucket listing, корректные cache/content-disposition
metadata, точные hashes и оба фиксированных manifest keys
`station/beta/latest.json` и `station/stable/latest.json`. Остановитесь при любом
mismatch. Не используйте `releases.markiro.app` до DNS activation и не считайте
Terraform apply доказательством публичной доступности.

## 9. Остановиться перед включением release DNS

**STOP 3 — DNS.** Только после `ISSUED`, успешного seed-baseline и provider-host
public-read проверок запросите отдельное подтверждение владельца
инфраструктуры. Запустите второй отдельно одобренный `mode=plan` с
`enable_station_release_public_dns=true`, сохранив текущее одобренное значение
`enable_public_dns`.

Перед apply убедитесь, что plan меняет только release CNAME и не пересоздаёт
bucket, access key, certificate, CDN, app VM или durable data. Затем запустите
отдельный `mode=apply` с точными `plan_key`, `plan_sha256` и `plan_version_id` и
approve `production-infrastructure-apply`. После DNS
propagation публичные проверки через `https://releases.markiro.app` и проверки
из GitHub-restricted customer network являются отдельными внешними gates.
