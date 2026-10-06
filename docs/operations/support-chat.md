# Support chat local release and deployment gates

This package covers the private cabinet chat, platform proposal, explicit
customer consent, and import into an existing Markiro billing request. It is
local source and test evidence only. No API inbox, secret, live ingress rule,
deployment, or production data change has been made by this task.

## Configuration and trust boundary

`SUPPORT_CHAT_ENABLED` defaults to false. The Markiro API alone holds
`SUPPORT_CHATWOOT_BASE_URL`, `SUPPORT_CHATWOOT_ACCOUNT_ID`,
`SUPPORT_CHATWOOT_INBOX_ID` (numerical Application API inbox ID), and
`SUPPORT_CHATWOOT_API_TOKEN`. Do not put the token, Chatwoot contact source ID,
or widget credentials in admin/saas-admin bundles, browser responses, tracked
examples, or Caddy. The new API channel's separate public
`Channel::Api.identifier` must be captured when the inbox is created and used
only for the targeted ingress block. It must be nonempty and verified against
the actual new channel; an empty placeholder makes the matcher ineffective and
blocks enablement. Neither identifier exists yet; do not
reuse the Sales or existing website Support inbox. The official
[API inbox guide](https://www.chatwoot.com/hc/user-guide/articles/1677839703-how-to-create-an-api-channel-inbox)
describes authenticated contact → conversation → message creation with
`api_access_token`. The pinned [v4.17.0 routes](https://github.com/chatwoot/chatwoot/blob/v4.17.0/config/routes.rb)
expose a separate unauthenticated public Client API under
`/public/api/v1/inboxes/:inbox_id`; the [controller](https://github.com/chatwoot/chatwoot/blob/v4.17.0/app/controllers/public/api/v1/inboxes_controller.rb)
resolves that parameter by channel identifier. A backend token alone does not
close this path. V1 polls Chatwoot; no webhook is required by Markiro's worker.

## Safe order of rollout

1. Apply additive migrations 0177–0179. Inspect enum/table constraints and
   keep existing billing rows; do not down/drop the support enum or tables.
2. Deploy API, contracts, admin and saas-admin readers that understand the
   `support` type while the feature flag remains off. Verify ordinary billing
   list/detail/status/reply and attachment paths on the intended target.
3. Create a distinct Chatwoot API channel inbox with assigned agents and
   collect its numeric inbox ID and public channel identifier through the
   approved secret/configuration process. Use server-only Application API
   credentials. Confirm Chatwoot's callback field behavior; do not expose a
   callback merely because the setup guide shows one.
4. Review and apply the targeted Fucina Yandex Caddy example from
   `docs/support-chat-api-inbox.md` in the actual native-auth deployment
   configuration. Do not restore an older Basic Auth snippet. Verify effective
   config has the nonempty actual public channel identifier, JSON access-log
   request/response token redaction, and preserve Sales
   website routes and authenticated operator/Application API access.
5. Through the real public hostname, perform anonymous direct negative probes
   for the new API channel's read/create/send, encoded/query/trailing variants
   and positive Sales and authenticated operator/server probes. A local Caddy
   fake-upstream test does not substitute for this live admission check.
6. Review existing-log exposure and credential-rotation needs with the security
   owner. Only after that review and separate enable authorization, set
   `SUPPORT_CHAT_ENABLED=true` for the intended target and observe request,
   sync, and audit behavior. Keep the initial scope text-only.

## Rollback and data preservation

Turn the feature flag off to stop new chat actions while retaining episode,
proposal, consent, message and billing-request rows. Roll back to a compatible
reader that understands the `support` enum and can display existing requests.
Do not delete imported transcripts, run a down migration, or blindly resend an
uncertain Chatwoot message. Review durable jobs and pending/uncertain delivery
with operators before re-enabling. The existing tenant reply gate remains
`clarification_required`; transcript import does not change billing status.

## Recovery and chat history

Episode creation commits a provisioning job with the episode. The `reconcile`
kind belongs to provisioning and completes once its verified mapping is ready;
only `import` jobs own consent-linked transcript health and operator sync retry.
Queue repair also wakes unclaimed pending send intents. It rechecks current
membership and uses the original intent key; claimed or uncertain sends are never
reposted automatically. Ambiguous contact/conversation POST checkpoints remain
fail-closed for operator investigation. The cabinet retains a pending draft so
an explicit retry can use the same intent key.

Episode message pages start with the latest messages, ordered chronologically
within each page; the opaque cursor walks backward to older history. Polls merge
the latest page into already displayed history. Each visible five-second poll
also reads at most one backward page to reconcile the opened range, independently
of the manual older-history cursor. A sweep retains its starting oldest-message
boundary; once manual history is exhausted it walks to the end. Completed sweeps
restart on subsequent polls because upstream backfill can insert older-timestamped
messages behind a previously read page. Cache overlap is not proof of complete
coverage. Large gaps therefore recover over multiple polls; failed or cancelled
reads do not advance the recovery cursor. Before consent, verified private
chat reads fetch at most two raw upstream pages per request and persist progress,
including private/activity-only pages. Subsequent cycles stop at the prior raw
high-water mark. Public text remains available locally when the upstream is
offline. The checkpoint and messages commit only while the current database
episode is unlinked; accepting consent transfers health authority to the fenced
import job. This private cache never grants billing transcript access.

Accepted transcript imports also commit at most two verified raw pages per worker
invocation. The checkpoint keeps a proven raw high-water mark (zero after an
empty import), a fixed upper boundary and capture time for the current cycle,
and the next backward cursor. Private/activity rows advance that cursor without
becoming transcript messages. A partial cycle releases its lease as pending for
repair after one second; it sets transcript state to pending and preserves the
previous lastSyncedAt. Only raw exhaustion, or reaching the previous proven
boundary during an incremental cycle, restores healthy and records the cycle's
capture time. New arrivals above the captured boundary are discovered next cycle.
Full reconciliation becomes due after fifteen minutes to find delayed older
rows and uses the same bounded continuation. Legacy checkpoints without a proven
boundary restart a full read from the head. Queue lag and upstream failures can
delay completion; a two-page limit never proves complete coverage.

The cabinet loads episode lists one page at a time with an explicit load-more
button. Loaded pages and questions created in the current tenant/user context
remain selectable; after reload, later questions are reached with load more.
Switching questions changes mutation ownership, so a late send/decision/create
cannot overwrite the next question's draft, errors or busy state. Cached private
history remains visible during an upstream outage with connection feedback and
an explicit retry; successful recovery clears that warning.

## Evidence labels

Automated source, isolated PostgreSQL, fake Chatwoot, local Caddy, and rendered
browser checks prove only those boundaries. They do not establish live Chatwoot
version/configuration, public ingress, DNS/TLS, cloud deployment, backup/restore,
customer acceptance, 152-ФЗ/legal review, or physical production readiness.
Record exact source SHA, changed files, complete test counts/skips, browser
screenshots, and the direct security probe result before an enable decision.
