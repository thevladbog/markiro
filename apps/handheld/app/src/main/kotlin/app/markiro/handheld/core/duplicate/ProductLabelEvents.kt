package app.markiro.handheld.core.duplicate

import kotlinx.serialization.Serializable

class ProductLabelTransitionException(message: String) : Exception(message)

/** The protocol `validation-dm-duplicate-v1` names; the server matches this exact string. */
const val PRODUCT_LABEL_PROTOCOL = "validation-dm-duplicate-v1"

/**
 * One wire event.
 *
 * The domain models these as a discriminated union with a strict object per
 * kind. One nullable-field class is what kotlinx.serialization encodes without a
 * custom serializer; the nulls are omitted by the encoder's default, so the JSON
 * carries exactly the fields its kind declares and nothing the server would
 * reject.
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
    const val VERIFIED = "verified"
}

private fun invalidTransition(): Nothing =
    throw ProductLabelTransitionException("Product label event does not follow the current attempt")

/** Port of `productLabelStatus` in packages/domain/src/product-labels/state.ts. */
fun productLabelStatus(attempt: String, verification: String, verified: Boolean): String {
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
    if (event.attemptId != current.attemptId || current.verificationOutcome == VerificationOutcome.VERIFIED) {
        return false
    }

    return when (event.kind) {
        EventKind.SENDING, EventKind.FAILED_BEFORE_SEND -> current.attemptState == AttemptState.PREPARED
        EventKind.SENT, EventKind.DELIVERY_UNKNOWN -> current.attemptState == AttemptState.SENDING
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

    val attemptState = if (event.kind == EventKind.VERIFIED || event.kind == EventKind.VERIFICATION_REJECTED) {
        current.attemptState
    } else {
        event.kind
    }
    val outcome = if (event.kind == EventKind.VERIFIED) VerificationOutcome.VERIFIED else current.verificationOutcome
    return current.copy(
        latestSequence = event.sequence,
        attemptState = attemptState,
        verificationOutcome = outcome,
        status = productLabelStatus(attemptState, verification, outcome == VerificationOutcome.VERIFIED),
    )
}
