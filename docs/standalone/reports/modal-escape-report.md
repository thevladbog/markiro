# Modal/Drawer Escape fix

Worktree /tmp/claude/wt/modalfix, branch fix/modal-escape-popovers (base cb94c03d4).
Commits: de6ecdcd4 (Modal + tests), ccd673fc9 (Drawer + tests for both).

Root cause: Modal/Drawer handleKeyDown closed on every Escape bubbling to the dialog. Radix
DismissableLayer (document capture) preventDefaults the Escape when it dismisses a popover
(Select, Combobox, DatePicker; verified in react-dismissable-layer/dist/index.mjs), and React
synthetic events bubble through portals, so the same Escape closed the dialog too. Synthetic
event.defaultPrevented mirrors the native flag (React builds it after the capture listener ran).
DatePicker has no own Escape handler (relies on Radix); Combobox input also preventDefaults.

Fix: ignore Escape when event.defaultPrevented or the target is inside [data-mk-nested-overlay]
(same as OverlayLayer). Drawer was affected identically and fixed. SidePanel/ConfirmDialog use
OverlayLayer (already correct); FullScreenDialog already checks defaultPrevented.

Tests: packages/ui/test/modal-escape.test.tsx, describe.each over Modal and Drawer, 6 cases each
(plain Escape closes; already-handled Escape ignored; nested-overlay Escape ignored; Select /
Combobox / DatePicker: first Escape closes only the popover, second closes the dialog).
RED before fix: 10 failed | 2 passed. GREEN after: 12 passed.
Mutants (restored, sha256 verified identical): removing the defaultPrevented line fails
"already handled" (Modal and Drawer); removing the nested-overlay check fails "nested overlay".
Popover cases are covered by either guard, so they only go red when both are removed (the RED run).

Gates: ui test 252 passed, typecheck, lint, build clean; admin focused (12 files, 297 tests with
Escape + Modal/Drawer usage, incl. devices) passed; prettier check clean; git diff --check clean;
tree clean. Not run: kiosk tests (no node_modules in this worktree, no Escape tests there);
apps/standalone does not exist on origin/main.
