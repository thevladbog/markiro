!macro NSIS_HOOK_POSTINSTALL
  ; The executable path is stable across beta upgrades, so Explorer can retain
  ; the icon from an older build. Notify the shell after shortcuts are replaced.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend
