# Target-local backup under the production host fence

## Intent

Finish the missing trusted target-local backup adapter required by the approved Timeweb migration. A source Yandex archive is never relabelled as Timeweb evidence. Source import/role transformation remains a separately verified operation. This component creates and verifies a recovery copy of the already imported, stopped target database.

## Design

Reuse the actual host Docker inventory, PostgreSQL admin/HBA observer, backup producer and isolated restore. Only PostgreSQL may run at the observation boundaries. The internal database network has no foreign members, the volume has no foreign mounters, the exact physical host/database/image/network identities are observed, HBA bytes predate the running postmaster, and no client sessions or prepared transactions remain. A cooperating host operator lock prevents deployment overlap; root/current-UID compromise remains outside this boundary.

The current archive producer observes after-snapshot while its stopped worker still belongs to the database network. Move that observation until after worker output was copied and its owned temporary resources were verified absent. Both observations still bracket the snapshot, and publication must remain after the final observation. A failure or uncertain cleanup must never publish success.

Add a trusted JavaScript entry point for operator use, not a JSON-injected callback or permissive remote CLI. It accepts the existing deployment identity/configuration, observation policy, exact installed HBA and reviewed-source verification callback, protected backup connection descriptor, and exhaustive restore role mapping. It invokes concrete Docker and PostgreSQL observers itself. It does not accept a caller's held=true fact. Production runtime must use Linux AMD64, /usr/bin/docker, unix:///var/run/docker.sock, live-source provenance and the same executor SHA. Its connection must target db.private:5432/markiro on the exact observed internal network; credentials remain private. A trusted image whose provenance has independently been checked is required; this module does not build/publish images.

The fence begins only after a successful factual observation, has a fresh UUID and matching host-command enforcement hash. The trusted source verifier is called at every boundary. Wrap the complete backup and isolated restore in the existing withHostState lock, reject an unresolved deployment journal, and preserve conservative failure semantics. Do not let that lock helper erase termination uncertainty or return incomplete archives as accepted. Recheck the fence after isolated restore cleanup, then return existing backup/restore descriptors plus the measured fence. The existing deployment command remains responsible for later TLS/effective-role/key/egress/off-host checks and admission.

## Constraints and acceptance

- No server, DNS or production data changes by implementation tests.
- No secrets, SQL rows or credentials in stdout, argv, Git, errors or evidence.
- Existing exact inventory, 1 MiB envelope limit, identity and cleanup validation remain intact.
- Use existing fixed project markiro-platform and private file contracts.
- Test wrong host/image/network, active/foreign workload, DB sessions, stale HBA, altered private inputs, failed cleanup/final observation and concurrent lock. Reuse existing fixtures instead of introducing a permissive observer implementation.
- Local tests are not live acceptance. Actual Linux AMD64 target invocation and source import remain distinct gates.
