package app.markiro.handheld.core.util

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/** ISO-8601 UTC with milliseconds, the form the station sends and zod's `datetime()` accepts. */
object Iso {
    private val formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    fun format(epochMillis: Long): String = formatter.format(Instant.ofEpochMilli(epochMillis))

    fun parse(value: String): Long? = runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
}
