!macro NSIS_HOOK_POSTINSTALL
  ; The tray agent must come back after a reboot without the operator opening
  ; it, so register autostart for the installing user. The value must be
  ; quoted: $INSTDIR contains a space ("Markiro Signer"), and CreateProcess
  ; resolves an unquoted path by trying successively longer prefixes at each
  ; space -- e.g. "...\Markiro.exe" before "...\Markiro Signer.exe" -- the
  ; textbook unquoted-path hijack.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MarkiroSigner" '"$INSTDIR\Markiro Signer.exe"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MarkiroSigner"
!macroend
