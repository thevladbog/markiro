package app.markiro.handheld.core.util

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Locale-neutral clock texts (24-hour, numeric date), shown the same in both languages. */
object TimeText {
    private val hhmm = DateTimeFormatter.ofPattern("HH:mm")
    private val ddmm = DateTimeFormatter.ofPattern("dd.MM HH:mm")

    fun hhmm(epochMillis: Long): String = hhmm.format(Instant.ofEpochMilli(epochMillis).atZone(ZoneId.systemDefault()))

    fun ddmmHhmm(epochMillis: Long): String = ddmm.format(Instant.ofEpochMilli(epochMillis).atZone(ZoneId.systemDefault()))
}
