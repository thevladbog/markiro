!macro NSIS_HOOK_POSTINSTALL
  ; Keep the existing default (enabled), but never reset an explicit opt-out
  ; during an update or repair. Rust writes this preference alongside Run.
  Push $0
  ClearErrors
  ReadRegDWORD $0 HKCU "Software\Markiro\Signer" "AutostartEnabled"
  ${If} ${Errors}
    StrCpy $0 1
  ${EndIf}
  ${If} $0 = 0
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MarkiroSigner"
  ${Else}
    ; Quote the path to prevent an unquoted-path hijack; update it on repair.
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MarkiroSigner" '"$INSTDIR\${MAINBINARYNAME}.exe"'
  ${EndIf}
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri passes /UPDATE to the uninstaller during upgrades.
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MarkiroSigner"
    DeleteRegValue HKCU "Software\Markiro\Signer" "AutostartEnabled"
    DeleteRegKey /ifempty HKCU "Software\Markiro\Signer"
  ${EndIf}
!macroend
