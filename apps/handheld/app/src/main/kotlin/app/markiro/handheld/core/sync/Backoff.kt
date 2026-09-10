package app.markiro.handheld.core.sync

/** 2 s, 4 s, … capped; reset on success. Same numbers as the station's sync.ts. */
class Backoff(private val startMs: Long = 2_000, private val capMs: Long = 60_000) {
    private var current = startMs

    fun nextDelay(): Long {
        val delay = current
        current = minOf(current * 2, capMs)
        return delay
    }

    fun reset() {
        current = startMs
    }
}
