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

## 1. Подготовить защищённый план без release DNS

На точном SHA текущего `main` запустите **Yandex infrastructure** со значениями
`mode=plan`, `enable_station_release_public_dns=false` и пустыми `plan_key` и
`plan_sha256`. Для `enable_public_dns` укажите его текущее отдельно одобренное
значение: этот gate относится к прямому app VM и не должен измениться из-за
Station release origin.

Просмотрите сохранённый plan. Допустимы только ожидаемые release bucket,
publisher, certificate/challenge и CDN resources. Release CNAME должен
отсутствовать. Запрещены удаление/замена state, media, audit, release bucket,
PostgreSQL или app VM, public list/config доступа к release bucket, delete права
publisher и любые release permissions для app/runtime identity.

Зафиксируйте выданные workflow non-secret `plan_key` и `plan_sha256`. Сам saved
plan находится только в защищённом state bucket и не переносится в GitHub
artifact, лог, summary или локальный файл оператора.

## 2. Остановиться перед первым apply

**STOP 1 — APPLY.** Не запускайте `mode=apply` и не approve Environment
автоматически. Получите явное подтверждение владельца инфраструктуры на
применение именно проверенного saved plan. После подтверждения запустите
отдельный dispatch `mode=apply` с теми же точными SHA и обоими DNS flags, а также
выданными `plan_key` и `plan_sha256`. Одобренный reviewer вручную разрешает apply
в отдельном GitHub Environment `production-infrastructure-apply`. Изменение кода
не заменяет этот approval.

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

До DNS activation выполните отдельную процедуру seed-baseline из следующего
этапа rollout. Она должна использовать явно выбранный accepted release,
проверить immutable objects, создать начальные beta/stable mutable backups и
затем выполнить публичный GET/HEAD read-back только через provider host
`https://storage.yandexcloud.net/<bucket>/station/...`.

Проверьте отсутствие bucket listing, корректные cache/content-disposition
metadata, точные hashes и оба фиксированных ключа `station/beta/latest.json` и
`station/stable/latest.json`. Остановитесь при любом mismatch. Не используйте
`releases.markiro.app` до DNS activation и не считайте Terraform apply
доказательством публичной доступности.

## 9. Остановиться перед включением release DNS

**STOP 3 — DNS.** Только после `ISSUED`, успешного seed-baseline и provider-host
public-read проверок запросите отдельное подтверждение владельца
инфраструктуры. Запустите второй отдельно одобренный `mode=plan` с
`enable_station_release_public_dns=true`, сохранив текущее одобренное значение
`enable_public_dns`.

Перед apply убедитесь, что plan меняет только release CNAME и не пересоздаёт
bucket, access key, certificate, CDN, app VM или durable data. Затем запустите
отдельный `mode=apply` с точными `plan_key` и `plan_sha256` и approve
`production-infrastructure-apply`. После DNS
propagation публичные проверки через `https://releases.markiro.app` и проверки
из GitHub-restricted customer network являются отдельными внешними gates.
