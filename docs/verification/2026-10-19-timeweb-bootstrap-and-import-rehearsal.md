# Timeweb bootstrap and source import rehearsal — 2026-10-19

Status: preparation only. Public DNS and the running Yandex services have not been
changed. No application or database service has been started on the new VM.

## Published application images

Protected platform publisher run `39215020181`, attempt 1, succeeded for source
`0d30c7341bc9dfcabafaf60cb4a9b9173e56736d`. The complete release artifact ID is
`12169628762`; the downloaded manifest/evidence passed the repository release
validator. Linux AMD64 images pulled on the new host match the CI configuration IDs:

| Image         | Registry manifest digest                                                  | Configuration ID                                                          |
| ------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| API           | `sha256:ef7549a646bb5f71a00459e9fca3303f154099711d528c3952daa83e06b1928a` | `sha256:895290438fefe0bbf853c83b97eeeab1daaae9d35aad72cabfbc4c0534ef0fb5` |
| Platform edge | `sha256:9008e368208eb78c43494ebc309464f2d1c59035ca7660d9bdfbe30b4c7a86c2` | `sha256:657014369338c5ece37a8ad4251abbb7a055accc8307ef78c968d5ef905b95e0` |

Publication and pulling do not establish deployment acceptance.

## New host preparation

The approved VM has 2 vCPU, 4 GiB RAM and a 50 GB disk. Its SSH host key was checked
against the authenticated provider console before use. Password and interactive
keyboard SSH authentication are disabled. Docker 29.9.1, Compose 5.6.0 and Node
24.22.0 were installed from signed official repositories. Docker and containerd
are enabled for boot.

Docker's initial containerd image store returned manifest IDs where the existing
CI admission contract expects configuration IDs. On the empty host, the validated
Docker configuration was switched to classic overlay2. Exact image identity checks
then passed. The configuration also rotates JSON logs at 10 MiB times three files.
Previously downloaded containerd images remain on disk; no global prune was run.

The official PostgreSQL AMD64 manifest is
`postgres:17-alpine@sha256:aa90e97ee862e558111d34cfb8b2c4bec768c2b039fb791341686928560263b3`.
A disposable networkless, read-only container reported PostgreSQL 17.11 and
postgres UID/GID 70. It was removed. The image configuration ID is
`sha256:79bd7c99e923138f136f8009d6bffa66e21e9d4fda5c0c561b00fc9c90cfe537`.
No service containers remained after this check. Disk availability was
44,248,436,736 bytes after staging images; this is an observation, not a hard growth
budget or completed restore measurement on this host.

The PostgreSQL server private key was generated directly on the VM. Only its
public CSR and signed certificates crossed the network. The CA private key stays
outside the VM. Certificate chain, exact `db.private` hostname and server key pair
checks passed; the wrong hostname was rejected. Live database TLS and effective
client authentication remain untested until PostgreSQL is started.

## Local source import rehearsal

The encrypted nightly snapshot made earlier on 2026-10-19 was decrypted in memory.
Its custom dump SHA256 is
`ecb803aecc97240060fea02797b3ae8b337d7ce7a3f1513735d7122ecdafd92d`.
Two databases were restored in one disposable, networkless local PostgreSQL 17.11
ARM64 container: a baseline and a target with the repository's separate API and
migration roles. This did not access or mutate the live source.

The target used explicit `--no-owner --no-acl --role markiro_migrator` restore
mapping. Only three exact preprovisioned TOC entries were excluded: the `drizzle`
schema, the `btree_gist` extension and its comment. Provider-specific grants and
roles are not replayed under this transformation; the original archive remains
unchanged. This checks a deliberate new privilege policy, not preservation of the
source provider's ACLs.

All 256 tables, 1,435,750 rows and four sequences matched. Comparison included
canonical per-row hashes, counts, sequence state, index definitions and readiness,
and constraint definitions and validation. The combined comparison SHA256 is
`caad2ddf84c5eea4f7f0ad41a8ac8317d82cdd606dc22cceb44263abe494ad68`.
The restored target database occupied 597,849,779 bytes. Business objects belonged
to the migrator; the API was denied legacy `pgboss` schema usage and database
CREATE, while the migrator had database CREATE and the API owned
`pgboss_platform`. There were no invalid or unready indexes.

The rehearsal finished at 07:47:11 UTC. Its owned container and volume were removed
and container absence checked. This is not a final frozen-source snapshot, a
Linux AMD64 target restore, an application test or migration cutover acceptance.

## Existing external services and remaining gates

Earlier encrypted Timeweb credentials were recovered without displaying values.
Authenticated checks confirmed the existing S3 bucket is private with versioning
enabled (317 objects, 97,446,872 bytes at observation). SMTP authentication succeeded
using TLS 1.3; no message was sent. Inbound mail, authoritative DNS and mail delivery
remain separate checks.

Still required before switching traffic: green reviewed executor CI, independently
installed bootstrap, approved source role transformation on the actual target,
fresh fenced backup and isolated restore, runtime key continuity, controlled
application checks, independent encrypted recovery copies, a final source write
freeze and delta, release-download continuity, DNS/TLS and mail verification.
Yandex shutdown follows those gates and must retain recoverable data.
