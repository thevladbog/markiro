import type { LegalDocumentSource } from "../types.js";

export const STANDALONE_BACKUPS_CONTENT = {
  ru: {
    locale: "ru",
    title: "Администрирование: резервные копии и восстановление",
    summary:
      "Инструкция администратора Маркиро Автоном: что хост копирует сам, копия по кнопке, вторая папка и Яндекс Диск, еженедельная проверка, когда и как восстанавливать базу хоста на том же или новом компьютере и как возобновить приём данных станций после восстановления.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает резервные копии главной базы Маркиро Автоном: что хост делает сам, что настраивает администратор и как проходит восстановление. Установка программы описана в MKR-INS-12.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Копия содержит всё, что знает хост: хеши паролей, PIN и бейджей, а рядом с копией лежит файл с ключом хоста. Не пересылайте копии почтой и мессенджерами; папки с копиями должны быть закрыты от посторонних, флешку с копией храните в сейфе.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Команды восстановления выполняются в консоли Windows на компьютере хоста и снимков не имеют.",
          },
        ],
      },
      {
        id: "automatic",
        heading: "2. Что хост делает сам",
        blocks: [
          {
            kind: "unordered-list",
            items: [
              "Делает копию в первую минуту часа, если база изменилась после прошлой удачной копии, — не чаще раза в час; хотя бы одну копию в сутки, даже если база не менялась; и копию при каждом запуске службы хоста.",
              "Проверяет каждую копию на целостность и пишет рядом её контрольную сумму. Копия, не прошедшая проверку, удаляется.",
              "Хранит в каждой папке 24 последние копии, последнюю копию каждого из 14 последних дней и каждого из 12 последних месяцев. Более старые копии удаляет сам.",
              "Кладёт рядом с копией файл с ключом хоста. С ним восстановленный на новом компьютере хост остаётся для станций тем же хостом.",
            ],
          },
          {
            kind: "step",
            title: "Проверьте страницу «Резервные копии»",
            text: "В меню «Сервис» откройте «Резервные копии». «Папка на компьютере хоста» показывает «Последняя проверенная копия» и «Последняя попытка». Ниже — «Копии на компьютере хоста»: когда сделана, «Как» («По расписанию» или «Вручную»), размер и «Ключ хоста» — «есть» или «нет».",
            image: {
              id: "backups",
              caption: "Резервные копии: папка на компьютере хоста и список копий",
            },
          },
          {
            kind: "paragraph",
            text: "Свободное место на диске хост заранее не проверяет: если диск заполнен, копия не удастся, а последняя хорошая копия останется. Следите за местом на диске компьютера хоста и второй папки сами.",
          },
        ],
      },
      {
        id: "manual",
        heading: "3. Копия по кнопке",
        blocks: [
          {
            kind: "step",
            title: "Сделайте копию сейчас",
            text: "Нажмите «Сделать копию сейчас» — например, перед заменой компьютера хоста или перед обновлением. Сделать копию вручную может только администратор.",
            image: { id: "backup-now", caption: "Копия сделана и проверена" },
            expected: "Появляется «Копия сделана и проверена.», в списке — копия «Вручную».",
          },
        ],
      },
      {
        id: "second-folder",
        heading: "4. Вторая папка",
        blocks: [
          {
            kind: "paragraph",
            text: "Если сломается компьютер хоста, копий в его папке не останется. Поэтому задайте вторую папку — на другом компьютере или на флешке. После каждой проверенной копии хост копирует её туда и проверяет.",
          },
          {
            kind: "step",
            title: "Укажите вторую папку",
            text: "В блоке «Вторая папка» заполните «Путь ко второй папке» или нажмите «Выбрать папку…», затем «Сохранить». Хост проверит папку перед сохранением. «Не копировать во вторую папку» отключает её.",
            image: { id: "second-folder", caption: "Путь ко второй папке" },
          },
          {
            kind: "unordered-list",
            items: [
              "Общую папку на другом компьютере указывайте полным сетевым путём (\\\\ПК-АДМИНИСТРАТОРА\\Копии), а не буквой сетевого диска: служба хоста не видит дисков, подключённых пользователем.",
              "Служба хоста пишет в общую папку от имени своей учётной записи. В рабочей группе без домена встроенной учётной записи службы обычно не хватает прав на чужую общую папку — офис покажет «у службы хоста нет прав на запись». Учётную запись службы и права на папку настраивает ИТ площадки.",
              "На флешке FAT32 или exFAT хост не может закрыть файл ключа от посторонних и копирует без него: офис предупредит, что рядом с копией нет ключа хоста. Для переноса на новый компьютер берите копию с компьютера хоста или из папки на диске NTFS.",
            ],
          },
        ],
      },
      {
        id: "yandex",
        heading: "5. Яндекс Диск",
        blocks: [
          {
            kind: "paragraph",
            text: "Копии можно дополнительно отправлять на Яндекс Диск. Это необязательно; копии отправляет служба хоста напрямую в Яндекс, серверы Маркиро не участвуют. Подключение Яндекс Диска настраивайте вместе с инженером Маркиро.",
          },
          {
            kind: "step",
            title: "Подключите Яндекс Диск",
            text: "В аккаунте Яндекса предприятия создайте собственное приложение для авторизации пользователей: кнопка «Открыть Яндекс OAuth» открывает кабинет Яндекса, а нужные адрес возврата и права указаны прямо на карточке. Введите ClientID приложения, отметьте согласие и нажмите «Подключить / заменить ClientSecret». «Экспорт профиля» сохраняет профиль подключения без секретов: для восстановления из Яндекс Диска нужен прежний ClientID.",
            image: { id: "yandex", caption: "Карточка «Яндекс Диск» на странице резервных копий" },
          },
          {
            kind: "paragraph",
            text: "Отключение («Отключить Яндекс Диск») удаляет данные входа с хоста, но архивы в облаке сохраняются. Доступ приложения можно отозвать в Яндексе.",
          },
        ],
      },
      {
        id: "weekly",
        heading: "6. Еженедельная проверка",
        blocks: [
          {
            kind: "ordered-list",
            items: [
              "Откройте «Резервные копии»: предупреждений нет, последняя проверенная копия в обеих папках не старше суток.",
              "Сделайте копию на флешку и храните её отдельно от компьютера хоста.",
              "Проверьте свободное место на диске компьютера хоста и второй папки.",
              "Раз в месяц сделайте вместе с инженером учебное восстановление на другом компьютере.",
            ],
          },
        ],
      },
      {
        id: "when",
        heading: "7. Когда восстанавливать и что теряется",
        blocks: [
          {
            kind: "paragraph",
            text: "Восстанавливают базу хоста, когда она испорчена и хост не запускается, когда компьютер хоста заменён (сломался диск, компьютер украден) или когда данные испорчены по ошибке и исправить их в офисе нельзя. Берите самую свежую проверенную копию: станции хранят свои подтверждённые записи 30 дней и после восстановления отправят их хосту снова, а копия старше 30 дней опасна.",
          },
          {
            kind: "paragraph",
            text: "Восстановление не возвращает того, что изменили в офисе после копии: операторов, бейджи, товары, шаблоны, линии, пользователей офиса, подключённые после копии устройства, смены, созданные или открытые после копии, и смену паролей и PIN. Запишите это заранее.",
          },
        ],
      },
      {
        id: "restore",
        heading: "8. Восстановление",
        blocks: [
          {
            kind: "paragraph",
            text: "Копию возвращает поддержка или инженер Маркиро, на компьютере хоста. Пока хост остановлен, станции продолжают работать и копят записи у себя. Перед восстановлением все компьютеры площадки должны стоять на той же версии программы, что и хост.",
          },
          {
            kind: "step",
            title: "Из папки с копиями",
            text: "Порядок показан на странице «Резервные копии» в блоке «Восстановление»: остановить службу хоста, выполнить markiro-host restore с файлом копии (рядом с ним должен лежать файл .json с тем же именем) и снова запустить службу. Текущая база сохраняется рядом; хост поднимает счётчики SSCC и номера смен с запасом.",
            image: { id: "restore-help", caption: "Блок «Восстановление»: порядок для поддержки" },
          },
          {
            kind: "paragraph",
            text: "На новом компьютере — те же шаги: установите программу с ролью хоста и не проходите мастер первого запуска. Копия с ключом хоста сохраняет подключение станций и ПК офиса: им нужен только новый адрес хоста («Сменить адрес хоста» на экране входа), а лучше всего дать новому компьютеру адрес старого. Без ключа хоста все устройства подключаются заново.",
          },
          {
            kind: "step",
            title: "Из Яндекс Диска",
            text: "На новом компьютере хоста мастер первого запуска показывает кнопку «Восстановить из Яндекс Диска». Нажмите «Восстановить из Яндекс Диска». Введите ClientID приложения, с которым создавались копии, или загрузите сохранённый профиль кнопкой «Импорт профиля». Затем нажмите «Войти в Яндекс», выберите предприятие и дату копии («Выберите предприятие и дату копии»), нажмите «Скачать и проверить», подтвердите «Старый хост выключен и не будет запущен одновременно» и нажмите «Восстановить на этом ПК». Новое предприятие на этом компьютере создавать не нужно.",
            image: {
              id: "wizard-restore",
              caption: "Мастер первого запуска с кнопкой восстановления из Яндекс Диска",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Старый компьютер хоста, если он ожил, не включайте как хост: два хоста с одним ключом в одной сети сбивают станции с толку. Службу хоста на нём нужно остановить и программу с ролью хоста удалить.",
          },
        ],
      },
      {
        id: "resume",
        heading: "9. После восстановления",
        blocks: [
          {
            kind: "step",
            title: "Хост держит приём данных станций",
            text: "После восстановления хост не принимает данные станций, пока администратор не возобновит приём. На странице «Резервные копии» появляется блок «Приём данных станций остановлен»: с какого времени, эпоха восстановления и список станций. Станции, выйдя на связь, сами возвращают хосту свои блоки SSCC — в столбце «Блоки SSCC» тогда «Вернула», иначе «Не вернула».",
            image: { id: "hold", caption: "Приём данных станций остановлен после восстановления" },
          },
          {
            kind: "step",
            title: "Возобновите приём после проверок",
            text: "Вместе с инженером сверьте счётчики SSCC, номера смен, отзывы устройств, операторов и пользователей офиса, сделанные после копии, и станции, подключённые после копии. Затем нажмите «Возобновить приём данных станций», отметьте подтверждение проверок и нажмите «Возобновить приём данных станций» в окне. Возобновить приём может только администратор.",
            image: { id: "hold-confirm", caption: "Подтверждение возобновления приёма" },
          },
        ],
      },
      {
        id: "warnings",
        heading: "10. Предупреждения",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Проверенных копий ещё нет",
                detail: "Нажмите «Сделать копию сейчас» и убедитесь, что копия появилась в списке.",
              },
              {
                term: "Последней проверенной копии больше суток",
                detail:
                  "Проверьте, что служба хоста работает и что на диске есть место; сделайте копию вручную.",
              },
              {
                term: "Копия во вторую папку не удалась",
                detail:
                  "Офис называет причину: «папка недоступна», «у службы хоста нет прав на запись», «диск заполнен». Проверьте, что компьютер или флешка со второй папкой подключены, и права учётной записи службы.",
              },
              {
                term: "Рядом с копией нет ключа хоста",
                detail:
                  "Такая копия на новом компьютере потребует подключить все устройства заново. Сделайте копию сейчас; если предупреждение не уходит, обратитесь в поддержку.",
              },
              {
                term: "Часы компьютера хоста отстают",
                detail:
                  "Исправьте дату и время Windows на компьютере хоста и не переводите часы назад: расписание и хранение копий работают по часам хоста.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "Если проблема не описана выше, обратитесь в поддержку Маркиро: hello@v-b.tech.",
          },
        ],
      },
    ],
  },
  en: {
    locale: "en",
    title: "Administration: backups and restore",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Markiro Autonom administrator guide: what the host copies by itself, a copy on request, the second folder and Yandex Disk, the weekly check, when and how the host database is restored on the same or a new computer, and how to resume accepting station data after a restore.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers backups of the Markiro Autonom main database: what the host does by itself, what the administrator sets up and how a restore goes. Installing the program is covered in MKR-INS-12.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "A backup holds everything the host knows: hashes of passwords, PINs and badges, and a file with the host's key lies beside the copy. Do not send copies by email or messengers; folders with copies must be closed to outsiders, and a USB stick with a copy belongs in a safe.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The Markiro Autonom interface is in Russian only. Screen labels are quoted in Russian, with an English translation in brackets. The screenshots use demo data. The restore commands run in a Windows console on the host computer and have no screenshots.",
          },
        ],
      },
      {
        id: "automatic",
        heading: "2. What the host does by itself",
        blocks: [
          {
            kind: "unordered-list",
            items: [
              "It makes a copy in the first minute of an hour if the database changed after the last successful copy — no more than once an hour; at least one copy a day, even if the database did not change; and a copy at every start of the host service.",
              "It checks every copy for integrity and writes its checksum beside it. A copy that fails the check is deleted.",
              "In each folder it keeps the 24 newest copies, the newest copy of each of the last 14 days and of each of the last 12 months. It deletes older copies by itself.",
              "It puts a file with the host's key beside the copy. With it, a host restored on a new computer stays the same host for the stations.",
            ],
          },
          {
            kind: "step",
            title: "Check the “Резервные копии” (Backups) page",
            text: "In the “Сервис” (Service) menu open “Резервные копии” (Backups). “Папка на компьютере хоста” (Folder on the host computer) shows the “Последняя проверенная копия” (Latest verified copy) and the “Последняя попытка” (Latest attempt). Below is “Копии на компьютере хоста” (Copies on the host computer): when made, “Как” (How — “По расписанию”, scheduled, or “Вручную”, manual), the size and “Ключ хоста” (Host key) — “есть” (present) or “нет” (absent).",
            image: {
              id: "backups",
              caption: "Backups: the folder on the host computer and the list of copies",
            },
          },
          {
            kind: "paragraph",
            text: "The host does not check free disk space in advance: when the disk is full the copy fails and the last good copy stays. Watch the free space on the host computer's disk and in the second folder yourself.",
          },
        ],
      },
      {
        id: "manual",
        heading: "3. A copy on request",
        blocks: [
          {
            kind: "step",
            title: "Make a copy now",
            text: "Press “Сделать копию сейчас” (Make a copy now) — for example before replacing the host computer or before an update. Only an administrator can make a copy by hand.",
            image: { id: "backup-now", caption: "The copy is made and verified" },
            expected:
              "“Копия сделана и проверена.” (The copy is made and verified.) appears, and the list shows a “Вручную” (Manual) copy.",
          },
        ],
      },
      {
        id: "second-folder",
        heading: "4. The second folder",
        blocks: [
          {
            kind: "paragraph",
            text: "If the host computer breaks, no copies will be left in its folder. So set a second folder — on another computer or on a USB stick. After each verified copy the host copies it there and checks it.",
          },
          {
            kind: "step",
            title: "Set the second folder",
            text: "In the “Вторая папка” (Second folder) block fill in “Путь ко второй папке” (Path to the second folder) or press “Выбрать папку…” (Choose folder…), then “Сохранить” (Save). The host checks the folder before saving. “Не копировать во вторую папку” (Do not copy to the second folder) turns it off.",
            image: { id: "second-folder", caption: "Path to the second folder" },
          },
          {
            kind: "unordered-list",
            items: [
              "Give a shared folder on another computer as a full network path (\\\\ADMIN-PC\\Copies), not as a mapped drive letter: the host service does not see drives mapped by a user.",
              "The host service writes to a shared folder under its own account. In a workgroup without a domain, the service's built-in account usually lacks rights to another computer's shared folder — the office then shows “у службы хоста нет прав на запись” (the host service has no write permission). The site's IT sets up the service account and the folder's permissions.",
              "On a FAT32 or exFAT USB stick the host cannot close the key file to outsiders and copies without it: the office warns that there is no host key beside the copy. To move to a new computer, take a copy from the host computer or from a folder on an NTFS disk.",
            ],
          },
        ],
      },
      {
        id: "yandex",
        heading: "5. Yandex Disk",
        blocks: [
          {
            kind: "paragraph",
            text: "Copies can also be sent to Yandex Disk. This is optional; the host service sends copies directly to Yandex, and Markiro servers take no part. Set up Yandex Disk together with a Markiro engineer.",
          },
          {
            kind: "step",
            title: "Connect Yandex Disk",
            text: "In the enterprise's Yandex account create its own application for user authorization: the “Открыть Яндекс OAuth” (Open Yandex OAuth) button opens the Yandex console, and the required return address and permissions are given right on the card. Enter the application's ClientID, tick the consent and press “Подключить / заменить ClientSecret” (Connect / replace ClientSecret). “Экспорт профиля” (Export profile) saves the connection profile without secrets: restoring from Yandex Disk needs the same ClientID.",
            image: { id: "yandex", caption: "The Yandex Disk card on the backups page" },
          },
          {
            kind: "paragraph",
            text: "Disconnecting (“Отключить Яндекс Диск”, Disconnect Yandex Disk) deletes the sign-in data from the host, but the archives in the cloud are kept. The application's access can be revoked in Yandex.",
          },
        ],
      },
      {
        id: "weekly",
        heading: "6. Weekly check",
        blocks: [
          {
            kind: "ordered-list",
            items: [
              "Open “Резервные копии” (Backups): there are no warnings, and the latest verified copy in both folders is less than a day old.",
              "Make a copy on a USB stick and keep it away from the host computer.",
              "Check the free space on the host computer's disk and in the second folder.",
              "Once a month do a practice restore on another computer together with an engineer.",
            ],
          },
        ],
      },
      {
        id: "when",
        heading: "7. When to restore and what is lost",
        blocks: [
          {
            kind: "paragraph",
            text: "The host database is restored when it is damaged and the host does not start, when the host computer is replaced (the disk failed, the computer was stolen), or when data was damaged by mistake and cannot be fixed in the office. Take the freshest verified copy: stations keep their confirmed records for 30 days and send them to the host again after a restore, and a copy older than 30 days is dangerous.",
          },
          {
            kind: "paragraph",
            text: "A restore does not bring back what was changed in the office after the copy: operators, badges, products, templates, lines, office users, devices paired after the copy, shifts created or opened after the copy, and password and PIN changes. Write them down beforehand.",
          },
        ],
      },
      {
        id: "restore",
        heading: "8. Restoring",
        blocks: [
          {
            kind: "paragraph",
            text: "Markiro support or an engineer restores the copy, on the host computer. While the host is stopped, stations keep working and store their records locally. Before a restore, all computers of the site must run the same program version as the host.",
          },
          {
            kind: "step",
            title: "From the backups folder",
            text: "The order is shown on the “Резервные копии” (Backups) page in the “Восстановление” (Restore) block: stop the host service, run markiro-host restore with the copy file (a .json file with the same name must lie beside it) and start the service again. The current database is kept beside it; the host raises the SSCC counters and shift numbers with a margin.",
            image: { id: "restore-help", caption: "The Restore block: the order for support" },
          },
          {
            kind: "paragraph",
            text: "On a new computer the steps are the same: install the program with the host role and do not go through the first-start wizard. A copy with the host key keeps the pairing of stations and office PCs: they only need the new host address (“Сменить адрес хоста”, Change host address, on the sign-in screen), and best of all the new computer gets the old one's address. Without the host key, every device is paired again.",
          },
          {
            kind: "step",
            title: "From Yandex Disk",
            text: "On a new host computer the first-start wizard shows the “Восстановить из Яндекс Диска” (Restore from Yandex Disk) button. Press “Восстановить из Яндекс Диска” (Restore from Yandex Disk). Enter the ClientID of the application used to create the backups, or load the saved profile with “Импорт профиля” (Import profile). Then press “Войти в Яндекс” (Sign in to Yandex), choose the enterprise and the copy date (“Выберите предприятие и дату копии”), press “Скачать и проверить” (Download and check), confirm “Старый хост выключен и не будет запущен одновременно” (The old host is off and will not run at the same time) and press “Восстановить на этом ПК” (Restore on this PC). There is no need to create a new enterprise on this computer.",
            image: {
              id: "wizard-restore",
              caption: "The first-start wizard with the restore from Yandex Disk button",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "If the old host computer comes back to life, do not run it as a host: two hosts with one key on one network confuse the stations. Stop the host service on it and uninstall the program with the host role.",
          },
        ],
      },
      {
        id: "resume",
        heading: "9. After the restore",
        blocks: [
          {
            kind: "step",
            title: "The host holds the stations' data",
            text: "After a restore the host does not accept station data until an administrator resumes it. The “Резервные копии” (Backups) page shows the “Приём данных станций остановлен” (Accepting station data is stopped) block: since when, the restore epoch and the list of stations. Stations that come online return their SSCC blocks to the host themselves — the “Блоки SSCC” (SSCC blocks) column then reads “Вернула” (Returned), otherwise “Не вернула” (Not returned).",
            image: { id: "hold", caption: "Accepting station data is stopped after the restore" },
          },
          {
            kind: "step",
            title: "Resume after the checks",
            text: "Together with an engineer, check the SSCC counters, the shift numbers, the revocations of devices, operators and office users made after the copy, and the stations paired after the copy. Then press “Возобновить приём данных станций” (Resume accepting station data), tick the confirmation of the checks and press “Возобновить приём данных станций” in the window. Only an administrator can resume.",
            image: { id: "hold-confirm", caption: "Confirming the resume" },
          },
        ],
      },
      {
        id: "warnings",
        heading: "10. Warnings",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "No verified copies yet",
                detail:
                  "Press “Сделать копию сейчас” (Make a copy now) and make sure the copy appears in the list.",
              },
              {
                term: "The latest verified copy is more than a day old",
                detail:
                  "Check that the host service is running and that there is space on the disk; make a copy by hand.",
              },
              {
                term: "Copying to the second folder failed",
                detail:
                  "The office names the reason: “папка недоступна” (folder unavailable), “у службы хоста нет прав на запись” (the host service has no write permission), “диск заполнен” (disk full). Check that the computer or USB stick with the second folder is connected, and the service account's permissions.",
              },
              {
                term: "There is no host key beside the copy",
                detail:
                  "On a new computer such a copy will require pairing every device again. Make a copy now; if the warning stays, contact support.",
              },
              {
                term: "The host computer's clock is behind",
                detail:
                  "Fix the Windows date and time on the host computer and do not set the clock back: the backup schedule and retention follow the host's clock.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "If the problem is not described above, contact Markiro support: hello@v-b.tech.",
          },
        ],
      },
    ],
  },
} as const satisfies LegalDocumentSource["content"];
