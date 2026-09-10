package app.markiro.handheld.core.scan

/** Collects keyboard-wedge characters into one scan; a long gap between keys starts a new one. */
class WedgeBuffer(private val timeoutMs: Long) {
    private val buffer = StringBuilder()
    private var lastAt = 0L

    fun onChar(c: Char, nowMs: Long): String? {
        if (buffer.isNotEmpty() && nowMs - lastAt > timeoutMs) buffer.setLength(0)
        buffer.append(c)
        lastAt = nowMs
        return null
    }

    fun onEnter(nowMs: Long): String? {
        if (buffer.isEmpty()) return null
        if (nowMs - lastAt > timeoutMs) {
            buffer.setLength(0)
            return null
        }
        val value = buffer.toString()
        buffer.setLength(0)
        return value
    }
}
