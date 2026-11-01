# Printer output modes implementation plan

Approved in chat: per-printer normal, peel with label-taken sensor, and cutter;
existing printers retain device configuration, new printers default to normal.

- [x] Domain: test then implement a byte-preserving output-mode envelope for RAW ZPL/TSPL.
      ZPL inserts ^MMT/^MMP/^MMC after ^XA; TSPL disables the competing mode and
      sets SET PEEL ON or SET CUTTER 1. Normal disables both TSPL options.
- [x] Station: retain optional outputMode in profiles, default new forms to normal,
      expose translated selection, freeze commands before digest/prepared persistence.
      Windows-driver profiles keep driver settings. Cover parsing, UI and actual bytes.
- [x] Handheld: Room 25→26 adds nullable mode to profiles and embedded destinations;
      legacy null means printer-controlled. Persist mode in reprint JSON, expose a
      compact translated selector, envelope newly rendered bytes before persistence.
      Saved bytes and unknown-send recovery must remain unchanged. Cover migration,
      view model, mode transitions and working print paths.
- [x] Run domain and Station package gates, Android unit/lint/assemble gates,
      format/diff checks, and independent review. Release and device acceptance remain separate gates.

Hardware acceptance remains manual: 3 modes × 2 languages, test and working labels,
mode switches, label-taken sensor waiting, cutter per label and power-cycle behavior.

## Validation outcome

Domain: 1516 tests; Station: 2362 tests (one worker); Android: 1714 tests,
with no failures or skips reported in these final runs. Domain/Station lint,
typecheck and builds passed. Android lintDebug and assembleDebug passed.
CI affected-job contracts: 31 tests passed. Format and diff checks passed.
Independent source review found no actionable correctness issues.

An earlier concurrent Station run was interrupted after eight failures during
high machine load. Two App cases also failed when loading original HEAD sources.
The subsequent sequential run passed without assertion or timeout changes;
the exact cause of every earlier failure is not established.
Physical printer/TSD/Windows acceptance and deployment were not performed.
