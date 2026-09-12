package app.markiro.handheld.core.storage

import androidx.room.withTransaction

/** Brief 07: a revoked or unbound device drops its credential and cache and returns to pairing. */
class DeviceWipe(private val db: HandheldDatabase, private val credential: CredentialStore) {
    suspend fun wipeAll() {
        credential.clear()
        db.withTransaction {
            db.printerDao().clear()
            db.boxDao().clear()
            db.ssccPoolDao().clear()
            db.palletDao().clear()
            // The duplicate flow carries no credential-ownership column precisely
            // because a revoked device keeps nothing. That is only true while
            // these two lines are here.
            db.productLabelEventDao().clear()
            db.productLabelJobDao().clear()
            db.outboxDao().clear()
            db.scanEventDao().clear()
            db.codeDao().clear()
            db.conflictDao().clear()
            db.shiftCloseDao().clear()
            db.shiftDao().clear()
            db.inventoryOutboxDao().clear()
            db.inventoryEventDao().clear()
            db.inventoryResultDao().clear()
            db.inventoryTerminalStateDao().clear()
            db.inventorySnapshotCodeDao().clear()
            db.inventoryTaskDao().clear()
            db.metaDao().clear()
            db.operatorDao().clear()
            db.deviceConfigDao().clear()
        }
    }
}
