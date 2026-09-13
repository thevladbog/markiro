package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.network.ErrorBody
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.network.VALIDATION_REPROCESSING_PROTOCOL
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ValidationHistoryEntity
import app.markiro.handheld.core.storage.ValidationHistoryPublication
import app.markiro.handheld.core.util.Iso
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import retrofit2.HttpException
import java.io.IOException
import java.util.UUID

/** At most one page lives in memory. Room activates only a complete, consistent publication. */
class ValidationHistoryMirror(private val db: HandheldDatabase, private val api: StationApi, private val json: Json) {
    private val mutex = Mutex()
    private val hashPattern = Regex("[0-9a-f]{64}")
    private val kinds = setOf("original", "reprocessing")
    private val statuses = setOf("planned", "active", "closed")
    suspend fun refresh(shiftId: String, productId: String): Boolean = db.recovery.work { mutex.withLock {
        // Clean interrupted stages from a previous process; an active publication is never deleted.
        db.recovery.commit { db.validationDao().dropUnpublished() }
        for (restart in 0..1) {
            val publication = UUID.randomUUID().toString()
            try {
                var snapshot: String? = null
                var cursor: String? = null
                var fetchedAt: String? = null
                var expiresAt: String? = null
                var pages = 0
                do {
                    val page = api.codeHistory(shiftId, cursor, snapshot, 1000)
                    if (page.protocol != VALIDATION_REPROCESSING_PROTOCOL || page.shiftId != shiftId || page.productId != productId ||
                        !page.snapshot.matches(hashPattern) || Iso.parse(page.fetchedAt) == null || Iso.parse(page.expiresAt) == null ||
                        (snapshot != null && (page.snapshot != snapshot || page.fetchedAt != fetchedAt || page.expiresAt != expiresAt)) ||
                        page.complete != (page.nextCursor == null) || page.items.size > 1000 ||
                        (page.nextCursor != null && (page.nextCursor == cursor || page.nextCursor.isEmpty())) || ++pages > 100_000 ||
                        page.items.any { !it.codeHash.matches(hashPattern) || it.kind !in kinds ||
                            it.shiftStatus !in statuses || Iso.parse(it.scannedAt) == null }) return@withLock false
                    snapshot = page.snapshot; fetchedAt = page.fetchedAt; expiresAt = page.expiresAt
                    db.recovery.commit {
                        db.validationDao().stage(page.items.map { ValidationHistoryEntity(publication, it.codeHash, it.kind, it.shiftId, it.shiftNumber, it.shiftStatus, it.scannedAt) })
                        if (page.complete) {
                            db.validationDao().publish(ValidationHistoryPublication(shiftId, productId, publication, page.snapshot, page.fetchedAt, page.expiresAt))
                            db.validationDao().dropUnpublished()
                        }
                    }
                    cursor = page.nextCursor
                } while (cursor != null)
                return@withLock true
            } catch (e: HttpException) {
                val code = runCatching { json.decodeFromString(ErrorBody.serializer(), e.response()?.errorBody()?.string().orEmpty()).code }.getOrNull()
                if (e.code() != 409 || code != "VALIDATION_HISTORY_EXPIRED" || restart == 1) return@withLock false
            } catch (_: android.database.sqlite.SQLiteConstraintException) {
                // Duplicate identities across pages invalidate this snapshot, not the previous cache.
                return@withLock false
            } catch (_: IOException) {
                return@withLock false
            } catch (_: kotlinx.serialization.SerializationException) {
                return@withLock false
            } finally {
                db.recovery.commit { db.validationDao().dropStage(publication) }
            }
        }
        false
    } }
}
