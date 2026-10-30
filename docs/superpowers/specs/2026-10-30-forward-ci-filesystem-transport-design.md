# Forward CI: filesystem command transport

## Goal and scope

Reduce the local synthetic `platform-forward-recovery-scenario` overhead by replacing repeated Docker CLI launches for generated-file preparation with equivalent Engine exec calls. The user authorized a separate PR, preserving every isolation/recovery check, with no timeout increase and no cancellation, rerun or modification of the existing PR #835 run. No production access, executor behavior, credentials or deployment changes.

Baseline main `93732e9bc`, CI `41041176888`, healthy job `124019628831`: 68m22s overall, 65m17s rehearsal; activation 1,578,505 ms, inclusive Docker transport 1,151,401 ms, isolation 149,582 ms, source checks 8,097 ms. There were 2,724 activation Docker calls and 9,428 across the namespace. A local disposable Linux-arm64/Podman control measurement verified identical outputs for five filesystem operations and showed a cheaper direct exec path; this is not native Linux-amd64 CI timing proof.

## Chosen bounded change

Use the existing Unix Engine protocol (create exec, attached non-TTY start, inspect exact exec/container and terminal state) for `mkdir`, `chmod`, `chown`, `sha256sum` and `stat` within this invocation's canonical private temporary root. Preserve the exact Cmd argument array, target container, inherited container environment/user, command order and stdout/stderr. No command/result caching, batching or parallel command execution. All other commands retain the existing CLI path. A selected command's failure never falls back to CLI or retries through another transport.

Only forward rehearsals use this path. Ordinary upgrade-return rehearsals and production modules remain unchanged. The local controller's source, pre/post isolation guards and application/backup/restore/history assertions remain in their current positions. Helpers run in the same exact owned DinD container; no host socket mount, TCP endpoint or extra namespace/network is introduced.

## Interfaces and files

- Extract the existing bounded Unix HTTP request implementation and private error identity into `deploy/platform/rehearsal-engine-request.mjs`, preserving existing metadata/route semantics. Existing error exports stay compatible through re-export.
- `deploy/platform/rehearsal-filesystem.mjs`: `createRehearsalFilesystemReader({ endpoint, containerId, root })` returns `supports(args)` and `run(args)`. Root is absolute, canonical, private and operator-owned; container is an exact 64-character ID. Copy argument arrays before async use.
- Fixed forms: `mkdir -p PATH`; `mkdir -p -m 700 PATH`; `chmod 700 PATH`; `chown UID:GID PATH...` (1–8 paths); `sha256sum PATH`; `stat -c FORMAT PATH` for `%a:%F`, `%a:%s`, `%u:%g:%a:%s`. Paths are canonical absolute descendants of root (or root itself), bounded to 4096 bytes, without control characters. Unsupported forms use CLI before execution. No shell evaluation.
- `upgrade-ci.mjs` selects the filesystem reader only for a forward scenario and supported commands. It preserves the existing sanitized `docker exec` diagnostic metadata and avoids CLI fallback after selection.

## Failure, output and ownership contract

The complete create/start/inspect/parse/close sequence uses the existing 120000 ms command budget, not a separate budget per HTTP request. Output/response bounds stay finite at the current 4 MiB transport boundary; selected commands have bounded paths/arguments and small legitimate outputs. Validate multiplex stream headers, lengths, IDs, container identity, stopped process and integer exit code. Moby can retain a historical exec PID after exit; terminal state is established by `Running=false` and a valid exit code, not PID zero (the same rule as existing route exec). Preserve separate UTF-8 stdout/stderr. Nonzero exit rejects with the same numeric exit code and captured output as CLI. Transport/malformed/uncertain failures expose only fixed error codes; mark unconfirmed termination and poison the reader and shell dispatcher rather than replay; later unsupported commands must not escape through CLI. Existing owner-checked daemon cleanup remains responsible for uncertain exec termination. Drain HTTP requests before resolving or rejecting.

## Verification and acceptance

1. RED tests for selection boundaries, exact argv, fresh repeated filesystem results, stdout/stderr/exit parity and preserved dispatch order.
2. Protocol tests for redirects/status, malformed or partial framing, overflow, invalid IDs/container, running exec, whole-command timeout, close/drain and no retry/fallback.
3. Existing metadata, route, source-freshness, pre/post isolation, forward-rehearsal and cleanup tests remain unchanged and pass.
4. Actual isolated container comparison: same commands through CLI and production candidate reader; byte-equivalent results, terminal nonzero behavior and repeated timing samples. Exact-owned cleanup required; state environment/architecture limitations.
5. Lint/format/CI contracts and native Linux CI for the separate PR. Preserve both scenarios and all proof checks. Native duration improvement is claimed only after candidate CI evidence exists; a microbenchmark alone does not prove end-to-end speed.
