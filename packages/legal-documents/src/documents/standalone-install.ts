import type { LegalDocumentSource } from "../types.js";

export const STANDALONE_INSTALL_CONTENT = {
  ru: {
    locale: "ru",
    title: "Администрирование: установка и первый запуск",
    summary:
      "Инструкция для того, кто ставит Маркиро Автоном на площадке: роли компьютеров, сеть и постоянный адрес хоста, установка службы хоста, мастер первого запуска, вход в офис, пробный период и файл лицензии, подключение станций и ПК офиса, обновление из файла и что делать, если что-то не так.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает, как системный администратор или владелец площадки устанавливает Маркиро Автоном: выбирает компьютер для главной базы, готовит сеть, ставит программу на каждый компьютер, проходит мастер первого запуска, загружает лицензию и подключает станции и ПК офиса. Работа на станции описана в MKR-INS-01–04, работа в офисе — в MKR-INS-08–10, резервные копии — в MKR-INS-13.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Шаги установщика Windows, службы и брандмауэра снимков не имеют: они выполняются средствами Windows и описаны текстом.",
          },
          {
            kind: "paragraph",
            text: "Регистр букв в именах служб и путях Windows не различает, поэтому имена в командах ниже можно набирать строчными буквами.",
          },
        ],
      },
      {
        id: "requirements",
        heading: "2. Что понадобится",
        blocks: [
          {
            kind: "unordered-list",
            items: [
              "Компьютеры с Windows 10 или 11 (64-разрядные) и учётная запись администратора Windows на каждом.",
              "Одна локальная сеть для всех компьютеров площадки. Интернет программе не нужен.",
              "Установщик Маркиро Автоном одной версии для всех компьютеров площадки.",
              "ИНН организации — на него выдаётся лицензия — и GLN организации: из GLN получается префикс номеров SSCC.",
              "Возможность закрепить за компьютером хоста постоянный IP-адрес в роутере.",
            ],
          },
        ],
      },
      {
        id: "roles",
        heading: "3. Роли компьютеров",
        blocks: [
          {
            kind: "paragraph",
            text: "На площадке ровно один хост — компьютер с главной базой. Обычно это ПК одной из станций. Остальные компьютеры подключаются к нему по локальной сети. Роль выбирается при установке: установщик задаёт два вопроса — будет ли на этом компьютере работать хост и, если нет, это ПК офиса или станция.",
          },
          {
            kind: "table",
            columns: ["Роль", "Что ставится", "Что открывается при запуске"],
            columnRatios: [1, 2, 2],
            rows: [
              [
                "Хост и станция",
                "Служба хоста с главной базой, правило брандмауэра, приложение с автозапуском. Окно приложения не запирается.",
                "Мастер первого запуска, затем «Вход в офис». Кнопка «В цех» открывает станцию этого ПК.",
              ],
              [
                "Только станция",
                "Приложение с автозапуском. После настройки окно станции занимает весь экран и не сворачивается.",
                "Подключение к хосту и выбор линии, затем вход оператора.",
              ],
              [
                "Только офис",
                "Приложение без автозапуска; окно не запирается.",
                "«Вход в офис». Цеха и входа оператора на таком ПК нет.",
              ],
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Не ставьте второй хост на площадке: у двух хостов два набора данных, и станции одной площадки не сойдутся. Чтобы сменить роль компьютера, удалите программу и установите её заново: данные при удалении сохраняются.",
          },
        ],
      },
      {
        id: "network",
        heading: "4. Сеть площадки",
        blocks: [
          {
            kind: "ordered-list",
            items: [
              "Постоянный адрес ПК хоста обязателен. Лучше всего — резервирование адреса в роутере по MAC-адресу сетевого адаптера; иначе — статический адрес вне пула DHCP. Станции, ТСД и ПК офиса хранят адрес хоста: если он изменится, они потеряют связь.",
              "Профиль сети на ПК хоста — частная (или доменная) сеть. Windows часто относит новую сеть Wi-Fi к общедоступным, а порт хоста в такой сети закрыт. Установщик в конце установки хоста проверяет профили и предлагает перевести общедоступную сеть в частную.",
              "Порт хоста — TCP 45710. Установщик сам создаёт входящее правило брандмауэра: частная и доменная сети, только адреса локальной подсети. На станциях и ПК офиса порты открывать не нужно.",
              "К ПК станции лучше протянуть кабель Ethernet: обрыв Wi-Fi тогда не остановит линию.",
              "Проверка с другого компьютера, в PowerShell: Test-NetConnection <адрес ПК хоста> -Port 45710 должен ответить TcpTestSucceeded : True.",
            ],
          },
        ],
      },
      {
        id: "install",
        heading: "5. Установка программы",
        blocks: [
          {
            kind: "paragraph",
            text: "Порядок: сначала ПК хоста, затем ПК офиса, затем остальные станции. Шаги этого раздела выполняются в Windows и снимков не имеют.",
          },
          {
            kind: "step",
            title: "5.1. ПК хоста",
            text: "Запустите установщик от имени администратора. На вопрос, будет ли на этом компьютере работать хост, ответьте «Да». Установщик копирует файлы, регистрирует и запускает службу хоста (ждёт её до 30 секунд), открывает порт 45710 и проверяет профиль сети. Если адрес компьютера получен автоматически, установщик напомнит зарезервировать его — установка при этом продолжается.",
            expected:
              "Команда sc query markirohost в консоли администратора показывает состояние RUNNING.",
          },
          {
            kind: "paragraph",
            text: "Служба хоста запускается вместе с Windows, без входа пользователя, работает от встроенной учётной записи без прав администратора и перезапускается сама после сбоя. Главная база, журналы и резервные копии лежат в %ProgramData%\\markiro\\Host; обычным пользователям компьютера доступа к этой папке нет.",
          },
          {
            kind: "step",
            title: "5.2. ПК офиса",
            text: "Запустите установщик. На первый вопрос ответьте «Нет», на второй — что это ПК офиса («Да»). Служба, правило брандмауэра и автозапуск на таком ПК не создаются.",
          },
          {
            kind: "step",
            title: "5.3. Станция",
            text: "Запустите установщик и ответьте «Нет» на оба вопроса: компьютер станет станцией. Приложение будет запускаться при входе в Windows.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Если установщик предупредил, что служба хоста установлена, но не осталась запущенной, подождите минуту и проверьте её состояние. Чаще всего это незаконченное восстановление из копии: см. MKR-INS-13.",
          },
        ],
      },
      {
        id: "wizard",
        heading: "6. Первый запуск хоста",
        blocks: [
          {
            kind: "paragraph",
            text: "Откройте приложение на ПК хоста ярлыком. При первом запуске открывается мастер «Первый запуск» из шести шагов. Кнопка «Восстановить из Яндекс Диска» над мастером нужна, только если площадка восстанавливается из облачной копии (MKR-INS-13); для новой площадки пройдите мастер.",
          },
          {
            kind: "step",
            title: "6.1. Администратор",
            text: "Задайте «Логин» (3–64 символа: латиница, цифры, точка, дефис, подчёркивание), «Имя и фамилия» и «Пароль» от 8 до 128 символов, затем «Повторите пароль». Администратор управляет организацией, номерами SSCC, линиями, операторами и доступом в офис. Нажмите «Далее».",
            image: { id: "wizard-admin", caption: "Шаг 1 из 6: администратор" },
          },
          {
            kind: "step",
            title: "6.2. Организация",
            text: "Укажите «Название организации», «ИНН» (10 или 12 цифр — на этот ИНН выдаётся лицензия) и «GLN организации» (13 цифр; первые 9 становятся префиксом SSCC). «Префиксы GS1» можно оставить пустыми. Проверьте «Часовой пояс». Эти данные печатаются на этикетках и в формах.",
            image: { id: "wizard-org", caption: "Шаг 2 из 6: организация" },
          },
          {
            kind: "step",
            title: "6.3. Номера SSCC",
            text: "Если SSCC уже печатались другой программой, продолжите её нумерацию: укажите «Следующий номер короба» и «Следующий номер паллеты». Иначе оставьте как есть.",
            image: { id: "wizard-sscc", caption: "Шаг 3 из 6: номера SSCC" },
          },
          {
            kind: "step",
            title: "6.4. Линии",
            text: "Перечислите линии, на которых будут работать станции; «Добавить линию» добавляет ещё одну. Нужна хотя бы одна линия, но не больше 20. Список можно изменить позже в офисе.",
            image: { id: "wizard-lines", caption: "Шаг 4 из 6: линии" },
          },
          {
            kind: "step",
            title: "6.5. Адрес хоста",
            text: "Мастер напоминает: ТСД, станции и ПК офиса находят этот компьютер по IP-адресу. Если адрес уже зарезервирован в роутере или задан статически, отметьте «Я зарезервировал адрес (или задал статический)». Установку это не блокирует: пока пункт не отмечен, офис напоминает о нём плашкой «Адрес хоста может измениться» с кнопкой «Я зарезервировал адрес».",
            image: { id: "wizard-address", caption: "Шаг 5 из 6: адрес хоста" },
          },
          {
            kind: "step",
            title: "6.6. Проверка",
            text: "Проверьте данные. Мастер создаст типовые шаблоны этикеток для коробов, паллет и дубликатов товара. «Установить демо-данные» добавляет демо-товар, коды маркировки и смену, чтобы попробовать программу без сканера и принтера; на рабочей площадке снимите эту отметку — демо-данные удаляются потом кнопкой «Удалить демо-данные» в офисе. Нажмите «Создать».",
            image: { id: "wizard-review", caption: "Шаг 6 из 6: проверка" },
            expected:
              "Открывается «Вход в офис». После создания мастер больше не откроется: всё остальное меняется в офисе.",
          },
        ],
      },
      {
        id: "office",
        heading: "7. Вход в офис",
        blocks: [
          {
            kind: "step",
            title: "Войдите администратором",
            text: "На экране «Вход в офис» введите «Логин» и «Пароль» администратора из мастера и нажмите «Войти». «В цех» открывает станцию этого же ПК. Список «Недавние на этом ПК» хранится только на этом компьютере, паролей и ролей в нём нет.",
            image: { id: "office-login", caption: "Вход в офис на ПК хоста" },
          },
          {
            kind: "step",
            title: "Проверьте обзор",
            text: "Офис открывается на странице «Обзор»: связь с хостом, выпуск, смены, устройства, резервные копии и лицензия. Пока лицензия не загружена, вверху висит плашка пробного периода.",
            image: { id: "overview-trial", caption: "Обзор офиса в пробный период" },
          },
          {
            kind: "paragraph",
            text: "Станция ПК хоста подключается к хосту сама. Назначьте ей линию в разделе «Устройства» кнопкой «Изменить» или выберите линию на самой станции (MKR-INS-04).",
          },
        ],
      },
      {
        id: "license",
        heading: "8. Пробный период и лицензия",
        blocks: [
          {
            kind: "paragraph",
            text: "Пробный период длится 14 дней после завершения мастера первого запуска. Когда он закончится без файла лицензии, новые смены перестанут открываться; начатые смены можно продолжать и закрывать, данные и выгрузки остаются доступны. Лицензия выдаётся на хост и ИНН организации и проверяется без интернета.",
          },
          {
            kind: "step",
            title: "8.1. Откройте раздел «Лицензия»",
            text: "В меню «Сервис» откройте «Информация», раздел «Лицензия»: состояние, «Рабочие места», «Возможности» и «Организация и привязка» — ИНН и «Идентификатор хоста».",
            image: { id: "license-trial", caption: "Лицензия в пробный период" },
          },
          {
            kind: "step",
            title: "8.2. Отправьте запрос на активацию",
            text: "Нажмите «Сохранить запрос на активацию»: программа сохранит файл запроса в папку «Документы» этого ПК. Отправьте файл в Маркиро. Секретов в нём нет. В ответ вы получите файл лицензии с расширением .mklic.",
          },
          {
            kind: "step",
            title: "8.3. Загрузите файл лицензии",
            text: "Нажмите «Загрузить файл лицензии (.mklic)» и выберите файл. Офис покажет «Было → станет»: вид лицензии, срок действия, льготный срок и рабочие места. Нажмите «Загрузить».",
            image: { id: "license-preview", caption: "Файл лицензии выбран: было → станет" },
          },
          {
            kind: "step",
            title: "8.4. Проверьте состояние",
            text: "Раздел «Лицензия» показывает «Действует» и дату окончания; плашка пробного периода исчезает. Сохраните файл лицензии вместе с документами договора.",
            image: { id: "license-loaded", caption: "Лицензия загружена и действует" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Загружать файл лицензии, сохранять запрос на активацию и включать аварийное продление может только администратор. Если ИНН организации в «Профиле организации» изменить, новые смены перестанут открываться, пока ИНН не вернут или не загрузят файл лицензии для нового ИНН. Если срок лицензии истёк, а новый файл ещё не пришёл, кнопка «Открыть новые смены ещё 3 дня» разрешает открывать смены ещё три дня — один раз для каждой лицензии.",
          },
        ],
      },
      {
        id: "devices",
        heading: "9. Подключение станций и ПК офиса",
        blocks: [
          {
            kind: "step",
            title: "Создайте код подключения",
            text: "В офисе откройте «Устройства» и нажмите «Подключить устройство». Окно «Подключение устройства» показывает код для сканера, «Код подключения» из 10 символов, «Отпечаток хоста» и «Адрес хоста». Код действует ограниченное время, «Новый код» создаёт другой; после пяти неверных попыток с любого устройства код перестаёт действовать. Карточку подключения можно распечатать на A4 или A5 кнопками «Печать» и «Скачать PDF».",
            image: {
              id: "devices-pairing",
              caption: "Подключение устройства: код, отпечаток и адрес хоста",
            },
          },
          {
            kind: "step",
            title: "Подключите устройство",
            text: "На станции или ПК офиса приложение показывает «Служба хоста не отвечает» — хоста на этом компьютере нет. Нажмите «Подключиться к хосту в сети», отсканируйте код или введите адрес хоста и код вручную, сверьте отпечаток хоста с экраном офиса. Подробно шаги описаны в MKR-INS-04.",
            expected:
              "Устройство появляется в списке «Устройства»; станция просит выбрать линию, ПК офиса открывает «Вход в офис».",
          },
          {
            kind: "paragraph",
            text: "Станции и ТСД занимают рабочие места лицензии, ПК офиса — нет. Если все места заняты, подключение откажет. Частая причина — прежняя запись этой же станции, переустановленной с новой базой: нажмите у неё «Отозвать» и подключите станцию снова. Работающие станции лицензия не отключает никогда.",
          },
          {
            kind: "paragraph",
            text: "Если адрес хоста всё же изменился, на каждой станции и ПК офиса на экране входа нажмите «Сменить адрес хоста» и введите новый адрес. Приложение примет его, только если по нему отвечает тот же хост; подключение и неотправленные данные сохраняются.",
          },
        ],
      },
      {
        id: "updates",
        heading: "10. Обновление",
        blocks: [
          {
            kind: "paragraph",
            text: "Обновления приходят файлом от Маркиро и не загружаются из интернета автоматически. Для необязательных копий на Яндекс Диск нужен интернет (MKR-INS-13). Пакет обновления — два файла: установщик (.exe) и подписанный манифест (.update.jws). Порядок: сначала ПК хоста, затем станции и ПК офиса, между сменами.",
          },
          {
            kind: "step",
            title: "10.1. Обновите ПК хоста",
            text: "Войдите в офис администратором, откройте «Информация», раздел «Обновление». «Открыть папку» создаёт и открывает папку для пакетов в «Документах» этого ПК; положите туда оба файла или вставьте флешку с ними и нажмите «Искать снова». У найденного пакета нажмите «Проверить» — программа проверит подпись и установщик, — затем «Установить обновление». Windows спросит права администратора; на ПК хоста перед установкой делается резервная копия.",
            image: { id: "update", caption: "Обновление из файла и версии устройств" },
          },
          {
            kind: "step",
            title: "10.2. Обновите остальные компьютеры с хоста",
            text: "У найденного пакета нажмите «Загрузить пакет на хост». Затем на каждой станции и ПК офиса администратор входит в офис, открывает «Информация» → «Обновление» и нажимает «Обновить с хоста», «Скачать с хоста» и «Установить обновление». Таблица «Устройства и версии» показывает, какие устройства уже обновлены.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Программа не ставит версию старее установленной и сообщает, если сначала нужно обновить хост площадки. Если запуск установщика из программы не удался, «Установить вручную» показывает путь к установщику и его SHA-256 для ручной установки.",
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "11. Если что-то не так",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Станции и ПК офиса не находят хост",
                detail:
                  "Проверьте, что ПК хоста включён и адрес не изменился, что сеть на нём частная, и выполните Test-NetConnection на порт 45710 (раздел 4).",
              },
              {
                term: "Служба хоста не работает",
                detail:
                  "В консоли администратора: sc query markirohost — состояние службы; журналы — в папке %ProgramData%\\markiro\\Host\\logs. Повторно зарегистрировать службу можно командой markiro-host install из каталога установки.",
              },
              {
                term: "Окно станции заперто, а выйти нужно",
                detail:
                  "Войдите в офис администратором: окно станет обычным. Если хост недоступен, запустите markiro-standalone.exe из каталога установки с ключом --windowed.",
              },
              {
                term: "ПК офиса подключился не той ролью",
                detail:
                  "Отзовите устройство в «Устройствах», удалите программу, установите её заново с ролью ПК офиса и подключите снова.",
              },
              {
                term: "Нужна помощь поддержки",
                detail:
                  "В «Информация» → «Сведения для поддержки» нажмите «Сформировать и скопировать» и вставьте сведения в письмо. Паролей, PIN, бейджей и ключей в них нет.",
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
    title: "Administration: installation and first start",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Guide for whoever installs Markiro Autonom on a site: computer roles, the network and the host's permanent address, installing the host service, the first-start wizard, signing in to the office, the trial period and the license file, pairing stations and office PCs, updating from a file, and what to do when something goes wrong.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers how a system administrator or the site owner installs Markiro Autonom: chooses the computer for the main database, prepares the network, installs the program on each computer, runs the first-start wizard, loads the license and pairs stations and office PCs. Station work is covered in MKR-INS-01–04, office work in MKR-INS-08–10, backups in MKR-INS-13.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The Markiro Autonom interface is in Russian only. Screen labels are quoted in Russian, with an English translation in brackets. The screenshots use demo data. The Windows installer, service and firewall steps have no screenshots: they are done with Windows tools and described in text.",
          },
          {
            kind: "paragraph",
            text: "Windows does not distinguish letter case in service names and paths, so the names in the commands below can be typed in lower case.",
          },
        ],
      },
      {
        id: "requirements",
        heading: "2. What you need",
        blocks: [
          {
            kind: "unordered-list",
            items: [
              "Computers with 64-bit Windows 10 or 11 and a Windows administrator account on each.",
              "One local network for all computers on the site. The program does not need the internet.",
              "The Markiro Autonom installer of one version for all computers on the site.",
              "The organization's INN (taxpayer number) — the license is issued to it — and the organization's GLN: the SSCC number prefix comes from the GLN.",
              "A way to give the host computer a permanent IP address in the router.",
            ],
          },
        ],
      },
      {
        id: "roles",
        heading: "3. Computer roles",
        blocks: [
          {
            kind: "paragraph",
            text: "A site has exactly one host — the computer with the main database. Usually it is the PC of one of the stations. The other computers connect to it over the local network. The role is chosen during installation: the installer asks two questions — whether the host will run on this computer and, if not, whether it is an office PC or a station.",
          },
          {
            kind: "table",
            columns: ["Role", "What is installed", "What opens on start"],
            columnRatios: [1, 2, 2],
            rows: [
              [
                "Host and station",
                "The host service with the main database, a firewall rule, the app with autostart. The app window is never locked.",
                "The first-start wizard, then “Вход в офис” (Office sign-in). The “В цех” (To the floor) button opens this PC's station.",
              ],
              [
                "Station only",
                "The app with autostart. Once set up, the station window fills the screen and cannot be minimized.",
                "Pairing with the host and choosing the line, then operator sign-in.",
              ],
              [
                "Office only",
                "The app without autostart; the window is never locked.",
                "“Вход в офис” (Office sign-in). Such a PC has no floor and no operator sign-in.",
              ],
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Do not install a second host on a site: two hosts hold two sets of data, and the site's stations will not agree. To change a computer's role, uninstall the program and install it again: data is kept on uninstall.",
          },
        ],
      },
      {
        id: "network",
        heading: "4. Site network",
        blocks: [
          {
            kind: "ordered-list",
            items: [
              "A permanent address for the host PC is mandatory. Best is an address reservation in the router by the network adapter's MAC address; otherwise a static address outside the DHCP pool. Stations, handhelds and office PCs store the host's address: if it changes, they lose the connection.",
              "The network profile on the host PC is private (or a domain network). Windows often treats a new Wi-Fi network as public, and the host's port is closed on such a network. At the end of the host installation the installer checks the profiles and offers to switch a public network to private.",
              "The host port is TCP 45710. The installer itself creates the inbound firewall rule: private and domain networks, local subnet addresses only. No ports need to be opened on stations and office PCs.",
              "An Ethernet cable to the station PC is better: a Wi-Fi drop then does not stop the line.",
              "Check from another computer, in PowerShell: Test-NetConnection <host PC address> -Port 45710 must answer TcpTestSucceeded : True.",
            ],
          },
        ],
      },
      {
        id: "install",
        heading: "5. Installing the program",
        blocks: [
          {
            kind: "paragraph",
            text: "Order: the host PC first, then the office PC, then the other stations. The steps of this section are done in Windows and have no screenshots.",
          },
          {
            kind: "step",
            title: "5.1. Host PC",
            text: "Run the installer as administrator. When asked whether the host will run on this computer, answer “Yes”. The installer copies the files, registers and starts the host service (waiting up to 30 seconds for it), opens port 45710 and checks the network profile. If the computer's address was obtained automatically, the installer reminds you to reserve it — installation continues anyway.",
            expected:
              "The command sc query markirohost in an administrator console shows the RUNNING state.",
          },
          {
            kind: "paragraph",
            text: "The host service starts with Windows, without a user signing in, runs under a built-in account without administrator rights, and restarts by itself after a failure. The main database, logs and backups are in %ProgramData%\\markiro\\Host; ordinary users of the computer have no access to that folder.",
          },
          {
            kind: "step",
            title: "5.2. Office PC",
            text: "Run the installer. Answer “No” to the first question and “Yes” to the second — that this is an office PC. No service, firewall rule or autostart is created on such a PC.",
          },
          {
            kind: "step",
            title: "5.3. Station",
            text: "Run the installer and answer “No” to both questions: the computer becomes a station. The app will start when someone signs in to Windows.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "If the installer warned that the host service was installed but did not stay running, wait a minute and check its state. Most often this is an unfinished restore from a backup: see MKR-INS-13.",
          },
        ],
      },
      {
        id: "wizard",
        heading: "6. The host's first start",
        blocks: [
          {
            kind: "paragraph",
            text: "Open the app on the host PC from its shortcut. On the first start the “Первый запуск” (First start) wizard opens, six steps long. The “Восстановить из Яндекс Диска” (Restore from Yandex Disk) button above the wizard is only for restoring a site from a cloud backup (MKR-INS-13); for a new site, go through the wizard.",
          },
          {
            kind: "step",
            title: "6.1. Administrator",
            text: "Set the “Логин” (Login; 3–64 characters: Latin letters, digits, dot, hyphen, underscore), “Имя и фамилия” (Full name) and a “Пароль” (Password) of 8 to 128 characters, then “Повторите пароль” (Repeat password). The administrator manages the organization, SSCC numbers, lines, operators and office access. Press “Далее” (Next).",
            image: { id: "wizard-admin", caption: "Step 1 of 6: administrator" },
          },
          {
            kind: "step",
            title: "6.2. Organization",
            text: "Enter “Название организации” (Organization name), “ИНН” (INN; 10 or 12 digits — the license is issued to this INN) and “GLN организации” (Organization GLN; 13 digits, the first 9 become the SSCC prefix). “Префиксы GS1” (GS1 prefixes) may stay empty. Check the “Часовой пояс” (Time zone). This data is printed on labels and forms.",
            image: { id: "wizard-org", caption: "Step 2 of 6: organization" },
          },
          {
            kind: "step",
            title: "6.3. SSCC numbers",
            text: "If SSCCs were already printed by another program, continue its numbering: enter “Следующий номер короба” (Next box number) and “Следующий номер паллеты” (Next pallet number). Otherwise leave them as they are.",
            image: { id: "wizard-sscc", caption: "Step 3 of 6: SSCC numbers" },
          },
          {
            kind: "step",
            title: "6.4. Lines",
            text: "List the lines the stations will work on; “Добавить линию” (Add line) adds one more. At least one line is needed, and no more than 20. The list can be changed later in the office.",
            image: { id: "wizard-lines", caption: "Step 4 of 6: lines" },
          },
          {
            kind: "step",
            title: "6.5. Host address",
            text: "The wizard reminds you that handhelds, stations and office PCs find this computer by its IP address. If the address is already reserved in the router or set statically, tick “Я зарезервировал адрес (или задал статический)” (I reserved the address, or set a static one). This does not block installation: until it is ticked, the office reminds you with the “Адрес хоста может измениться” (The host address may change) notice and its “Я зарезервировал адрес” (I reserved the address) button.",
            image: { id: "wizard-address", caption: "Step 5 of 6: host address" },
          },
          {
            kind: "step",
            title: "6.6. Review",
            text: "Check the data. The wizard will create standard label templates for boxes, pallets and product duplicates. “Установить демо-данные” (Install demo data) adds a demo product, marking codes and a shift so you can try the program without a scanner or printer; on a working site untick it — demo data is later removed with the “Удалить демо-данные” (Delete demo data) button in the office. Press “Создать” (Create).",
            image: { id: "wizard-review", caption: "Step 6 of 6: review" },
            expected:
              "“Вход в офис” (Office sign-in) opens. After creation the wizard never opens again: everything else is changed in the office.",
          },
        ],
      },
      {
        id: "office",
        heading: "7. Signing in to the office",
        blocks: [
          {
            kind: "step",
            title: "Sign in as administrator",
            text: "On the “Вход в офис” (Office sign-in) screen enter the administrator's “Логин” (Login) and “Пароль” (Password) from the wizard and press “Войти” (Sign in). “В цех” (To the floor) opens this PC's station. The “Недавние на этом ПК” (Recent on this PC) list is kept on this computer only and holds no passwords or roles.",
            image: { id: "office-login", caption: "Office sign-in on the host PC" },
          },
          {
            kind: "step",
            title: "Check the overview",
            text: "The office opens on “Обзор” (Overview): the host connection, output, shifts, devices, backups and the license. Until the license is loaded, a trial-period notice is shown at the top.",
            image: { id: "overview-trial", caption: "Office overview during the trial" },
          },
          {
            kind: "paragraph",
            text: "The host PC's station connects to the host by itself. Assign it a line under “Устройства” (Devices) with “Изменить” (Edit), or choose the line on the station itself (MKR-INS-04).",
          },
        ],
      },
      {
        id: "license",
        heading: "8. Trial period and license",
        blocks: [
          {
            kind: "paragraph",
            text: "The trial period lasts 14 days after completing the first-start wizard. When it ends without a license file, new shifts stop opening; shifts already started can be continued and closed, and data and exports stay available. The license is issued to the host and the organization's INN and is checked without the internet.",
          },
          {
            kind: "step",
            title: "8.1. Open the “Лицензия” (License) section",
            text: "In the “Сервис” (Service) menu open “Информация” (Information), section “Лицензия” (License): the state, “Рабочие места” (Seats), “Возможности” (Features) and “Организация и привязка” (Organization and binding) — the INN and the “Идентификатор хоста” (Host ID).",
            image: { id: "license-trial", caption: "License during the trial" },
          },
          {
            kind: "step",
            title: "8.2. Send the activation request",
            text: "Press “Сохранить запрос на активацию” (Save activation request): the program saves the request file to this PC's Documents folder. Send the file to Markiro. It contains no secrets. In return you receive a license file with the .mklic extension.",
          },
          {
            kind: "step",
            title: "8.3. Load the license file",
            text: "Press “Загрузить файл лицензии (.mklic)” (Load license file) and choose the file. The office shows “Было → станет” (Before → after): the license type, validity, grace period and seats. Press “Загрузить” (Load).",
            image: { id: "license-preview", caption: "License file chosen: before → after" },
          },
          {
            kind: "step",
            title: "8.4. Check the state",
            text: "The “Лицензия” (License) section shows “Действует” (Active) and the end date; the trial notice disappears. Keep the license file with the contract documents.",
            image: { id: "license-loaded", caption: "License loaded and active" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Only an administrator can load the license file, save the activation request and turn on the emergency extension. If the organization's INN is changed in “Профиль организации” (Organization profile), new shifts stop opening until the INN is restored or a license file for the new INN is loaded. If the license has expired and the new file has not arrived yet, the “Открыть новые смены ещё 3 дня” (Open new shifts for 3 more days) button allows opening shifts for three more days — once per license.",
          },
        ],
      },
      {
        id: "devices",
        heading: "9. Pairing stations and office PCs",
        blocks: [
          {
            kind: "step",
            title: "Create a pairing code",
            text: "In the office open “Устройства” (Devices) and press “Подключить устройство” (Pair a device). The “Подключение устройства” (Device pairing) window shows a code for the scanner, the 10-character “Код подключения” (Pairing code), the “Отпечаток хоста” (Host fingerprint) and the “Адрес хоста” (Host address). The code is valid for a limited time, and “Новый код” (New code) creates another one; after five wrong attempts from any device the code stops working. The pairing card can be printed on A4 or A5 with “Печать” (Print) and “Скачать PDF” (Download PDF).",
            image: {
              id: "devices-pairing",
              caption: "Device pairing: code, fingerprint and host address",
            },
          },
          {
            kind: "step",
            title: "Pair the device",
            text: "On a station or office PC the app shows “Служба хоста не отвечает” (The host service is not responding) — there is no host on that computer. Press “Подключиться к хосту в сети” (Connect to a host on the network), scan the code or type the host address and code by hand, and compare the host fingerprint with the office screen. The steps are described in detail in MKR-INS-04.",
            expected:
              "The device appears in the “Устройства” (Devices) list; a station asks for its line, an office PC opens “Вход в офис” (Office sign-in).",
          },
          {
            kind: "paragraph",
            text: "Stations and handhelds take license seats; office PCs do not. When all seats are taken, pairing is refused. A common cause is an old record of the same station, reinstalled with a new database: press “Отозвать” (Revoke) on it and pair the station again. The license never disconnects stations that are working.",
          },
          {
            kind: "paragraph",
            text: "If the host's address did change after all, on each station and office PC press “Сменить адрес хоста” (Change host address) on the sign-in screen and enter the new address. The app accepts it only if the same host answers there; the pairing and unsent data are kept.",
          },
        ],
      },
      {
        id: "updates",
        heading: "10. Updating",
        blocks: [
          {
            kind: "paragraph",
            text: "Updates come as a file from Markiro and are not downloaded automatically from the internet. Optional Yandex Disk backups require internet access (MKR-INS-13). An update package is two files: the installer (.exe) and the signed manifest (.update.jws). Order: the host PC first, then stations and office PCs, between shifts.",
          },
          {
            kind: "step",
            title: "10.1. Update the host PC",
            text: "Sign in to the office as administrator and open “Информация” (Information), section “Обновление” (Update). “Открыть папку” (Open folder) creates and opens the packages folder in this PC's Documents; put both files there, or insert a USB stick with them, and press “Искать снова” (Search again). On the package found press “Проверить” (Check) — the program checks the signature and the installer — then “Установить обновление” (Install update). Windows asks for administrator rights; on the host PC a backup is made before installation.",
            image: { id: "update", caption: "Updating from a file and device versions" },
          },
          {
            kind: "step",
            title: "10.2. Update the other computers from the host",
            text: "On the package found press “Загрузить пакет на хост” (Upload package to host). Then on each station and office PC an administrator signs in to the office, opens “Информация” (Information) → “Обновление” (Update) and presses “Обновить с хоста” (Update from host), “Скачать с хоста” (Download from host) and “Установить обновление” (Install update). The “Устройства и версии” (Devices and versions) table shows which devices are already updated.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The program does not install a version older than the installed one, and says so when the site's host must be updated first. If launching the installer from the program failed, “Установить вручную” (Install manually) shows the installer's path and its SHA-256 for a manual installation.",
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "11. When something goes wrong",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Stations and office PCs cannot find the host",
                detail:
                  "Check that the host PC is on and its address has not changed, that its network is private, and run Test-NetConnection on port 45710 (section 4).",
              },
              {
                term: "The host service is not running",
                detail:
                  "In an administrator console: sc query markirohost shows the service state; logs are in %ProgramData%\\markiro\\Host\\logs. The service can be registered again with markiro-host install from the installation folder.",
              },
              {
                term: "The station window is locked and you need to leave it",
                detail:
                  "Sign in to the office as administrator: the window becomes ordinary. If the host is unreachable, start markiro-standalone.exe from the installation folder with the --windowed switch.",
              },
              {
                term: "An office PC was paired with the wrong role",
                detail:
                  "Revoke the device under “Устройства” (Devices), uninstall the program, install it again with the office PC role and pair it again.",
              },
              {
                term: "You need help from support",
                detail:
                  "In “Информация” (Information) → “Сведения для поддержки” (Support details) press “Сформировать и скопировать” (Build and copy) and paste the details into an email. They contain no passwords, PINs, badges or keys.",
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
