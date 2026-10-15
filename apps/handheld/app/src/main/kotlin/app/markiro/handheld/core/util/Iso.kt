package app.markiro.handheld.core.util

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/** ISO-8601 UTC with milliseconds, the form the station sends and zod's `datetime()` accepts. */
object Iso {
    private val formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    fun format(epochMillis: Long): String = formatter.format(Instant.ofEpochMilli(epochMillis))

    fun parse(value: String): Long? = runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()

    /** Exactly what the host reads as a device's instant (`rules::device_instant`): 24 characters, an UTC instant with milliseconds, written back the same. */
    fun isDeviceInstant(text: String): Boolean {
        if (text.length != 24) return false
        val millis = parse(text) ?: return false
        return format(millis) == text
    }
}
