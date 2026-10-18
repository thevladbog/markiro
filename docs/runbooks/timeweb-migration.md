# Markiro Timeweb migration gates

This checklist follows the [platform preparation and publisher runbook](timeweb-platform-preparation.md).
The target scope is Markiro on one 2 vCPU / 4 GiB host, local PostgreSQL and private
S3. CRM, n8n, Chatwoot hosting, vbtech and landing redesign are outside this move.
Do not provision a paid idle VM before reviewed delivery and restore tooling exist.
No checklist entry authorizes production changes by itself.

## Dated observations: 2026-10-18

- Preparation PR #731 merged as `0ca0433f1ef2695667da1ad6bc9ef9ba1e6c4a96`.
  PR CI success is not proof for a later main or publisher dispatch SHA. Require
  exact green main CI at publication time.
- Read-only Timeweb project inventory showed private bucket `markiro-tmp-media`,
  mailbox `no-reply@markiro.app` and domain `markiro.app`, with no VM. Presence
  does not establish capacity, object completeness or working email delivery.
- Public authoritative NS were `ns1.yandexcloud.net` / `ns2.yandexcloud.net`.
  Both returned NOERROR with zero MX answers for `markiro.app`. Apex TXT contained
  Google/Yandex verification records but no SPF; `_dmarc` TXT was empty. The four
  observed web A records still pointed to `158.160.200.255`; release downloads
  used a Yandex CDN CNAME. Preserve those routes until their own accepted cutover.
- The staged, non-authoritative Timeweb zone already contained MX 10
  `mx1.timeweb.ru`, MX 20 `mx2.timeweb.ru`, SPF
  `v=spf1 include:_spf.timeweb.ru ~all`, a `dkim._domainkey` TXT record and DMARC
  `v=DMARC1;p=none`. Those staged records were not served by the current public
  authority. Its web A/CNAME records still referenced current Yandex endpoints.
  No records were changed. Export both zones before editing; reconcile senders
  into a single correct SPF and preserve verification/DKIM records. Do not infer
  working mail from a staged-zone screenshot or copy an entire zone blindly.
- The latest encrypted backup report recorded a fresh isolated PostgreSQL restore,
  but did not reproduce role ownership/ACL. The source remained writable, and
  archive/key were co-located on a Mac. This is neither final-delta evidence nor
  an independent off-site recovery copy.

Refresh these observations before execution; they are not current-state guarantees.

## Before provisioning

- [ ] Merge/review the protected image publisher, select its exact successful main
      CI run, approve publication and independently verify the complete artifact,
      image IDs and digest-bound version-1 platform manifest.
- [ ] Implement and review a separate protected host executor: pinned SSH host
      identity, clean environment, explicit protected files, manifest provenance,
      profile-aware candidate/healthy/rollback state, success-only phase ordering
      and failure recovery. Existing Yandex legacy tooling is not this executor.
- [ ] Prepare Linux bootstrap, PostgreSQL TLS/CA and intended application/migration
      roles and grants. Test role ownership, ACL, extensions and default privileges
      with a fresh restore, not only `--no-owner --no-acl`. Preserve encrypted fields,
      session identity, mail key, standalone issuer/KID/keyset/signing key and
      license issuance sequences using protected fingerprints and verified recovery.
- [ ] Measure restored database/index size plus WAL, image retention, logs, temporary
      restore/index workspace and free-space headroom. Reconfirm available Timeweb
      resources and pricing before purchase; quoted capacity is not an allocation.
- [ ] Prepare independent encrypted DB/object/config/key backups outside the VM and
      a separately recoverable copy outside the provider account; verify restoration
      with independently available recovery keys. Keep older archives intact.

## Isolated restore and exact-release rehearsal

- [ ] Restore a fresh immutable source backup into new database resources with API,
      edge, all old writers and worker processes off. Compare migrations, tenants,
      licenses, audit history, constraints, sequences, ownership and ACL; do not
      repair failures by destructively rewriting history or applied migrations.
- [ ] Stage private S3 independently. Inventory/copy object versions, bytes, hashes,
      content types and access policy; verify signed downloads and private denial.
      Preserve existing Station/download artifacts and signed release URLs. Moving
      release storage is a separate accepted gate before Yandex retirement.
- [ ] Enforce rehearsal egress isolation outside application flags: SMTP sink,
      approved test recipients only, no live support/CHZ/external side effects.
      Review durable mail/report intents and startup repair before boot. Legacy
      `pgboss` queues remain retained without workers; platform queues can run on
      startup. Diagnostic retention has an independent timer and needs review too.
- [ ] Migrate with the app stopped, verify success, then start API and finally edge.
      A migration failure leaves the application stopped with data retained. Use
      the reviewed clean environment and compact composition; never the CI overlay.
- [ ] Run a separate compact-capacity test against the **exact published image
      digests** and representative restored data: authenticate, issue/verify a
      license, decrypt diagnostics, generate representative reports, exercise S3,
      controlled SMTP, negative legacy routes and tenant isolation. Record peak
      RSS, CPU, disk/WAL/temp growth, latency and report concurrency. A green
      synthetic publisher harness does not establish 2 vCPU / 4 GiB acceptance.
- [ ] Verify target CA/TLS, external backups and an isolated restore from those
      backups, monitoring, log rotation and restart/recovery behavior. Preserve
      evidence separately from secrets and client data.

## Mail readiness and one-writer cutover

- [ ] Inventory authoritative and staged DNS afresh. Separately approve correct
      Timeweb MX/SPF/DKIM/DMARC publication at the actual authority, preserve existing
      verification and authorized senders, and verify public DNS and controlled
      inbound/outbound SMTP delivery. Existing mailbox presence is insufficient.
- [ ] Approve a cutover window and data-freeze plan. Fence old writers and legacy
      workers before enabling any new writes. Take and verify final DB backup and
      S3 delta; prove the final restored sequence/audit/object state. Never let old
      and new profiles write one database, or diverging writable copies.
- [ ] Change approved web DNS/TLS only after target readiness and final-delta gates.
      Preserve accepted MX/SPF/DKIM/DMARC and verification records. A web change
      must not accidentally replace mail authority. Confirm public DNS propagation,
      certificates, auth origins, licensing, reports and controlled mail delivery.
- [ ] Define rollback before writes. After target writes, DNS reversal alone cannot
      restore consistency: reconcile or restore the accepted data boundary before
      changing writer ownership. A legacy-profile rollback additionally needs queue,
      schema, license-key and retired-surface approval.
- [ ] Keep old resources, backups, keys and immutable releases until explicit
      acceptance, recovery proof and release-download continuity. Delete no old
      resource simply because the new host starts successfully.
