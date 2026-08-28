!macro NSIS_HOOK_POSTINSTALL
  ; The tray agent must come back after a reboot without the operator opening
  ; it, so register autostart for the installing user.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MarkiroSigner" "$INSTDIR\Markiro Signer.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MarkiroSigner"
!macroend
