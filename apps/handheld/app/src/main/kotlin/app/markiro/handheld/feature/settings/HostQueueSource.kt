package app.markiro.handheld.feature.settings

import app.markiro.handheld.core.network.host.HostReceiptCode
import app.markiro.handheld.core.network.host.RejectionHint
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostOutboxEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject

/** A record of the host's queue as the screen reads it. [hint] is set for a quarantined record only; [code] is the host's own word for support. */
data class HostQueueItem(
    val recordId: String,
    val kind: String,
    val quarantined: Boolean,
    val code: String?,
    val hint: RejectionHint?,
    val subject: String?,
    val createdAt: String,
)

/**
 * The rows of `host_outbox` for the «Очередь» screen: what waits for the host and what the host refused (kept for support, never blocking the
 * rest). The body of a record is handed out only to be passed to support, as the device froze it.
 */
class HostQueueSource @Inject constructor(private val db: HandheldDatabase) {
    fun observe(): Flow<List<HostQueueItem>> = db.hostOutboxDao().observeAll().map { rows -> rows.map(::item) }

    /** The record exactly as it was frozen; it carries ids, times and codes of marking, never the device's key, a PIN or a badge. */
    suspend fun exportBody(recordId: String): String? = db.hostOutboxDao().get(recordId)?.body

    private fun item(row: HostOutboxEntity): HostQueueItem = HostQueueItem(
        recordId = row.recordId,
        kind = row.kind,
        quarantined = row.state == "quarantined",
        code = row.reason,
        hint = if (row.state == "quarantined") HostReceiptCode.hintOf(row.reason) else null,
        subject = subjectOf(row),
        createdAt = row.createdAt,
    )

    /** The box, the pallet or the shift the record is about, as a short tail an operator can match with the paper. */
    private fun subjectOf(row: HostOutboxEntity): String? {
        val data = runCatching { Json.parseToJsonElement(row.body).jsonObject["data"]?.jsonObject }.getOrNull() ?: return null
        val key = listOf("boxSscc", "sscc", "boxId", "palletId").firstNotNullOfOrNull { data[it]?.jsonPrimitive?.contentOrNull } ?: return null
        return key.takeLast(TAIL)
    }

    private companion object {
        const val TAIL = 6
    }
}
