# Printer output modes

Station and handheld RAW profiles offer normal printing, a peeler with a label-taken
sensor, or cutting every label. These choices require the corresponding installed
hardware; Markiro does not detect printer accessories automatically.

New profiles default to normal. Older profiles display “Use printer settings” and
send no mode command until an explicit choice is saved. Ordinary profile edits do
not change that legacy behavior. Changing the mode applies to newly prepared jobs;
prepared bytes and their digests, unknown delivery and recovery evidence are retained.
Windows-driver printing continues to use the driver configuration.

## Protocol

| Mode   | ZPL (inside `^XA…^XZ`) | TSPL (before label commands)     |
| ------ | ---------------------- | -------------------------------- |
| Normal | `^MMT`                 | `SET CUTTER OFF`, `SET PEEL OFF` |
| Peeler | `^MMP`                 | `SET CUTTER OFF`, `SET PEEL ON`  |
| Cutter | `^MMC`                 | `SET PEEL OFF`, `SET CUTTER 1`   |

Commands are included per new label; competing TSPL modes are explicitly disabled.
Raster payloads remain binary and are never decoded/re-encoded to insert commands.
The label-taken sensor controls waiting in the printer; a successful send is still
not proof of a physically printed, taken or verified label. Other applications and
old jobs with no mode commands can use the printer's resulting device setting.

References: [Zebra print modes](https://cpws.zebra.com/cpws/docs/SetUp/Common/Print_Mode.htm),
[ZPL programming guide](https://cpws.zebra.com/cpws/docs/zpl/zpl-zbi2-pm-en.pdf),
and the TSPL/TSPL2 programming manual available from [TSC downloads](https://usca.tscprinters.com/en/downloads).

## Manual acceptance

For each supported printer model/language, use suitable media and installed modules:

1. Upgrade a configured device; confirm legacy settings still print as before.
2. Create a profile; confirm normal is selected. Save, restart and re-open it.
3. Send a test label and working box, pallet and product/warehouse reprint labels
   in each of the three modes. In peel mode, send several labels and verify the
   printer waits for removal before presenting the next label.
4. Switch peel → cutter → normal and back. Confirm no residual cutting or waiting
   in normal mode, and one cut per label in cutter mode. Repeat after power cycling.
5. Prepare a job, change the profile, then recover/reprint: saved mode/bytes must
   remain unchanged. An unknown send must require explicit recovery, never auto-retry.
6. On a compact handheld screen with enlarged text, verify selection/menu scrolling,
   full mode labels and access to the connection check and errors.

Automated byte, migration and UI tests do not establish hardware acceptance.
Shared command fixtures: `pnpm --filter @markiro/domain fixtures:printer-output`.
