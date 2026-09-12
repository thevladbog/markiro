package app.markiro.handheld.core.duplicate

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class ProductLabelTransitionException(message: String) : Exception(message)

/** The protocol `validation-dm-duplicate-v1` names; the server matches this exact string. */
const val PRODUCT_LABEL_PROTOCOL = "validation-dm-duplicate-v1"

/**
 * One event, as this device holds it.
 *
 * The domain models these as a discriminated union with a strict object per
 * kind; one nullable-field class is what Kotlin can project over without a
 * custom serializer. It is NOT the wire shape -- see `toWireJson`, which builds
 * exactly the fields each kind declares.
 */
@Serializable
data class ProductLabelEvent(
    val eventId: String,
    val jobId: String,
    val attemptId: String,
    val sequence: Int,
    val shiftId: String,
    val codeHash: String,
    val acceptedAt: String,
    val policyRevision: String,
    val templateDigest: String,
    val payloadDigest: String,
    val operatorId: String,
    val occurredAt: String,
    val kind: String,
    val attemptNo: Int? = null,
    /** The reprint reason on `prepared`, the rejection reason on `verification_rejected`. */
    val reason: String? = null,
    val language: String? = null,
    val dpi: Int? = null,
    val bytesDigest: String? = null,
    val errorCode: String? = null,
    val scannedPayloadDigest: String? = null,
)

/**
 * The exact object the server expects for this event's kind.
 *
 * Built by hand rather than by the serializer because the two disagree about
 * null: the schema is a strict object PER KIND, so `prepared` must carry
 * `reason` even when it is null, while `sending` must not carry it at all.
 * Automatic encoding omits every null and would drop the first, or encode
 * every field and add the second.
 */
fun ProductLabelEvent.toWireJson(): JsonObject = buildJsonObject {
    put("eventId", eventId)
    put("jobId", jobId)
    put("attemptId", attemptId)
    put("sequence", sequence)
    put("shiftId", shiftId)
    put("codeHash", codeHash)
    put("acceptedAt", acceptedAt)
    put("policyRevision", policyRevision)
    put("templateDigest", templateDigest)
    put("payloadDigest", payloadDigest)
    put("operatorId", operatorId)
    put("occurredAt", occurredAt)
    put("kind", kind)
    when (kind) {
        EventKind.PREPARED -> {
            put("attemptNo", requireNotNull(attemptNo))
            if (reason == null) put("reason", JsonNull) else put("reason", reason)
            put("language", requireNotNull(language))
            put("dpi", requireNotNull(dpi))
            put("bytesDigest", requireNotNull(bytesDigest))
        }
        EventKind.FAILED_BEFORE_SEND, EventKind.DELIVERY_UNKNOWN -> put("errorCode", requireNotNull(errorCode))
        EventKind.VERIFIED -> put("scannedPayloadDigest", requireNotNull(scannedPayloadDigest))
        EventKind.VERIFICATION_REJECTED -> put("reason", requireNotNull(reason))
        else -> Unit
    }
}

/** Immutable origin and print context alongside the current attempt's state. */
data class ProductLabelProjection(
    val jobId: String,
    val shiftId: String,
    val codeHash: String,
    val acceptedAt: String,
    val policyRevision: String,
    val templateDigest: String,
    val payloadDigest: String,
    val bytesDigest: String,
    val language: String,
    val dpi: Int,
    val latestSequence: Int,
    val attemptId: String,
    val attemptNo: Int,
    val attemptState: String,
    val verification: String,
    val verificationOutcome: String,
    val status: String,
)

object EventKind {
    const val PREPARED = "prepared"
    const val SENDING = "sending"
    const val SENT = "sent"
    const val FAILED_BEFORE_SEND = "failed_before_send"
    const val DELIVERY_UNKNOWN = "delivery_unknown"
    const val VERIFIED = "verified"
    const val VERIFICATION_SKIPPED = "verification_skipped"
    const val VERIFICATION_REJECTED = "verification_rejected"
}

object AttemptState {
    const val PREPARED = "prepared"
    const val SENDING = "sending"
    const val SENT = "sent"
    const val FAILED_BEFORE_SEND = "failed_before_send"
    const val DELIVERY_UNKNOWN = "delivery_unknown"
}

object JobStatus {
    const val PREPARED = "prepared"
    const val SENDING = "sending"
    const val AWAITING_VERIFICATION = "awaiting_verification"

    /** A resting state, not a terminal one: a damaged label still takes a reprint. */
    const val COMPLETED = "completed"
    const val ATTENTION = "attention"
}

object Verification {
    const val NONE = "none"
    const val REQUIRED = "required"
}

object VerificationOutcome {
    const val NOT_REQUIRED = "not_required"
    const val PENDING = "pending"
    const val SKIPPED = "skipped"
    const val VERIFIED = "verified"
}

private fun invalidTransition(): Nothing =
    throw ProductLabelTransitionException("Product label event does not follow the current attempt")

/** Port of `productLabelStatus` in packages/domain/src/product-labels/state.ts. */
fun productLabelStatus(attempt: String, verification: String, verified: Boolean, skipped: Boolean = false): String {
    if (skipped) {
        if (verified || attempt != AttemptState.SENT || verification != Verification.REQUIRED) invalidTransition()
        return JobStatus.COMPLETED
    }
    if (verified) {
        if (attempt != AttemptState.SENT && attempt != AttemptState.DELIVERY_UNKNOWN) invalidTransition()
        return JobStatus.COMPLETED
    }
    return when (attempt) {
        AttemptState.PREPARED -> JobStatus.PREPARED
        AttemptState.SENDING -> JobStatus.SENDING
        AttemptState.SENT ->
            if (verification == Verification.REQUIRED) JobStatus.AWAITING_VERIFICATION else JobStatus.COMPLETED
        else -> JobStatus.ATTENTION
    }
}

