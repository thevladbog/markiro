# U.S. design baseline

Status: implementation reference, 2026-09-05. The owner approved completion of the scoped design and the transition to development. This is not a production acceptance record.

## Canvas and scope

MUS-CR-001 follow-up: written briefs now require P0 server-side Cases/SSCC linking, fixed-template receiving CSV preview/output and distinct export-ready/incomplete outcomes. The `.pen` canvas has not been revalidated or edited for these decisions; reconcile the relevant frames and both locales through Pencil MCP before visual acceptance. Historical frame counts below are not proof of coverage for this change.

The canonical design is `docs/design-briefs/us/markiro-us.pen` in the primary checkout, inspected and edited through Pencil MCP only. It contains 128 screen frames in 18 topic sections. Read topics vertically and screens within a topic left to right. The 28 additions complete language preferences, Spanish reference workflows, 1024 px adaptations, request closure/read-only states, access recovery and optional Station recovery details.

| Section | Screens | Coverage                                                                                     |
| ------- | ------: | -------------------------------------------------------------------------------------------- |
| 01      |       4 | Overview, first run and generic profile                                                      |
| 02      |       6 | Profile, team, permissions and personal EN/ES preferences                                    |
| 03      |      12 | Parties, locations, products and imported lot validation                                     |
| 04      |       8 | Receiving and finalization conflicts                                                         |
| 05      |       6 | Transformation inputs, outputs and finalization                                              |
| 06      |       6 | Shipping, balance warning and blocked lots                                                   |
| 07      |       4 | Amendments, frozen history and dependency-blocked void                                       |
| 08      |       4 | Lot identity, status and history                                                             |
| 09      |       8 | Search and backward/forward trace                                                            |
| 10      |       4 | Readiness and source findings                                                                |
| 11      |       8 | Plan editing, review, approval and PDF history                                               |
| 12      |       4 | Request timing, scope and validation                                                         |
| 13      |      12 | Packages, failures, retained revisions, closure and auditor view                             |
| 14      |       4 | Shared loading, empty, error, permission and confirmation states                             |
| 15      |      12 | Themes, Spanish workflows, keyboard states and 1024 px adaptations                           |
| 16      |      12 | P1 Station, physical print checks and link recovery                                          |
| 17      |       4 | P1 static landing at three widths and Letter one-pager                                       |
| 18      |      10 | EN/ES sign-in, mobile sign-in, reset request, neutral confirmation, reset and session states |

The shared component sheet and navigation index are not included in the 128 screen count. P0 excludes Station, optional public materials, billing and self-service registration. Shared states are reusable patterns, not a demand to duplicate every screen in every permutation.

## Implementation decisions

- Preserve `packages/ui` as the production component/token authority, with IBM Plex Sans for interface text and IBM Plex Mono for identifiers. Do not install a replacement design system.
- `en-US` is the U.S. default; `es-US` is the second locale. Language belongs to the account/device, not the regulatory profile. Switching languages preserves TLCs, stored quantities, units, timezone and prepared artifact bytes. Names in the selector are English / Español.
- At 1024 px, amendment comparison uses revision tabs and a compact changed-field summary. Trace offers its accessible table representation. Wizard actions remain visible; table columns may wrap, but identifiers are not truncated beyond recognition.
- Closing a request retains downloadable revisions and does not imply regulatory submission or acceptance. Auditor views omit mutation controls.
- Access screens reuse Better Auth. The existing server reset-mail hook is the basis for a reset request UI; it is not a new authentication system. A reset request displays the same neutral response regardless of account existence. Recovery mail, templates, rate limits and allowed return URLs need U.S.-edition verification before release. No sign-up link is shown in this edition.
- A session-expired message does not promise that unsaved changes survived. After reauthentication the user checks the last saved revision.
- P1 printing distinguishes requested output from physical confirmation. Retrying a failed lot link never repeats case closure or printing. A missing lot snapshot blocks linking, not packing continuity.

## Verification and limits

Pencil structural checks on 2026-09-05: 128 screens, 18 sections, no overlapping root frames, no clipped nodes, no unfinished placeholders. The text contrast pass checked 5,392 resolved text/background pairs with no failures against the applicable AA text thresholds. Reviewed representative light/dark, Spanish, narrow-office, mobile-access and Station screenshots.

These are static design checks. They do not prove browser behavior, focus trapping, screen-reader support, localization key completeness, security, email delivery or physical scanner/printer acceptance. Spanish safety and regulatory wording needs fluent review before operational use. Not every screen is duplicated in Spanish or dark mode; production translation and theme coverage apply to every reachable U.S. screen.

## Development handoff

Start with US-00 under the [shared MVP contract](../../us/mvp-contract.md), followed by the [slice sequence](../../us/implementation-plan.md). The first code increment is the shared, side-effect-free edition/profile/locale policy. Server enforcement, provisioning, auth, capability wiring, persistent profiles and the office shell remain separate integration work; the helper module alone must never be reported as a deployed isolation boundary.
