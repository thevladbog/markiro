package app.markiro.handheld.core.duplicate

import android.util.Base64
import androidx.room.withTransaction
import app.markiro.handheld.core.box.PrintReason
import app.markiro.handheld.core.km.KmException
import app.markiro.handheld.core.label.LabelRenderException
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.LabelSpecCodec
import app.markiro.handheld.core.label.PrinterLanguage
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ProductLabelEventEntity
import app.markiro.handheld.core.storage.ProductLabelJobEntity
import app.markiro.handheld.core.storage.ShiftEntity
import app.markiro.handheld.core.util.Iso
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.sync.withLock
import java.util.UUID

/** Why a duplicate did not happen, in the operator's terms rather than the transport's. */
object DuplicateReason {
    const val PRINTER_UNCONFIGURED = "printer_unconfigured"

    /** The selected printer no longer speaks the language the bytes were made for. */
    const val PRINTER_CHANGED = "printer_changed"
    const val TEMPLATE_MISSING = "template_missing"
    const val TEMPLATE_INVALID = "template_invalid"
    const val RENDER_FAILED = "render_failed"

    /** A code with no crypto tail cannot be reproduced as a valid marking code. */
    const val CODE_INCOMPLETE = "code_incomplete"

    /** Another unit's label is still unresolved; the operator is holding a sticker. */
    const val JOB_OUTSTANDING = "job_outstanding"

    /** A reprint was asked for while this job's own attempt was still in flight. */
    const val ATTEMPT_IN_FLIGHT = "attempt_in_flight"

    /** Retention dropped the prepared bytes at shift close; there is nothing to replay. */
    const val BYTES_GONE = "bytes_gone"

    /** The shift row carries a duplicate mode but not the snapshot every event must quote. */
    const val POLICY_INCOMPLETE = "policy_incomplete"
    const val NO_PAPER = PrintReason.NO_PAPER
    const val HEAD_OPEN = PrintReason.HEAD_OPEN
    const val UNREACHABLE = PrintReason.UNREACHABLE
    const val TRANSPORT_FAILED = PrintReason.TRANSPORT_FAILED
}

object ReprintReason {
    const val NOT_PRINTED = "not_printed"
    const val DAMAGED = "damaged"
    const val LOST = "lost"
}

sealed interface DuplicateOutcome {
    data class Prepared(val jobId: String) : DuplicateOutcome
    data class Refused(val reason: String) : DuplicateOutcome
}

sealed interface DuplicateSend {
    data object Sent : DuplicateSend

    /** Nothing was printed and we know it. */
    data class Failed(val reason: String) : DuplicateSend

    /** The bytes may or may not have reached the printer. Nothing resends from here on its own. */
    data class Unknown(val cause: String) : DuplicateSend
}

/**
 * A unit's duplicate label, from accepted scan to printed sticker.
 *
 * One job is live at a time. The operator is holding a physical sticker, and
 * accepting the next unit first would leave two labels and no way to tell which
 * belongs to which.
 *
 * Bytes are rendered ONCE, at acceptance, and replayed on every later attempt.
 * This is the opposite of the box label, which re-renders because «Другой
 * принтер» may speak another language -- here the server holds a digest of these
 * exact bytes and the domain refuses a reprint that changes them.
 */
