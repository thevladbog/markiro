# Editable design sources

The local design archive contains three `.pen` sources and their existing image
resources. Sources were added on 2026-09-11. Their original bytes, filenames and
relative paths are preserved; the PNG index was first prepared on 2026-09-10.

| Source                                           | Area                                                                | Reference                                            |
| ------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------- |
| [check_with_reprint.pen](check_with_reprint.pen) | Duplicate Data Matrix settings, printing, verification and recovery | [Export index](exports/check-with-reprint/README.md) |
| [markiro-tsd.pen](markiro-tsd.pen)               | Handheld components and workflows                                   | [Handheld design brief](10-tsd-handheld.md)          |
| [markiro-us.pen](us/markiro-us.pen)              | U.S. traceability, Station concept and landing layouts              | [Export index](us/exports/README.md)                 |

Open and edit the native files in Pencil/pen.dev; agents use Pencil MCP. Keep the
image resources beside the sources when copying the archive. Descriptive image
labels are in the export indexes, while the original filenames are retained to
preserve possible canvas references.

These files preserve design work. They do not establish current product behavior,
production deployment, regulatory compliance or hardware acceptance. The relevant
briefs, specifications and acceptance records retain those responsibilities.

MCP inspection in this archiving session returned only the active handheld canvas,
even when another file path was requested. Inspection of all three canvases,
resource resolution and service metadata is therefore not recorded as passed.
The existing local-only exception for `landing.pen` remains unchanged; that file,
production CSV exports and the local `screenshots/lts` gallery are excluded.
