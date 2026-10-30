# Forward CI filesystem transport verification

## Scope

Only forward-rehearsal generated-file commands use the new Unix Engine exec path. Command arguments, target container, inherited environment/user, stdout/stderr and sequential order are preserved. Source and pre/post isolation guards, actual backup/restore/history assertions and cleanup remain in place. The total command budget remains 120000 ms; workflow budgets and the existing PR #835 run are unchanged.

## Protocol and compatibility

The focused suite covers fixed command/path selection, fresh repeated results, argument mutation, separate streams/nonzero exits, malformed responses, total deadlines, poisoned execution and no CLI escape after an uncertain command. Existing metadata, source/route isolation, large-tree copy and forward-scenario tests remain required.

Exec termination uses exact exec/container identity, `Running=false` and a valid exit code. A historical PID is permitted: Moby's [exec inspection](https://github.com/moby/moby/blob/v28.0.4/daemon/inspect.go#L183-L212) reads it from the retained process, while [exit handling](https://github.com/moby/moby/blob/v28.0.4/daemon/monitor.go#L179-L219) records `Running=false` and the exit code. A regression test covers this difference from Podman.

The selected-command failure also latches the shell dispatcher: later unsupported commands cannot continue through CLI. Actual owner-checked namespace cleanup retains its separate `outer` path.

## Actual local comparison

Environment: macOS controller, local Podman 5.4.2 with a Linux-arm64 Node 24 container; network none, no host bind/socket mounts, a private tmpfs and generated fixture data. Three alternating-order samples each execute the same 20 serial `mkdir`, `chmod`, `chown`, `sha256sum` and `stat` commands. Reference outputs are established outside the timed loop. The final candidate is used directly, not a substitute mock implementation.

| Sample | CLI, ms | Engine exec, ms |
| ------ | ------: | --------------: |
| 1      |    4357 |            1794 |
| 2      |    5235 |            1902 |
| 3      |    9052 |            2261 |

Median: 5235 ms versus 1902 ms (about 2.75× for this command subset). All successful outputs matched. After modifying the fixture, the reader returned the changed hash and matched CLI again. A missing fixture produced the same nonzero exit code and stdout/stderr as CLI. The exact task-owned container was verified and removed after measurement.

These measurements do not establish the end-to-end Linux-amd64 CI duration or production recovery acceptance. Native candidate CI must still complete both full recovery scenarios and supply its duration evidence; no native speedup is claimed before that result.

## Automated checks

- Focused transport/source/recovery checks: 118 passed, no skips.
- Isolated Linux-arm64 Node 24 protocol/child-drain checks: 44 passed, no skips. Only the explicit source dependency closure was copied; no .env, network or host mounts. Exact container cleanup succeeded.
- Full platform contracts: 1810 passed, three explicit skips. Production bundle contracts: 586 passed, no skips. CI classifier/workflow contracts: 99 passed, no skips. Scoped ESLint, repository formatting and diff checks passed.
- The workspace-wide application Turbo gates were not run: this change affects only Node-based rehearsal tooling and its contracts, with no application/package source changes.
- The full platform suite has three explicit external-infrastructure skips when the corresponding catalog PostgreSQL, Caddy and PG17 fingerprint fixtures are absent. They are not counted as exercised infrastructure.