class DuplicateJobs(
    private val db: HandheldDatabase,
    private val renderer: LabelRenderer,
    private val transport: PrinterTransport,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val mutex = Mutex()

    /**
     * Whether this shift can print at all, asked before the first unit is
     * accepted rather than halfway through it.
     */
    suspend fun preflight(shift: ShiftEntity): String? {
        db.printerDao().selected() ?: return DuplicateReason.PRINTER_UNCONFIGURED
        val template = shift.duplicateTemplate ?: return DuplicateReason.TEMPLATE_MISSING
        // Every event quotes the policy revision and the template digest. A row
        // missing either cannot produce one, and finding that out inside the
        // scan collector meant an exception it swallows: no label, no refusal,
        // nothing on screen.
        if (shift.duplicatePolicyRevision == null || shift.duplicateTemplateDigest == null) {
            return DuplicateReason.POLICY_INCOMPLETE
        }
        return try {
            LabelSpecCodec.parse(template)
            null
        } catch (_: LabelRenderException) {
            DuplicateReason.TEMPLATE_INVALID
        }
    }

    suspend fun openJob(shiftId: String): ProductLabelJobEntity? = db.productLabelJobDao().openJob(shiftId)

    /**
     * Why an outstanding job needs a person, taken from its own last event.
     *
     * The screen is rebuilt from this after a restart: a job whose attempt
     * failed or went unknown is invisible otherwise, and the next unit is then
     * refused for a reason nothing on screen explains.
     */
    suspend fun attentionReason(jobId: String): String? {
        // The device-local reason first: it carries the printer's own words,
        // which the wire deliberately cannot.
        db.productLabelJobDao().get(jobId)?.lastFailure?.let { return it }
        val payload = db.productLabelEventDao().lastPayload(jobId) ?: return null
        return runCatching {
            Json.parseToJsonElement(payload).jsonObject["errorCode"]?.jsonPrimitive?.content
        }.getOrNull()
    }

    /**
     * Turns an accepted unit into a job with its label already rendered.
     *
     * The render happens before the transaction: it is the slow part, it touches
     * no database, and holding a write transaction across it would block every
     * other writer for the length of a rasterization.
     *
     * `acceptedAt` is the SCAN's own `scannedAt`, not a fresh reading of the
     * clock. The server joins an event to its accepted code on
     * `codes.scannedAt = event.acceptedAt`, so a timestamp of convenience makes
     * every event `parent_missing` -- quarantined one by one while the device
     * shows nothing wrong.
     */
    suspend fun accept(
        shift: ShiftEntity,
        canonicalRaw: String,
        codeHash: String,
        operatorId: String,
        operatorName: String?,
        acceptedAt: String,
    ): DuplicateOutcome = mutex.withLock {
        if (db.productLabelJobDao().openJob(shift.id) != null) {
            return DuplicateOutcome.Refused(DuplicateReason.JOB_OUTSTANDING)
        }
        val printer = db.printerDao().selected() ?: return DuplicateOutcome.Refused(DuplicateReason.PRINTER_UNCONFIGURED)
        val template = shift.duplicateTemplate ?: return DuplicateOutcome.Refused(DuplicateReason.TEMPLATE_MISSING)
        val spec = try {
            LabelSpecCodec.parse(template)
        } catch (_: LabelRenderException) {
            return DuplicateOutcome.Refused(DuplicateReason.TEMPLATE_INVALID)
        }
        val policyRevision = shift.duplicatePolicyRevision
        val templateDigest = shift.duplicateTemplateDigest
        if (policyRevision == null || templateDigest == null) {
            return DuplicateOutcome.Refused(DuplicateReason.POLICY_INCOMPLETE)
        }

        val fields = try {
            duplicateLabelFields(shift, canonicalRaw, acceptedAt, operatorName)
        } catch (_: KmException) {
            return DuplicateOutcome.Refused(DuplicateReason.CODE_INCOMPLETE)
        }
        val bytes = try {
            renderer.render(spec, fields, PrinterLanguage.fromWire(printer.language), printer.dpi)
        } catch (_: LabelRenderException) {
            return DuplicateOutcome.Refused(DuplicateReason.RENDER_FAILED)
        }

        val jobId = newId()
        val attemptId = newId()
        val event = ProductLabelEvent(
            eventId = newId(),
            jobId = jobId,
            attemptId = attemptId,
            sequence = 1,
            shiftId = shift.id,
            codeHash = codeHash,
            acceptedAt = acceptedAt,
            policyRevision = policyRevision,
            templateDigest = templateDigest,
            payloadDigest = duplicatePayloadDigest(canonicalRaw),
            operatorId = operatorId,
            occurredAt = acceptedAt,
            kind = EventKind.PREPARED,
            attemptNo = 1,
            reason = null,
            language = printer.language,
            dpi = printer.dpi,
            bytesDigest = productLabelBytesDigest(bytes),
        )
        val verification = shift.duplicateVerification ?: Verification.NONE
        val projection = applyProductLabelEvent(null, event, verification)

        db.withTransaction {
            db.productLabelJobDao().insert(
                ProductLabelJobEntity(
                    jobId = jobId,
                    shiftId = shift.id,
                    codeHash = codeHash,
                    canonicalRaw = parseDuplicateKm(canonicalRaw).canonicalRaw,
                    acceptedAt = acceptedAt,
                    operatorId = operatorId,
                    policyRevision = event.policyRevision,
                    templateDigest = event.templateDigest,
                    payloadDigest = event.payloadDigest,
                    bytesBase64 = Base64.encodeToString(bytes, Base64.NO_WRAP),
                    bytesDigest = projection.bytesDigest,
                    language = projection.language,
                    dpi = projection.dpi,
                    latestSequence = projection.latestSequence,
                    attemptId = projection.attemptId,
                    attemptNo = projection.attemptNo,
                    attemptState = projection.attemptState,
                    verification = projection.verification,
                    verificationOutcome = projection.verificationOutcome,
                    status = projection.status,
                    lastFailure = null,
                ),
            )
            db.productLabelEventDao().insert(event.toEntity())
        }
        return DuplicateOutcome.Prepared(jobId)
    }

    /**
     * Sends the job's prepared bytes.
     *
     * The language and dpi are compared first. A reprint must replay the same
     * bytes on the same printer language and resolution, so a job sent to a
     * printer that no longer matches could never be reprinted afterwards -- the
     * refusal here is what keeps it out of that dead end.
     */
    suspend fun send(jobId: String): DuplicateSend = mutex.withLock {
        val job = db.productLabelJobDao().get(jobId) ?: return DuplicateSend.Failed(DuplicateReason.RENDER_FAILED)
        val bytes = job.bytesBase64?.let { Base64.decode(it, Base64.NO_WRAP) }
            ?: return fail(job, DuplicateReason.RENDER_FAILED)
        val printer = db.printerDao().selected() ?: return fail(job, DuplicateReason.PRINTER_UNCONFIGURED)
        if (printer.language != job.language || printer.dpi != job.dpi) {
            return fail(job, DuplicateReason.PRINTER_CHANGED)
        }

        // Asked before sending, so a refusal carries the printer's own reason
        // rather than a generic timeout.
        val status = transport.status(printer)
        if (status is PrinterStatus.NotReady) return fail(job, status.reason.wire())

        val sending = append(job, EventKind.SENDING)
        return when (val outcome = transport.send(printer, bytes)) {
            SendOutcome.Delivered -> {
                append(sending, EventKind.SENT)
                db.productLabelJobDao().setLastFailure(job.jobId, null)
                DuplicateSend.Sent
            }
            is SendOutcome.Refused -> {
                // The status query said ready and the send refused anyway. The
                // attempt is already `sending`, so the honest record is unknown:
                // the bytes reached the transport. The wire code is
                // `transport_failed` -- `delivery_unknown` admits only that,
                // `persistence_failed` and `interrupted` -- while the printer's
                // own words stay on the job row for the screen.
                db.productLabelJobDao().setLastFailure(job.jobId, outcome.reason.wire())
                append(sending, EventKind.DELIVERY_UNKNOWN, errorCode = DuplicateReason.TRANSPORT_FAILED)
                DuplicateSend.Unknown(outcome.reason.wire())
            }
            is SendOutcome.Unknown -> {
                append(sending, EventKind.DELIVERY_UNKNOWN, errorCode = DuplicateReason.TRANSPORT_FAILED)
                DuplicateSend.Unknown(outcome.cause)
            }
        }
    }

    /**
     * Anything left mid-send becomes unknown, and the device never picks the send
     * back up: resuming would be an automatic resend, and a second sticker for a
     * unit the server has already accepted is what nobody can untangle later.
     *
     * Emitting the event is an obligation rather than housekeeping. The domain
     * accepts only `sent` or `delivery_unknown` out of `sending`, so a job left
     * there across a restart would be frozen: no reprint, no verification.
     */
    suspend fun demoteInterrupted() = mutex.withLock {
        for (job in db.productLabelJobDao().interrupted()) {
            append(job, EventKind.DELIVERY_UNKNOWN, errorCode = "interrupted")
        }
    }

    /**
     * Reads a scan as this job's verification.
     *
     * `compareDuplicateKm` covers the whole raw code, separators and crypto tail
     * included -- unlike the identity hash the scan loop uses for duplicates,
     * which a different unit of the same product would share. Only a match may
     * be recorded as `verified`: the domain checks the digest too and would
     * refuse the event, so lying here fails loudly rather than quietly.
     */
    suspend fun verify(jobId: String, scannedRaw: String): DuplicateMatch = mutex.withLock {
        val job = db.productLabelJobDao().get(jobId) ?: return DuplicateMatch.INVALID
        val match = compareDuplicateKm(job.canonicalRaw, scannedRaw)
        // A verified attempt takes no further event; the job is already settled.
        if (job.verificationOutcome == VerificationOutcome.VERIFIED) return match
        when (match) {
            DuplicateMatch.MATCH -> append(
                job,
                EventKind.VERIFIED,
                scannedPayloadDigest = duplicatePayloadDigest(scannedRaw),
            )
            DuplicateMatch.MISMATCH -> append(job, EventKind.VERIFICATION_REJECTED, reason = "mismatch")
            DuplicateMatch.INVALID -> append(job, EventKind.VERIFICATION_REJECTED, reason = "invalid")
        }
        return match
    }

    /**
     * Starts a second attempt on the same bytes.
     *
     * It does not send; the caller sends, exactly as the first attempt does. The
     * bytes, language and dpi are carried over unchanged because the domain
     * refuses a `prepared` that alters any of them -- which is also why a job
     * whose bytes retention has dropped can no longer be reprinted at all
     * rather than being re-rendered into a symbol the stored digest disowns.
     */
    suspend fun reprint(jobId: String, reason: String): DuplicateOutcome = mutex.withLock {
        val job = db.productLabelJobDao().get(jobId) ?: return DuplicateOutcome.Refused(DuplicateReason.BYTES_GONE)
        if (job.bytesBase64 == null) return DuplicateOutcome.Refused(DuplicateReason.BYTES_GONE)
        if (job.attemptState == AttemptState.PREPARED || job.attemptState == AttemptState.SENDING) {
            return DuplicateOutcome.Refused(DuplicateReason.ATTEMPT_IN_FLIGHT)
        }

        val now = Iso.format(clock())
        val event = ProductLabelEvent(
            eventId = newId(),
            jobId = job.jobId,
            attemptId = newId(),
            sequence = job.latestSequence + 1,
            shiftId = job.shiftId,
            codeHash = job.codeHash,
            acceptedAt = job.acceptedAt,
            policyRevision = job.policyRevision,
            templateDigest = job.templateDigest,
            payloadDigest = job.payloadDigest,
            operatorId = job.operatorId,
            occurredAt = now,
            kind = EventKind.PREPARED,
            attemptNo = job.attemptNo + 1,
            reason = reason,
            language = job.language,
            dpi = job.dpi,
            bytesDigest = job.bytesDigest,
        )
        val projection = applyProductLabelEvent(job.toProjection(), event, job.verification)
        db.withTransaction {
            db.productLabelJobDao().update(
                job.copy(
                    latestSequence = projection.latestSequence,
                    attemptId = projection.attemptId,
                    attemptNo = projection.attemptNo,
                    attemptState = projection.attemptState,
                    verificationOutcome = projection.verificationOutcome,
                    status = projection.status,
                ),
            )
            db.productLabelEventDao().insert(event.toEntity())
        }
        return DuplicateOutcome.Prepared(job.jobId)
    }

    /**
     * Records that nothing was sent, and why.
     *
     * `failed_before_send` admits ONLY `printer_unconfigured` and
     * `printer_changed`: an event describes what happened to the LABEL, and
     * those two are the cases where the device could not make one at all.
     * «Нет бумаги» is a fact about the printer -- it is kept on the job row and
     * never sent. Sending it made the server reject the whole batch, which
     * wedged the queue for scans and shift closures too, permanently.
     *
     * The attempt therefore stays `prepared` in that case, which is also what
     * lets «Повторить печать» work once the paper is back.
     */
    private suspend fun fail(job: ProductLabelJobEntity, reason: String): DuplicateSend.Failed {
        db.productLabelJobDao().setLastFailure(job.jobId, reason)
        if (reason == DuplicateReason.PRINTER_UNCONFIGURED || reason == DuplicateReason.PRINTER_CHANGED) {
            append(job, EventKind.FAILED_BEFORE_SEND, errorCode = reason)
        }
        return DuplicateSend.Failed(reason)
    }

    /**
     * Appends one event and persists the projection it produces, in a single
     * transaction. A refused transition is a programming error here, not an
     * operator one, so it propagates rather than being swallowed.
     */
    private suspend fun append(
        job: ProductLabelJobEntity,
        kind: String,
        errorCode: String? = null,
        scannedPayloadDigest: String? = null,
        reason: String? = null,
    ): ProductLabelJobEntity {
        val now = Iso.format(clock())
        val event = ProductLabelEvent(
            eventId = newId(),
            jobId = job.jobId,
            attemptId = job.attemptId,
            sequence = job.latestSequence + 1,
            shiftId = job.shiftId,
            codeHash = job.codeHash,
            acceptedAt = job.acceptedAt,
            policyRevision = job.policyRevision,
            templateDigest = job.templateDigest,
            payloadDigest = job.payloadDigest,
            operatorId = job.operatorId,
            occurredAt = now,
            kind = kind,
            errorCode = errorCode,
            scannedPayloadDigest = scannedPayloadDigest,
            reason = reason,
        )
        val projection = applyProductLabelEvent(job.toProjection(), event, job.verification)
        val updated = job.copy(
            latestSequence = projection.latestSequence,
            attemptState = projection.attemptState,
            verificationOutcome = projection.verificationOutcome,
            status = projection.status,
        )
        db.withTransaction {
            db.productLabelJobDao().update(updated)
            db.productLabelEventDao().insert(event.toEntity())
        }
        return updated
    }

    /** Lowercase because the server's schema is `z.uuid().toLowerCase()`. */
    private fun newId(): String = UUID.randomUUID().toString().lowercase()

    private fun ProductLabelEvent.toEntity() = ProductLabelEventEntity(
        eventId = eventId,
        jobId = jobId,
        sequence = sequence,
        kind = kind,
        payloadJson = toWireJson().toString(),
        occurredAt = occurredAt,
        ackedAt = null,
        quarantineCode = null,
    )

    private fun NotReadyReason.wire() = when (this) {
        NotReadyReason.NO_PAPER -> DuplicateReason.NO_PAPER
        NotReadyReason.HEAD_OPEN -> DuplicateReason.HEAD_OPEN
        NotReadyReason.UNREACHABLE -> DuplicateReason.UNREACHABLE
        NotReadyReason.OTHER -> DuplicateReason.TRANSPORT_FAILED
    }
}

fun ProductLabelJobEntity.toProjection() = ProductLabelProjection(
    jobId = jobId,
    shiftId = shiftId,
    codeHash = codeHash,
    acceptedAt = acceptedAt,
    policyRevision = policyRevision,
    templateDigest = templateDigest,
    payloadDigest = payloadDigest,
    bytesDigest = bytesDigest,
    language = language,
    dpi = dpi,
    latestSequence = latestSequence,
    attemptId = attemptId,
    attemptNo = attemptNo,
    attemptState = attemptState,
    verification = verification,
    verificationOutcome = verificationOutcome,
    status = status,
)
