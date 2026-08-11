# Восстановление production MVP

## Ошибка релиза

Deploy автоматически делает один rollback к предыдущему healthy digest pair,
если ошибка возникла после prepare. Не повторяйте миграции вручную. Если rollback
не завершился, остановите новые deploy и проверьте release records на app VM.

## Недоступна VM

Сначала проверьте состояние существующей `markiro-production-app` и reserved
public IP. Не создавайте ALB или runner как обходной путь. Восстановите VM из
проверенного образа/диска, сохранив service account, app subnet, security group и
reserved IP, затем запустите обычный deploy exact release.

## PostgreSQL или media

Не удаляйте повреждённый ресурс. Восстановите Managed PostgreSQL из последней
проверенной копии во временный кластер и подтвердите данные до переключения.
Для media используйте версии Object Storage. State bucket и KMS не являются
источниками прикладного восстановления и не должны изменяться.