private fun originMatches(current: ProductLabelProjection, event: ProductLabelEvent): Boolean =
    current.jobId == event.jobId &&
        current.shiftId == event.shiftId &&
        current.codeHash == event.codeHash &&
        current.acceptedAt == event.acceptedAt &&
        current.policyRevision == event.policyRevision &&
        current.templateDigest == event.templateDigest &&
        current.payloadDigest == event.payloadDigest

/**
 * Port of `canApplyProductLabelEvent`. Storage handles replay by event id before
 * calling this; only the next new event may advance.
 *
 * Note the order: a `prepared` returns before the `verificationOutcome` guard,
 * which is why a verified job still takes a reprint while a verified ATTEMPT
 * takes nothing.
 */
fun canApplyProductLabelEvent(current: ProductLabelProjection, event: ProductLabelEvent): Boolean {
    if (event.sequence != current.latestSequence + 1 || !originMatches(current, event)) return false

    if (event.kind == EventKind.PREPARED) {
        return current.attemptState != AttemptState.SENDING &&
            current.attemptState != AttemptState.PREPARED &&
            event.attemptId != current.attemptId &&
            event.attemptNo == current.attemptNo + 1 &&
            event.reason != null &&
            event.bytesDigest == current.bytesDigest &&
            event.language == current.language &&
            event.dpi == current.dpi
    }
    if (event.attemptId != current.attemptId || (current.verificationOutcome == VerificationOutcome.VERIFIED || current.verificationOutcome == VerificationOutcome.SKIPPED)) {
        return false
    }

    return when (event.kind) {
        EventKind.SENDING, EventKind.FAILED_BEFORE_SEND -> current.attemptState == AttemptState.PREPARED
        EventKind.SENT, EventKind.DELIVERY_UNKNOWN -> current.attemptState == AttemptState.SENDING
        EventKind.VERIFICATION_SKIPPED -> current.attemptState == AttemptState.SENT && current.verification == Verification.REQUIRED
        EventKind.VERIFIED, EventKind.VERIFICATION_REJECTED -> {
            // A scan also resolves an unknown delivery, under EITHER policy: it is
            // how "did a label come out?" gets answered without a reprint.
            val canVerify = current.attemptState == AttemptState.DELIVERY_UNKNOWN ||
                (current.attemptState == AttemptState.SENT && current.verification == Verification.REQUIRED)
            canVerify &&
                (event.kind != EventKind.VERIFIED || event.scannedPayloadDigest == current.payloadDigest)
        }
        else -> false
    }
}

/** Port of `applyProductLabelEvent`. */
fun applyProductLabelEvent(
    current: ProductLabelProjection?,
    event: ProductLabelEvent,
    verification: String,
): ProductLabelProjection {
    val pendingOrNot = if (verification == Verification.REQUIRED) {
        VerificationOutcome.PENDING
    } else {
        VerificationOutcome.NOT_REQUIRED
    }

    if (current == null) {
        if (event.kind != EventKind.PREPARED || event.sequence != 1 || event.attemptNo != 1 || event.reason != null) {
            invalidTransition()
        }
        return ProductLabelProjection(
            jobId = event.jobId,
            shiftId = event.shiftId,
            codeHash = event.codeHash,
            acceptedAt = event.acceptedAt,
            policyRevision = event.policyRevision,
            templateDigest = event.templateDigest,
            payloadDigest = event.payloadDigest,
            bytesDigest = event.bytesDigest ?: invalidTransition(),
            language = event.language ?: invalidTransition(),
            dpi = event.dpi ?: invalidTransition(),
            latestSequence = 1,
            attemptId = event.attemptId,
            attemptNo = 1,
            attemptState = AttemptState.PREPARED,
            verification = verification,
            verificationOutcome = pendingOrNot,
            status = JobStatus.PREPARED,
        )
    }
    if (current.verification != verification || !canApplyProductLabelEvent(current, event)) invalidTransition()

    if (event.kind == EventKind.PREPARED) {
        return current.copy(
            latestSequence = event.sequence,
            attemptId = event.attemptId,
            attemptNo = event.attemptNo ?: invalidTransition(),
            attemptState = AttemptState.PREPARED,
            status = JobStatus.PREPARED,
            verificationOutcome = pendingOrNot,
        )
    }

    val attemptState = if (event.kind == EventKind.VERIFIED || event.kind == EventKind.VERIFICATION_REJECTED || event.kind == EventKind.VERIFICATION_SKIPPED) {
        current.attemptState
    } else {
        event.kind
    }
    val outcome = when (event.kind) {
        EventKind.VERIFIED -> VerificationOutcome.VERIFIED
        EventKind.VERIFICATION_SKIPPED -> VerificationOutcome.SKIPPED
        else -> current.verificationOutcome
    }
    return current.copy(
        latestSequence = event.sequence,
        attemptState = attemptState,
        verificationOutcome = outcome,
        status = productLabelStatus(attemptState, verification, outcome == VerificationOutcome.VERIFIED, outcome == VerificationOutcome.SKIPPED),
    )
}
