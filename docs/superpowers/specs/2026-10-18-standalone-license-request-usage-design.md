# Activation request usage statistics

Accepted scope: the standalone activation export optionally carries the same encrypted usage payload as the support report. Importing the export in platform administration immediately applies its statistics through the existing diagnostics ingestion path. No production change or deployment is authorized.

The host activation protocol stays unchanged. A separate export schema extends its strict request with optional `supportToken`; old files and builds without an encryption key remain usable. Counts, metadata, encryption and allowlists are shared with the support report. A failed statistics read/encryption does not prevent saving the activation request; the saved-file UI warns when usage statistics were omitted.

Inspection of a request carrying a token invokes existing diagnostics ingestion, including authorization revalidation, explicit confirmation for an unbound host, current-owner precedence, token idempotency, newest-generatedAt monthly updates and exact audit. The decrypted v2 host id must equal the activation request host id before any statistics write. A previously registered host of the selected tenant can refresh statistics. Another tenant's host cannot. The request's token is never stored in the site's activation snapshot or audit.

The platform file import and JSON paste use one parser. Successful ingestion invalidates tenant diagnostics queries immediately. Closing or unmounting the dialog clears its request and pasted text and releases token-bearing mutation cache entries; registration sends only the original host request without the support token. Errors and unbound-host confirmation are visible. Legacy inspection remains read-only and requires no diagnostics configuration.

Verification covers legacy/export parsing, shared encrypted payload, immediate import refresh, explicit confirmation, host mismatch and tenant ownership, duplicate and stale report behavior. Database tests require isolated migrated PostgreSQL; Windows, hardware and production are separate unexercised boundaries.
