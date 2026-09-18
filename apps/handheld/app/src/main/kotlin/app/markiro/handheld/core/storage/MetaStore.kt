package app.markiro.handheld.core.storage

import java.util.UUID

/** Small key-value store for sync bookkeeping; the install id changes only with the database. */
class MetaStore(private val db: HandheldDatabase) {
    private val dao get() = db.metaDao()
    suspend fun get(key: String): String? = dao.get(key)

    suspend fun put(key: String, value: String) = db.recovery.commit { dao.put(MetaEntity(key, value)) }

    suspend fun remove(key: String) = db.recovery.commit { dao.remove(key) }

    /** Random per-database id that keeps batch ids unique after a wipe that kept the enrollment. */
    suspend fun installId(): String = db.recovery.commit {
        dao.get(INSTALL_ID) ?: UUID.randomUUID().toString().also { dao.put(MetaEntity(INSTALL_ID, it)) }
    }

    companion object {
        const val INSTALL_ID = "install_id"
        const val SYNC_PENDING_BATCH_ID = "sync_pending_batch_id"
        const val SYNC_PENDING_CEILING = "sync_pending_ceiling"
        /** How many box closures the in-flight batch chose, so a retry re-reads the same set. */
        const val SYNC_PENDING_BOX_COUNT = "sync_pending_box_count"
        /** Pallets' own pin, for the identical reason `SYNC_PENDING_BOX_COUNT` exists. */
        const val SYNC_PENDING_PALLET_COUNT = "sync_pending_pallet_count"
        const val SYNC_PENDING_LABEL_COUNT = "sync_pending_label_count"
        const val SYNC_PENDING_EXCEPTION_COUNT = "sync_pending_exception_count"

        /**
         * Pallet corrections' own pin, for the identical reason every other
         * channel here has one: a batch whose id is already fixed must carry
         * the set it chose and no more.
         */
        const val SYNC_PENDING_PALLET_EXCEPTION_COUNT = "sync_pending_pallet_exception_count"
        const val SYNC_LAST_SUCCESS_AT = "sync_last_success_at"
        const val SYNC_LAST_DENIED = "sync_last_denied"
        const val INVENTORY_LAST_SUCCESS_AT = "inventory_sync_last_success_at"

        /**
         * The next write-off `deviceSeq`. Minted inside the same transaction that
         * inserts the outbox row, so a document either has its number or was
         * never filed — never a number without a row, never a row without one.
         */
        const val WRITEOFF_NEXT_DEVICE_SEQ = "writeoff_next_device_seq"
        const val WRITEOFF_LAST_SUCCESS_AT = "writeoff_sync_last_success_at"
        /** When the bootstrap last landed; the «данные на 10:42» stamp. */
        const val WRITEOFF_BOOTSTRAP_AT = "writeoff_bootstrap_at"
        /**
         * The box-registry revision this device has fully applied; the next
         * refresh asks for a delta from here. The stored key keeps its
         * write-off name so an installed device keeps its cursor across the
         * rename of the table it feeds.
         */
        const val BOX_REGISTRY_UNTIL = "writeoff_registry_until"

        /** Memberships' own pin, for the identical reason every other channel here has one. */
        const val SYNC_PENDING_MEMBERSHIP_COUNT = "sync_pending_membership_count"

        /**
         * The membership DTOs a batch in flight actually pinned, as JSON.
         *
         * A count alone is not enough for THIS channel: `WarehousePallets.remove`
         * deletes a membership row at any status, so a `sent` row can vanish
         * while its batch is still in flight. Rebuilding the retry's body from a
         * live `sent()` read would then resend the identical `batchId` with
         * fewer memberships, and the server answers `station_batch_mismatch`
         * (409) forever -- wedging every channel on the device. The snapshot is
         * written under the same commit as the pin, so a local delete cannot
         * change the bytes a pinned batch resends.
         *
         * `SYNC_PENDING_MEMBERSHIP_COUNT` stays the authority on how many rows a
         * pin holds and this key on which bytes they are; a pin left by a build
         * that predates this key is materialised from `sent()` before its first
         * retry, and abandoned if its rows are already gone.
         */
        const val SYNC_PENDING_MEMBERSHIP_SNAPSHOT = "sync_pending_membership_snapshot"

        /** Membership removals' own pin, kept separately for the same reason memberships have one. */
        const val SYNC_PENDING_MEMBERSHIP_REMOVAL_COUNT = "sync_pending_membership_removal_count"

        /** When the pallet bootstrap last landed; the «данные на 10:42» stamp. */
        const val PALLET_BOOTSTRAP_AT = "pallet_bootstrap_at"

        /** The SSCC issuer prefix the pallet bootstrap carried, for locally minted pallet SSCCs. */
        const val PALLET_BOOTSTRAP_ISSUER_PREFIX = "pallet_bootstrap_issuer_prefix"

        /** The in-flight document, so a retry re-sends exactly that row and nothing else. */
        fun writeoffPin(documentId: String) = "writeoff_pending:$documentId"

        /** The pinned inventory batch of one task: re-sent byte for byte until acknowledged. */
        fun inventoryPin(inventoryId: String) = "inventory_pending_batch:$inventoryId"
    }
}
