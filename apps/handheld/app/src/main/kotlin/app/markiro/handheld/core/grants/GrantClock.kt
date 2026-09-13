package app.markiro.handheld.core.grants

data class TrustedClock(val serverMs: Long, val monotonicMs: Long, val bootId: String, val highWaterMs: Long, val wallHighWaterMs: Long)
data class ClockSample(val monotonicMs: Long, val bootId: String, val wallMs: Long)
sealed interface ClockAssessment { data class Trusted(val now: Long) : ClockAssessment; data object Untrusted : ClockAssessment }

fun assessClock(anchor: TrustedClock, sample: ClockSample): ClockAssessment {
    if (!listOf(anchor.serverMs, anchor.monotonicMs, anchor.highWaterMs, anchor.wallHighWaterMs, sample.monotonicMs, sample.wallMs).all(::safe) ||
        anchor.bootId.isEmpty() || sample.bootId != anchor.bootId || anchor.highWaterMs < anchor.serverMs ||
        sample.monotonicMs < anchor.monotonicMs || sample.wallMs < anchor.wallHighWaterMs
    ) return ClockAssessment.Untrusted
    val elapsed = sample.monotonicMs - anchor.monotonicMs
    if (elapsed > JS_MAX_SAFE_INTEGER - anchor.serverMs) return ClockAssessment.Untrusted
    val now = anchor.serverMs + elapsed
    return if (now < anchor.highWaterMs) ClockAssessment.Untrusted else ClockAssessment.Trusted(now)
}
