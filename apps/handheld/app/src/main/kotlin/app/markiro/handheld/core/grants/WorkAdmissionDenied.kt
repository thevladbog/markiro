package app.markiro.handheld.core.grants

/** Expected productive-work refusal. Recovery and cancellation use separate paths. */
abstract class WorkAdmissionDenied(message: String) : IllegalStateException(message)
