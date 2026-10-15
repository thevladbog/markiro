;; Markiro Standalone installer hooks (plan УСТ), included by Tauri's
;; installer.nsi. Saved as UTF-8 with a byte order mark: without one NSIS
;; reads the Russian text in the build machine's ANSI code page.
;;
;; Roles: host (the host service MarkiroHost and the station), station (a
;; station that pairs with a host on another PC), office (the office only:
;; no host, no kiosk mode). The role comes from /ROLE=host|station|office,
;; else from the earlier installation, else from two questions; a silent
;; install without either fails. A role never changes on reinstall: uninstall
;; first. The role goes to HKLM\Software\Markiro\Standalone (Role) for the
;; next installer and to $INSTDIR\installation.json for the app
;; (src-tauri/src/installation.rs): exactly {"role":"host|station|office"},
;; because the app's reader refuses any other key or spelling and then treats
;; the PC as a locked-down station. Neither uninstall nor upgrade deletes
;; %ProgramData%\Markiro\Host or the app's data under %LOCALAPPDATA%; an
;; upgrade stops the running host service first and `install` starts it again.
;; Exit codes of markiro-host used here (host/src/main.rs): install 0 = running,
;; 4 = installed but not staying up or still starting after 30 s (usually an
;; unfinished restore, or a big first migration: a warning with the restore
;; hint), anything else = failure; network-check 3 = a public
;; network remains; address-check 5 = an address by DHCP (a warning only).
;; NSIS `==` ignores case, so roles are mapped to literals.

!define MARKIRO_ROLE_KEY "Software\Markiro\Standalone"
!define MARKIRO_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define MARKIRO_RUN_VALUE "MarkiroStandalone"

Var MarkiroRole

!macro MARKIRO_FAIL message
  MessageBox MB_ICONSTOP "${message}" /SD IDOK
  SetErrorLevel 2
  Abort "${message}"
!macroend

