package app.markiro.handheld.core.util

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Locale-neutral clock texts (24-hour, numeric date), shown the same in both languages. */
object TimeText {
    private val hhmm = DateTimeFormatter.ofPattern("HH:mm")
    private val hhmmss = DateTimeFormatter.ofPattern("HH:mm:ss")
    private val ddmm = DateTimeFormatter.ofPattern("dd.MM HH:mm")

    fun hhmm(epochMillis: Long): String = hhmm.format(Instant.ofEpochMilli(epochMillis).atZone(ZoneId.systemDefault()))

    /**
     * Seconds included on purpose: this names one scan among several taken
     * moments apart, and the minute alone would not tell them apart.
     */
    fun hhmmss(epochMillis: Long): String = hhmmss.format(Instant.ofEpochMilli(epochMillis).atZone(ZoneId.systemDefault()))

    fun ddmmHhmm(epochMillis: Long): String = ddmm.format(Instant.ofEpochMilli(epochMillis).atZone(ZoneId.systemDefault()))
}
