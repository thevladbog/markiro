package app.markiro.handheld.core.storage

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.PairResponse
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DeviceRecoveryTest {
    private lateinit var db: HandheldDatabase
    private val secrets = InMemoryCredentialStore()
    private var failWrite = false
    private var failStage = false
    private var failClear = false
    private val credential = object : CredentialStore by secrets {
        override fun write(apiKey: String) { check(!failWrite); secrets.write(apiKey) }
        override fun stage(publication: String) { check(!failStage); secrets.stage(publication) }
        override fun clear() { check(!failClear); secrets.clear() }
    }
    private lateinit var recovery: DeviceRecovery
    private val config = syntheticDeviceConfig().copy(activeShiftId = "saved-shift", activeInventoryId = "saved-inventory")
    private fun response(key: String = "new-authorized-key", device: String = config.deviceId, tenant: String = config.tenantId, kind: String = "handheld") =
        PairResponse(DeviceDto(device, "Restored", kind, tenant, "Organization"), CredentialDto(key, config.serverUrl), emptyList())

    @Before fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        recovery = DeviceRecovery(db, credential)
    }
    @After fun close() = db.close()
    private suspend fun active() {
        db.deviceConfigDao().upsert(config)
        secrets.write("old-key")
        recovery.initialize()
    }
    private suspend fun sealed() { active(); recovery.reject(recovery.token()) }

    @Test fun sameOwnerRestoreRetainsTaskReferencesAndRejectsLateOld401() = runTest {
        active()
        val old = recovery.token()
        db.metaDao().put(MetaEntity("pinned-batch", "exact-id-and-digest"))
        recovery.reject(old)
        recovery.restore(response(), config.serverUrl + "/")
        assertFalse(recovery.reject(old))
        assertEquals("new-authorized-key", credential.read())
        assertEquals(old.generation + 1, recovery.token().generation)
        assertEquals("saved-shift", db.deviceConfigDao().get()?.activeShiftId)
        assertEquals("saved-inventory", db.deviceConfigDao().get()?.activeInventoryId)
        assertEquals("exact-id-and-digest", db.metaDao().get("pinned-batch"))
    }

    @Test fun lateSuccessCannotCommitAfterNewCredentialPublication() = runTest {
        active()
        db.metaDao().put(MetaEntity("pin", "original"))
        val entered = CompletableDeferred<Unit>()
        val arrived = CompletableDeferred<Unit>()
        val request = async {
            runCatching { recovery.work { entered.complete(Unit); arrived.await(); recovery.commit { db.metaDao().remove("pin") } } }
        }
        entered.await()
        recovery.reject(recovery.token())
        recovery.restore(response(), config.serverUrl)
        arrived.complete(Unit)
        assertTrue(request.await().exceptionOrNull() is RecoveryBlocked)
        assertEquals("original", db.metaDao().get("pin"))
    }

    @Test fun unknownOwnerNeverAdoptsANewPairing() = runTest {
        db.metaDao().put(MetaEntity("pin", "retained"))
        secrets.write("unbound-secret")
        recovery.initialize()
        assertEquals(RecoveryPhase.OWNER_UNRESOLVED, recovery.current().phase)
        assertNull(credential.read())
        assertTrue(runCatching { recovery.restore(response(), config.serverUrl) }.exceptionOrNull() is RecoveryMismatch)
        assertNull(db.deviceConfigDao().get())
        assertEquals("retained", db.metaDao().get("pin"))
    }

    @Test fun foreignTenantDeviceKindAndOriginCannotTouchLocalState() = runTest {
        sealed()
        val saved = db.deviceRecoveryDao().get()
        for (bad in listOf(response(tenant = "foreign"), response(device = "foreign"), response(kind = "station"))) {
            assertTrue(runCatching { recovery.restore(bad, config.serverUrl) }.exceptionOrNull() is RecoveryMismatch)
            assertEquals(saved, db.deviceRecoveryDao().get())
            assertEquals(config, db.deviceConfigDao().get())
            assertNull(credential.read())
        }
        assertTrue(runCatching { recovery.restore(response(), "https://other.example") }.exceptionOrNull() is RecoveryMismatch)
    }

    @Test fun failedEncryptedPublicationRetainsCandidateAndRetriesInProcess() = runTest {
        sealed()
        failWrite = true
        assertTrue(runCatching { recovery.restore(response(), config.serverUrl) }.isFailure)
        assertEquals(RecoveryPhase.RESTORING, recovery.current().phase)
        assertNotNull(credential.staged())
        assertNull(credential.read())
        failWrite = false
        assertTrue(recovery.resumePublication())
        assertEquals(RecoveryPhase.ACTIVE, recovery.current().phase)
        assertEquals("new-authorized-key", credential.read())
        val generation = recovery.token().generation
        recovery.restore(response(), config.serverUrl)
        assertEquals(generation, recovery.token().generation)
    }

    @Test fun failureBeforeCandidateStageCanRetrySameIntentWithoutGenerationReset() = runTest {
        sealed()
        failStage = true
        assertTrue(runCatching { recovery.restore(response(), config.serverUrl) }.isFailure)
        val generation = recovery.current().generation
        failStage = false
        recovery.restore(response(), config.serverUrl)
        assertEquals(generation, recovery.token().generation)
        assertEquals("new-authorized-key", credential.read())
    }

    @Test fun failedConfigTransactionKeepsPublishedCandidateAndResumesIt() = runTest {
        sealed()
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_config BEFORE UPDATE ON device_config BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
        assertTrue(runCatching { recovery.restore(response(), config.serverUrl) }.isFailure)
        assertEquals("new-authorized-key", credential.read())
        assertEquals(config, db.deviceConfigDao().get())
        assertEquals(RecoveryPhase.RESTORING, recovery.current().phase)
        db.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_config")
        recovery.initialize()
        assertEquals(RecoveryPhase.ACTIVE, recovery.current().phase)
        assertEquals("saved-shift", db.deviceConfigDao().get()?.activeShiftId)
        assertNull(credential.staged())
    }

    @Test fun interruptedSealingFailsClosedAndCanRetryCredentialRemoval() = runTest {
        active()
        val old = recovery.token()
        failClear = true
        assertTrue(runCatching { recovery.reject(old) }.isFailure)
        assertEquals(RecoveryPhase.SEALING, recovery.current().phase)
        assertFalse(recovery.valid(old))
        assertTrue(runCatching { recovery.commit { db.metaDao().put(MetaEntity("bad", "write")) } }.exceptionOrNull() is RecoveryBlocked)
        failClear = false
        recovery.initialize()
        assertEquals(RecoveryPhase.SEALED, recovery.current().phase)
        assertNull(credential.read())
    }

    @Test fun missingCredentialAtUpgradeSealsAndClearsOperatorAuthentication() = runTest {
        db.deviceConfigDao().upsert(config)
        db.operatorDao().insertAll(listOf(OperatorEntity("operator", "Name", "123", "operator", "hash", "badge", true)))
        recovery.initialize()
        assertEquals(RecoveryPhase.SEALED, recovery.current().phase)
        assertTrue(db.operatorDao().all().isEmpty())
        assertEquals(config, db.deviceConfigDao().get())
    }

    @Test fun outstandingPrinterLeaseDrainsButNewWorkIsRefusedImmediately() = runTest {
        active()
        val started = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        val printing = async { recovery.printing { started.complete(Unit); finish.await(); recovery.commit { db.metaDao().put(MetaEntity("print-result", "unknown")) } } }
        started.await()
        val old = recovery.token()
        val rejecting = async { recovery.reject(old) }
        recovery.state.firstPhase(RecoveryPhase.SEALING)
        assertFalse(recovery.valid(old))
        assertFalse(rejecting.isCompleted)
        finish.complete(Unit)
        printing.await()
        assertTrue(rejecting.await())
        assertEquals("unknown", db.metaDao().get("print-result"))
    }


    @Test fun legacyInventoryLocalWinnerOfAnotherDeviceIsUnresolved() = runTest {
        db.deviceConfigDao().upsert(config)
        secrets.write("old-key")
        db.inventoryResultDao().insertIgnore(InventoryResultEntity("i", "snapshot", "hash", "event", "foreign-device", "time", null, "expected", "local", "time"))
        recovery.initialize()
        assertEquals(RecoveryPhase.OWNER_UNRESOLVED, recovery.current().phase)
        assertNull(credential.read())
        assertEquals(1L, db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM inventory_results").use { it.moveToFirst(); it.getLong(0) })
    }

    @Test fun legacyForeignBatchPrefixIsUnresolved() = runTest {
        db.deviceConfigDao().upsert(config)
        secrets.write("old-key")
        db.metaDao().put(MetaEntity(MetaStore.SYNC_PENDING_BATCH_ID, "foreign-device:install:4:0:0:0"))
        recovery.initialize()
        assertEquals(RecoveryPhase.OWNER_UNRESOLVED, recovery.current().phase)
        assertEquals("foreign-device:install:4:0:0:0", db.metaDao().get(MetaStore.SYNC_PENDING_BATCH_ID))
    }

    @Test fun legacyExceptionTerminalOfAnotherDeviceIsUnresolved() = runTest {
        db.deviceConfigDao().upsert(config)
        secrets.write("old-key")
        db.boxExceptionDao().insert(BoxExceptionEntity(kind = "undo", boxId = "box", codeHash = null, targetScannedAt = null,
            shiftId = "shift", operatorId = null, reason = null, occurredAt = "time", payloadJson = """{"terminalId":"foreign-device"}""", afterOutboxId = 0, ackedAt = null))
        recovery.initialize()
        assertEquals(RecoveryPhase.OWNER_UNRESOLVED, recovery.current().phase)
        assertEquals(1, db.boxExceptionDao().unackedCount())
    }

    @Test fun serverReportedForeignInventoryWinnerIsValidConflictEvidence() = runTest {
        db.deviceConfigDao().upsert(config)
        secrets.write("old-key")
        db.inventoryResultDao().insertIgnore(InventoryResultEntity("i", "snapshot", "hash", "event", "other-device", "time", null, "expected", "server", "time"))
        recovery.initialize()
        assertEquals(RecoveryPhase.ACTIVE, recovery.current().phase)
    }

    @Test fun pausedAdmissionClosureCannotDisablePublishedGeneration() = runTest {
        active()
        // Pause after the rejection has observed A but before its atomic closure.
        val observed = recovery.current()
        val proceed = CompletableDeferred<Unit>()
        val stale = async { proceed.await(); recovery.beginSealing(observed) }
        recovery.reject(recovery.token())
        recovery.restore(response(), config.serverUrl)
        val replacement = recovery.token()
        proceed.complete(Unit)
        assertFalse(stale.await())
        assertTrue(recovery.valid(replacement))
        assertEquals("new-authorized-key", credential.read())
        recovery.commit { db.metaDao().put(MetaEntity("replacement-work", "allowed")) }
        assertEquals("allowed", db.metaDao().get("replacement-work"))
    }

    @Test fun firstSealIntentWriteFailureRemainsObservableAndRetriesWithoutEarlySecretRemoval() = runTest {
        active()
        db.metaDao().put(MetaEntity("pin", "exact-evidence"))
        db.operatorDao().insertAll(listOf(OperatorEntity("op", "Name", "123", "operator", "hash", null, true)))
        val token = recovery.token()
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_intent BEFORE INSERT ON device_recovery BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
        assertTrue(runCatching { recovery.reject(token) }.isFailure)
        assertEquals(RecoveryPhase.SEALING, recovery.current().phase)
        assertFalse(recovery.valid(token))
        assertEquals("old-key", credential.read())
        assertEquals(1, db.operatorDao().all().size)
        assertEquals("exact-evidence", db.metaDao().get("pin"))
        assertTrue(runCatching { recovery.commit { db.metaDao().remove("pin") } }.exceptionOrNull() is RecoveryBlocked)
        db.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_intent")
        recovery.initialize()
        assertEquals(RecoveryPhase.SEALED, recovery.current().phase)
        assertNull(credential.read())
        assertTrue(db.operatorDao().all().isEmpty())
        assertEquals("exact-evidence", db.metaDao().get("pin"))
    }

    @Test fun contradictorySealedConfigCannotPublishCredential() = runTest {
        sealed()
        db.deviceConfigDao().upsert(config.copy(tenantId = "foreign"))
        assertTrue(runCatching { recovery.restore(response(), config.serverUrl) }.isFailure)
        assertEquals(RecoveryPhase.OWNER_UNRESOLVED, recovery.current().phase)
        assertNull(credential.read())
        assertEquals("foreign", db.deviceConfigDao().get()?.tenantId)
    }

    @Test fun missingSealedOwnerCannotBecomeFreshPairing() = runTest {
        sealed()
        db.deviceRecoveryDao().put(checkNotNull(db.deviceRecoveryDao().get()).copy(deviceId = null))
        assertTrue(runCatching { recovery.restore(response(), config.serverUrl) }.isFailure)
        assertEquals(RecoveryPhase.OWNER_UNRESOLVED, recovery.current().phase)
        assertNull(credential.read())
    }

    @Test fun freshUnpairedStateMustStillBeEmptyAtPublication() = runTest {
        recovery.initialize()
        db.metaDao().put(MetaEntity("pin", "unowned"))
        assertTrue(runCatching { recovery.restore(response(), config.serverUrl) }.isFailure)
        assertEquals(RecoveryPhase.OWNER_UNRESOLVED, recovery.current().phase)
        assertNull(credential.read())
    }

    @Test fun freshProvisioningRetriesRepeatedStageFailuresToActiveWithOwnerRosterAndWork() = runTest {
        val operator = app.markiro.handheld.core.network.OperatorDto("op", "Name", "123", "operator", "hash", "badge", true)
        val candidate = response().copy(operators = listOf(operator))
        val store = app.markiro.handheld.feature.pairing.RoomProvisioningStore(recovery)
        failStage = true
        repeat(2) { attempt ->
            assertTrue(runCatching { store.persist(candidate, config.serverUrl) }.isFailure)
            assertEquals(RecoveryPhase.RESTORING, recovery.current().phase)
            assertEquals(attempt + 1L, recovery.current().generation)
            assertNull(db.deviceConfigDao().get())
            assertNull(credential.read())
            assertTrue(db.operatorDao().all().isEmpty())
        }
        failStage = false
        store.persist(candidate, config.serverUrl)
        assertEquals(RecoveryPhase.ACTIVE, recovery.current().phase)
        assertEquals(3L, recovery.token().generation)
        assertEquals(DeviceRecovery.ownerOf(config.serverUrl, config.tenantId, config.deviceId, config.kind), recovery.token().owner)
        val saved = checkNotNull(db.deviceConfigDao().get())
        assertEquals(config.deviceId, saved.deviceId)
        assertEquals(config.tenantId, saved.tenantId)
        assertEquals(config.serverUrl, saved.serverUrl)
        assertEquals(config.kind, saved.kind)
        assertEquals(candidate.credential.apiKey, credential.read())
        assertEquals(listOf(OperatorEntity("op", "Name", "123", "operator", "hash", "badge", true)), db.operatorDao().all())
        recovery.commit { db.metaDao().put(MetaEntity("fresh-work", "accepted")) }
        assertEquals("accepted", db.metaDao().get("fresh-work"))
    }

    @Test fun missingConfigWithRetainedEvidenceIsStillUnresolvedAtProvisioningRetry() = runTest {
        sealed()
        db.metaDao().put(MetaEntity("original-evidence", "retained"))
        db.openHelper.writableDatabase.execSQL("DELETE FROM device_config")
        val store = app.markiro.handheld.feature.pairing.RoomProvisioningStore(recovery)
        assertTrue(runCatching { store.persist(response(), config.serverUrl) }.exceptionOrNull() is RecoveryMismatch)
        assertEquals(RecoveryPhase.OWNER_UNRESOLVED, recovery.current().phase)
        assertNull(credential.read())
        assertNull(db.deviceConfigDao().get())
        assertEquals("retained", db.metaDao().get("original-evidence"))
    }

    @Test fun activeOwnerWithoutConfigCannotUseEmptyPublicationException() = runTest {
        active()
        db.openHelper.writableDatabase.execSQL("DELETE FROM device_config")
        val store = app.markiro.handheld.feature.pairing.RoomProvisioningStore(recovery)
        assertTrue(runCatching { store.persist(response(), config.serverUrl) }.exceptionOrNull() is RecoveryMismatch)
        assertEquals(RecoveryPhase.OWNER_UNRESOLVED, recovery.current().phase)
        assertNull(db.deviceConfigDao().get())
        assertNull(credential.read())
    }

    @Test fun summaryUsesEveryActualQueueTable() = runTest {
        active()
        assertEquals(setOf("scans", "inventory", "labels", "boxes", "exceptions", "closes", "conflicts", "unknownPrints"), recovery.summary().keys)
    }
}

private suspend fun kotlinx.coroutines.flow.StateFlow<RecoveryState>.firstPhase(phase: RecoveryPhase) =
    first { it.phase == phase }
