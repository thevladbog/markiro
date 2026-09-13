package app.markiro.handheld.core.grants

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.InMemoryCredentialStore
import app.markiro.handheld.core.storage.syntheticDeviceConfig
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.serialization.json.*
import java.util.Base64
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GrantStoreTest {
    @Test fun absentConfigurationObservesAndRecordsEvidenceWithoutBlocking() = runTest {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        try {
            val credentials = InMemoryCredentialStore().also { it.write("test-key") }
            db.deviceConfigDao().upsert(syntheticDeviceConfig())
            DeviceRecovery(db, credentials).initialize()
            db.recovery.commit { db.grants.complete(TaskKind.SHIFT, "shift", "event", GrantEventType.SHIFT_SCAN, units = 1) }
            assertEquals("observe", db.grantDao().evidence().single().mode)
            assertEquals("MISSING_GRANT", db.grantDao().evidence().single().reason)
        } finally { db.close() }
    }

    private suspend fun database(): HandheldDatabase {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(syntheticDeviceConfig())
        DeviceRecovery(db,InMemoryCredentialStore().also { it.write("test-key") }).initialize()
        db.grants.sample = { ClockSample(100,"boot",1000) }
        return db
    }

    private suspend fun strict(db: HandheldDatabase, maximum: Long = 1, id: String = "grant") {
        val token = db.recovery.token(); val owner = token.owner.grantOwnerKey()
        db.grantDao().state(GrantStateEntity(ownerKey=owner,generation=token.generation,epoch=3,mode="strict",requestedSequence=0,installedSequence=0,keysetRevision="r",retiredKids="[]",keysetJson="{}",serverMs=1000,monotonicMs=100,bootId="boot",serverHighWater=1000,wallHighWater=1000,clockValid=true))
        val payload = buildJsonObject {
            put("version",1); put("issuer",token.owner.serverOrigin); put("grantId",id); put("tenantId",token.owner.tenantId); put("deviceId",token.owner.deviceId); put("kind","handheld"); put("credentialEpoch",3)
            put("entitlementRevision","e"); put("policyRevision","p"); put("issuedAt",900); put("notBefore",900); put("kindOfGrant","task"); put("taskKind","shift"); put("taskId","shift"); put("snapshotDigest","unbound"); put("completeNotAfter",2000)
            put("eventTypes",JsonArray(listOf(JsonPrimitive("shift.scan.v1"))))
            put("budget",JsonArray(listOf("events" to "event","units" to "unit").map { (suffix,unit) -> buildJsonObject { put("id","shift.scan.v1:$suffix"); put("unit",unit); put("maximum",maximum) } }))
        }
        fun encode(text: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(text.toByteArray())
        val compact = encode("""{"typ":"markiro-offline-grant+jws","alg":"ES256","kid":"test"}""") + "." + encode(payload.toString()) + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(64))
        db.grantDao().token(GrantTokenEntity(grantSlot(owner,"shift","shift"),owner,token.generation,3,"shift","shift","unbound","test",compact))
    }

    @Test fun lastUnitIsAtomicAndExactReplayDoesNotChargeAgain() = runTest {
        val db = database()
        try {
            strict(db)
            val outcomes = listOf("a","b").map { event -> async { runCatching { db.grants.complete(TaskKind.SHIFT,"shift",event,GrantEventType.SHIFT_SCAN,units=1) } } }.awaitAll()
            assertEquals(1,outcomes.count { it.isSuccess })
            assertEquals(1,outcomes.count { it.exceptionOrNull() is GrantDenied })
            val admitted = db.grantDao().evidence().single { it.reason == null }
            db.grants.complete(TaskKind.SHIFT,"shift",admitted.eventId,GrantEventType.SHIFT_SCAN,units=1)
            assertEquals(listOf(1L,1L), db.grantDao().counters(admitted.ownerKey,"shift","shift","unbound").map { it.consumed }.sorted())
            strict(db,id="renewed")
            assertTrue(runCatching { db.grants.complete(TaskKind.SHIFT,"shift","new",GrantEventType.SHIFT_SCAN,units=1) }.exceptionOrNull() is GrantDenied)
        } finally { db.close() }
    }

    @Test fun businessRollbackRestoresCountersAndEvidenceButDenialPreservesClock() = runTest {
        val db = database()
        try {
            strict(db)
            assertTrue(runCatching { db.recovery.commit {
                db.grants.complete(TaskKind.SHIFT,"shift","rollback",GrantEventType.SHIFT_SCAN,units=1)
                error("business failure")
            } }.isFailure)
            assertTrue(db.grantDao().evidence().isEmpty())
            db.grants.sample = { ClockSample(110,"boot",1010) }
            db.grants.complete(TaskKind.SHIFT,"shift","first",GrantEventType.SHIFT_SCAN,units=1)
            db.grants.sample = { ClockSample(120,"boot",1020) }
            assertTrue(runCatching { db.grants.complete(TaskKind.SHIFT,"shift","denied",GrantEventType.SHIFT_SCAN,units=1) }.exceptionOrNull() is GrantDenied)
            assertEquals(1020L,db.grantDao().state()?.serverHighWater)
            assertEquals("BUDGET_EXHAUSTED",db.grantDao().evidence().single { it.eventId == "denied" }.reason)
        } finally { db.close() }
    }

    @Test fun sealingDuringDenialNeverPublishesPostRollbackDiagnosticOrAuthority() = runTest {
        val db=database()
        try {
            strict(db)
            db.grants.sample={ db.recovery.beginSealing(db.recovery.current()); ClockSample(110,"boot",1010) }
            val denied=runCatching { db.grants.complete(TaskKind.SHIFT,"shift","sealing",GrantEventType.SHIFT_SCAN,units=2) }.exceptionOrNull()
            assertTrue(denied is GrantDenied)
            assertTrue(db.grantDao().evidence().isEmpty())
            assertEquals(1000L,db.grantDao().state()?.serverHighWater)
            assertFalse(db.recovery.valid(app.markiro.handheld.core.storage.GenerationToken(checkNotNull(db.recovery.current().owner),db.recovery.current().generation)))
        } finally { db.close() }
    }

    @Test fun typedUiDenialStopsOnlyTheRejectedActionAndDoesNotSwallowUnrelatedErrors() = runTest {
        val db=database()
        try {
            strict(db)
            val ui=GrantDenialUi()
            ui.guard { db.grants.complete(TaskKind.SHIFT,"shift","ui",GrantEventType.SHIFT_SCAN,units=2) }
            assertTrue(ui.isVisible.value)
            val primary=IllegalStateException("unrelated")
            assertSame(primary,runCatching { ui.guard { throw primary } }.exceptionOrNull())
        } finally { db.close() }
    }
}