!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $1
  ; The role an earlier installation kept, and the one asked for.
  ClearErrors
  ReadRegStr $1 HKLM "${MARKIRO_ROLE_KEY}" "Role"
  ${If} ${Errors}
    StrCpy $1 ""
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/ROLE=" $0
  ${If} ${Errors}
    StrCpy $0 ""
  ${EndIf}
  ${If} $0 != ""
  ${AndIf} $0 != "host"
  ${AndIf} $0 != "station"
  ${AndIf} $0 != "office"
    !insertmacro MARKIRO_FAIL "Неизвестная роль /ROLE=$0. Допустимо: host, station, office."
  ${EndIf}
  ${If} $0 != ""
  ${AndIf} $1 != ""
  ${AndIf} $0 != $1
    !insertmacro MARKIRO_FAIL "Этот компьютер уже установлен с ролью $1. Роль меняется удалением программы и установкой заново; данные при удалении сохраняются."
  ${EndIf}
  ${If} $0 == ""
    StrCpy $0 $1
  ${EndIf}
  ${If} $0 == ""
  ${AndIf} ${Silent}
    !insertmacro MARKIRO_FAIL "Тихая установка требует роль: /ROLE=host, /ROLE=station или /ROLE=office."
  ${EndIf}
  ${If} $0 == ""
    MessageBox MB_YESNO|MB_ICONQUESTION "На этом компьютере будет работать хост — главная база площадки? Обычно это ПК станции.$\n$\nДа — хост и станция.$\nНет — выбрать другую роль." IDNO markiro_not_host
    StrCpy $0 "host"
    Goto markiro_role_chosen
    markiro_not_host:
    MessageBox MB_YESNO|MB_ICONQUESTION "Этот компьютер — ПК офиса (администратора)?$\n$\nДа — только офис: без хоста и без киоск-режима.$\nНет — только станция: она подключится к хосту на другом ПК." IDNO markiro_station
    StrCpy $0 "office"
    Goto markiro_role_chosen
    markiro_station:
    StrCpy $0 "station"
    markiro_role_chosen:
  ${EndIf}
  ; `==` ignores case: /ROLE=HOST would pass the checks above and be written
  ; as "HOST", which the app does not read. Keep only the exact literals (this
  ; also rejects a damaged value from the registry).
  ${If} $0 == "host"
    StrCpy $0 "host"
  ${ElseIf} $0 == "station"
    StrCpy $0 "station"
  ${ElseIf} $0 == "office"
    StrCpy $0 "office"
  ${Else}
    !insertmacro MARKIRO_FAIL "Роль компьютера не распознана: $0. Допустимо: host, station, office."
  ${EndIf}
  StrCpy $MarkiroRole $0
  DetailPrint "Роль компьютера: $MarkiroRole"
  ; An earlier host service holds its binary: stop it before the files are
  ; replaced (the data stays). `install` below starts it again.
  ${If} ${FileExists} "$INSTDIR\markiro-host.exe"
    nsExec::ExecToLog '"$INSTDIR\markiro-host.exe" stop-service'
    Pop $0
    ${If} $0 != "0"
      DetailPrint "Служба MarkiroHost не остановлена перед обновлением (код $0)."
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1
  WriteRegStr HKLM "${MARKIRO_ROLE_KEY}" "Role" $MarkiroRole
  ; Without this file the app works as a locked-down station, so an office PC
  ; must not be installed without it.
  ClearErrors
  FileOpen $0 "$INSTDIR\installation.json" w
  ${If} ${Errors}
    !insertmacro MARKIRO_FAIL "Не удалось записать $INSTDIR\installation.json: роль компьютера не сохранена."
  ${EndIf}
  FileWrite $0 '{"role":"$MarkiroRole"}$\r$\n'
  FileClose $0
  ${If} $MarkiroRole == "host"
    DetailPrint "Установка службы MarkiroHost…"
    nsExec::ExecToLog '"$INSTDIR\markiro-host.exe" install'
    Pop $0
    ${If} $0 == "4"
      ; Registered, but the host did not stay up, or is still starting after
      ; 30 s: usually a restore from a copy was interrupted and the host
      ; refuses to start until it is repeated, or a big database is still
      ; being migrated. The service and the data stay, so this is a warning.
      DetailPrint "Служба MarkiroHost установлена, но не осталась запущенной или ещё запускается (код 4)."
      MessageBox MB_ICONEXCLAMATION "Служба MarkiroHost установлена, но не осталась запущенной или ещё запускается. Подождите минуту и проверьте её состояние (sc query MarkiroHost). Если служба остановлена, чаще всего не закончено восстановление из копии: остановите службу (sc stop MarkiroHost), повторите markiro-host restore и запустите службу. Данные не тронуты." /SD IDOK
    ${ElseIf} $0 != "0"
      !insertmacro MARKIRO_FAIL "Служба MarkiroHost не установлена (код $0). Подробности — в журнале установки выше."
    ${EndIf}
    nsExec::ExecToLog '"$INSTDIR\markiro-host.exe" network-check'
    Pop $0
    ${If} $0 == "3"
      DetailPrint "Сеть отнесена к общедоступным: порт хоста на ней закрыт."
      ; An update the app started (/P /UPDATE, plan ОБН-2) asks nothing: the
      ; question belongs to the first installation, and the office warns.
      ${IfNot} ${Silent}
      ${AndIf} $UpdateMode <> 1
        MessageBox MB_YESNO|MB_ICONEXCLAMATION "Windows относит сеть этого компьютера к общедоступным, и порт хоста 45710 в ней закрыт: ПК офиса не подключится.$\n$\nПеревести сеть в частную?" IDNO markiro_keep_profile
        nsExec::ExecToLog '"$INSTDIR\markiro-host.exe" network-check --make-private'
        Pop $0
        markiro_keep_profile:
      ${EndIf}
    ${EndIf}
    nsExec::ExecToLog '"$INSTDIR\markiro-host.exe" address-check'
    Pop $0
    ${If} $0 == "5"
      DetailPrint "Адрес этого ПК получен по DHCP и может измениться."
      ; Like the network profile: the question belongs to the first installation, an update the app
      ; started asks nothing, and the office shows the notice until an administrator confirms.
      ${IfNot} ${Silent}
      ${AndIf} $UpdateMode <> 1
        MessageBox MB_OK|MB_ICONINFORMATION "Адрес этого компьютера в сети получен автоматически (DHCP) и может измениться после перезагрузки: ТСД и станции потеряют связь с хостом.$\n$\nЗарезервируйте адрес этого ПК в роутере по MAC-адресу (лучше всего) или задайте статический адрес вне пула DHCP. MAC и текущий адрес покажет офис после установки.$\n$\nУстановка продолжается."
      ${EndIf}
    ${EndIf}
  ${Else}
    ; Only the host role runs the host.
    Delete "$INSTDIR\markiro-host.exe"
  ${EndIf}
  ${If} $MarkiroRole == "office"
    DeleteRegValue HKLM "${MARKIRO_RUN_KEY}" "${MARKIRO_RUN_VALUE}"
  ${Else}
    ; A station opens by itself when anybody signs in to Windows.
    WriteRegStr HKLM "${MARKIRO_RUN_KEY}" "${MARKIRO_RUN_VALUE}" '"$INSTDIR\${MAINBINARYNAME}.exe"'
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Push $0
  Push $1
  ; The app's data under %LOCALAPPDATA% may hold facts the host has not
  ; received yet: never delete it, whatever the checkbox says.
  StrCpy $DeleteAppDataCheckboxState 0
  ${If} ${FileExists} "$INSTDIR\markiro-host.exe"
    ${If} $UpdateMode = 1
      nsExec::ExecToLog '"$INSTDIR\markiro-host.exe" stop-service'
    ${Else}
      nsExec::ExecToLog '"$INSTDIR\markiro-host.exe" uninstall'
    ${EndIf}
    Pop $0
    ${If} $0 != "0"
      DetailPrint "Служба MarkiroHost не остановлена (код $0)."
    ${EndIf}
  ${EndIf}
  ${If} $UpdateMode <> 1
    DeleteRegValue HKLM "${MARKIRO_RUN_KEY}" "${MARKIRO_RUN_VALUE}"
    DeleteRegValue HKLM "${MARKIRO_ROLE_KEY}" "Role"
    DeleteRegKey /ifempty HKLM "${MARKIRO_ROLE_KEY}"
    DeleteRegKey /ifempty HKLM "Software\Markiro"
    Delete "$INSTDIR\installation.json"
  ${EndIf}
  Pop $1
  Pop $0
!macroend
