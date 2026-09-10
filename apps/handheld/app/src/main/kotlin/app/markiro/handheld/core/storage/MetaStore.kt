package app.markiro.handheld.core.storage

import java.util.UUID

/** Small key-value store for sync bookkeeping; the install id changes only with the database. */
class MetaStore(private val dao: MetaDao) {
    suspend fun get(key: String): String? = dao.get(key)

    suspend fun put(key: String, value: String) = dao.put(MetaEntity(key, value))

    suspend fun remove(key: String) = dao.remove(key)

    /** Random per-database id that keeps batch ids unique after a wipe that kept the enrollment. */
    suspend fun installId(): String =
        dao.get(INSTALL_ID) ?: UUID.randomUUID().toString().also { dao.put(MetaEntity(INSTALL_ID, it)) }

    companion object {
        const val INSTALL_ID = "install_id"
        const val SYNC_PENDING_BATCH_ID = "sync_pending_batch_id"
        const val SYNC_PENDING_CEILING = "sync_pending_ceiling"
        const val SYNC_LAST_SUCCESS_AT = "sync_last_success_at"
        const val SYNC_LAST_DENIED = "sync_last_denied"
    }
}
