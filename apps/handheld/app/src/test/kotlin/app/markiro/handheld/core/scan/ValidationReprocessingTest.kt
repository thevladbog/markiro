package app.markiro.handheld.core.scan

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.ValidationPrintDto
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import app.markiro.handheld.core.storage.*
import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ValidationReprocessingTest {
    @Test fun closedOriginalIsAcceptedOnceOnlyWhenEnabledWithoutTransferringOwnership() = runTest {
        for (enabled in listOf(false, true)) {
            val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
            db.initializeRecoveryForTest()
            try {
                val shift = ShiftEntityFixtures.bundled("s1").copy(validationPrintMode="duplicate_dm", allowPreviouslyAcceptedCodes=enabled)
                val raw = "010460068200001321repeat\u001d93CRYPTO"
                val km = KmCodec.canonicalize(raw); val hash = KmCodec.hash(km)
                val old = CodeEntity(hash,"old",km.gtin14,km.serial,"2026-09-01T00:00:00Z")
                db.codeDao().insert(old)
                db.shiftDao().upsert(shift)
                // Only server history confirms closure; the source need not be cached as a shift.
                db.validationDao().stage(listOf(ValidationHistoryEntity("pub",hash,"original","old","OLD-001","closed",old.scannedAt)))
                db.validationDao().publish(ValidationHistoryPublication("s1","p1","pub","a".repeat(64),"2026-09-12T00:00:00Z","2026-09-12T01:00:00Z"))
                val recorder = ScanRecorder(db)
                assertEquals(if(enabled) Verdict.OK else Verdict.DUPLICATE,recorder.record(shift,raw,"operator").verdict)
                assertEquals(old,db.codeDao().get(hash))
                assertEquals(if(enabled) 1 else 0,db.codeDao().countForShift("s1"))
                if(enabled) {
                    assertEquals(raw,db.validationDao().get("s1",hash)?.raw)
                    assertEquals("old",db.validationDao().get("s1",hash)?.sourceShiftId)
                    assertEquals("pending",db.validationDao().get("s1",hash)?.outcome)
                }
                assertEquals(Verdict.DUPLICATE,recorder.record(shift,raw,"operator").verdict)
            } finally { db.close() }
        }
    }
    private suspend fun withDb(block: suspend (HandheldDatabase) -> Unit) {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
        try { block(db) } finally { db.close() }
    }

    @Test fun activeOriginalActiveProcessingAndLocallyClosedUnconfirmedSourceAreRefused() = runTest {
        for (scenario in listOf("active-original","active-repeat","unconfirmed")) withDb { db ->
            val shift = ShiftEntityFixtures.bundled("s1").copy(validationPrintMode="duplicate_dm",allowPreviouslyAcceptedCodes=true)
            db.shiftDao().upsert(shift)
            val raw="010460068200001321active\u001d93CRYPTO"
            val km=KmCodec.canonicalize(raw); val hash=KmCodec.hash(km)
            if(scenario == "unconfirmed") {
                db.codeDao().insert(CodeEntity(hash,"old",km.gtin14,km.serial,"2026-09-01T00:00:00Z"))
                db.shiftDao().upsert(ShiftEntityFixtures.bundled("old").copy(status="closed"))
            } else {
                db.validationDao().stage(listOf(ValidationHistoryEntity("pub",hash,if(scenario=="active-repeat") "reprocessing" else "original","old","OLD-001","active","2026-09-01T00:00:00Z")))
                db.validationDao().publish(ValidationHistoryPublication("s1","p1","pub","a".repeat(64),"2026-09-12T00:00:00Z","2026-09-12T01:00:00Z"))
            }
            val out=ScanRecorder(db).record(shift,raw,null)
            assertEquals(Verdict.DUPLICATE,out.verdict)
            assertEquals(if(scenario=="unconfirmed") ValidationRefusal.CLOSURE_UNKNOWN else ValidationRefusal.OTHER_ACTIVE,out.refusal)
            assertEquals(0,db.codeDao().countForShift("s1"))
            assertNull(db.validationDao().get("s1",hash))
            assertNull(db.outboxDao().head(1).single().codeHash)
        }
    }

    @Test fun releaseRemovesOrdinaryBlockerBeforeAndAfterPendingReceiptButNeverAnActiveRepeat() = runTest {
        for (repeat in listOf(false,true)) for(pending in listOf(false,true)) withDb { db ->
            val raw="010460068200001321released\u001d93CRYPTO"; val km=KmCodec.canonicalize(raw); val hash=KmCodec.hash(km)
            val first=ShiftEntityFixtures.bundled("s1").copy(validationPrintMode="duplicate_dm")
            val second=first.copy(id="s2")
            db.shiftDao().upsert(first); db.shiftDao().upsert(second)
            val out=ScanRecorder(db).record(first,raw,null)
            val outcome=if(repeat) "reprocessed" else "first_accepted"
            db.applyValidationReceipt(app.markiro.handheld.core.network.ValidationOccurrenceReceipt(first.id,hash,out.scannedAt,outcome))
            db.codeDao().delete(hash)
            if(pending) db.applyValidationReceipt(app.markiro.handheld.core.network.ValidationOccurrenceReceipt(first.id,hash,out.scannedAt,"pending"))
            assertEquals(if(repeat) Verdict.DUPLICATE else Verdict.OK, ScanRecorder(db).record(second,raw,null).verdict)
            assertEquals(if(repeat) 1 else 0,db.codeDao().countForShift(first.id))
            assertNotNull(db.validationDao().get(first.id,hash))
            // An old accepted first receipt replay cannot restore released ownership.
            if(!repeat) {
                db.applyValidationReceipt(app.markiro.handheld.core.network.ValidationOccurrenceReceipt(first.id,hash,out.scannedAt,"first_accepted"))
                assertEquals(second.id,db.codeDao().get(hash)?.shiftId)
            }
        }
    }

    @Test fun lateConflictPreservesRawEvidenceAndOtherOriginalButRemovesOnlyCurrentCount() = runTest { withDb { db ->
        val raw="010460068200001321late\u001d93CRYPTO"; val km=KmCodec.canonicalize(raw); val hash=KmCodec.hash(km)
        val shift=ShiftEntityFixtures.bundled("s1").copy(validationPrintMode="duplicate_dm")
        db.shiftDao().upsert(shift)
        val out=ScanRecorder(db).record(shift,raw,"op")
        db.applyValidationReceipt(app.markiro.handheld.core.network.ValidationOccurrenceReceipt(shift.id,hash,out.scannedAt,"reprocessed"))
        val old=CodeEntity(hash,"old",km.gtin14,km.serial,"2026-09-01T00:00:00Z")
        db.codeDao().insert(old)
        db.applyValidationReceipt(app.markiro.handheld.core.network.ValidationOccurrenceReceipt(shift.id,hash,out.scannedAt,"conflict"))
        assertEquals(0,db.codeDao().countForShift(shift.id)); assertEquals(old,db.codeDao().get(hash))
        assertEquals(raw,db.validationDao().get(shift.id,hash)?.raw)
        db.applyValidationReceipt(app.markiro.handheld.core.network.ValidationOccurrenceReceipt(shift.id,hash,out.scannedAt,"first_accepted"))
        assertEquals("conflict",db.validationDao().get(shift.id,hash)?.outcome)
    } }

    @Test fun transactionFailureRollsBackOccurrenceOriginalAndJournalTogether() = runTest { withDb { db ->
        val shift=ShiftEntityFixtures.bundled("s1").copy(validationPrintMode="duplicate_dm")
        db.shiftDao().upsert(shift)
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'probe'); END")
        assertTrue(runCatching { ScanRecorder(db).record(shift,"010460068200001321rollback\u001d93CRYPTO",null) }.isFailure)
        assertEquals(0,db.codeDao().countForShift(shift.id))
        assertTrue(db.validationDao().page("","",500).isEmpty())
        assertEquals(0,db.scanEventDao().count(shift.id,"ok"))
    } }

    @Test fun releasedProvisionalFirstIsNotResurrectedByItsFirstReceipt() = runTest { withDb { db ->
        val shift=ShiftEntityFixtures.bundled("s1").copy(validationPrintMode="duplicate_dm")
        db.shiftDao().upsert(shift)
        val out=ScanRecorder(db).record(shift,"010460068200001321releasedPending\u001d93CRYPTO",null)
        val hash=out.hash!!
        db.codeDao().delete(hash)
        db.applyValidationReceipt(app.markiro.handheld.core.network.ValidationOccurrenceReceipt(shift.id,hash,out.scannedAt,"first_accepted"))
        assertNull(db.codeDao().get(hash))
        assertEquals(0,db.codeDao().countForShift(shift.id))
    } }

    @Test fun authoritativeFirstReceiptProjectsTentativeRepeatOnlyOnce() = runTest { withDb { db ->
        val raw="010460068200001321reclassified\u001d93CRYPTO"; val km=KmCodec.canonicalize(raw); val hash=KmCodec.hash(km)
        val at="2026-09-12T08:00:00Z"
        val old=CodeEntity(hash,"old",km.gtin14,km.serial,"2026-09-01T00:00:00Z")
        db.codeDao().insert(old)
        db.validationDao().insert(ValidationOccurrenceEntity("s1",hash,at,raw,km.gtin14,km.serial,"op",db.recovery.token().owner.deviceId,"old","OLD-001","reprocessed"))
        val receipt=app.markiro.handheld.core.network.ValidationOccurrenceReceipt("s1",hash,at,"first_accepted")
        db.applyValidationReceipt(receipt.copy(scannedAt="2026-09-12T09:00:00Z"))
        assertEquals(old,db.codeDao().get(hash))
        db.applyValidationReceipt(receipt)
        assertEquals("s1",db.codeDao().get(hash)?.shiftId)
        assertTrue(db.validationDao().get("s1",hash)!!.originalProjected)
        db.codeDao().delete(hash)
        db.applyValidationReceipt(receipt.copy(outcome="pending"))
        db.applyValidationReceipt(receipt)
        assertNull(db.codeDao().get(hash))
        assertEquals(raw,db.validationDao().get("s1",hash)?.raw)
    } }

    @Test fun releasedHistoricalFirstReceiptNeverProjectsTentativeRepeatAfterRestartOrStaleReplay()=runTest {
        for(tentativeRepeat in listOf(false,true)) {
        val context=ApplicationProvider.getApplicationContext<android.content.Context>()
        val name="released-receipt-${java.util.UUID.randomUUID()}.db"
        fun open()=Room.databaseBuilder(context,HandheldDatabase::class.java,name).allowMainThreadQueries().build().also { it.initializeRecoveryForTest() }
        val raw="010460068200001321releasedHistoric\u001d93CRYPTO"; val km=KmCodec.canonicalize(raw); val hash=KmCodec.hash(km)
        val shift=ShiftEntityFixtures.bundled("s1").copy(validationPrintMode="duplicate_dm",allowPreviouslyAcceptedCodes=true)
        try {
            var db=open()
            db.shiftDao().upsert(shift)
            if(tentativeRepeat) db.validationDao().stage(listOf(ValidationHistoryEntity("pub",hash,"original","old","OLD-001","closed","2026-09-01T00:00:00Z")))
            db.validationDao().publish(ValidationHistoryPublication("s1","p1","pub","a".repeat(64),"2026-09-12T00:00:00Z","2026-09-12T01:00:00Z"))
            val scan=ScanRecorder(db).record(shift,raw,"op")
            val queued=db.outboxDao().head(10)
            assertEquals(1,db.codeDao().countForShift("s1"))
            val receipt=Json { ignoreUnknownKeys=true }.decodeFromString(app.markiro.handheld.core.network.ValidationOccurrenceReceipt.serializer(),"""{"shiftId":"s1","codeHash":"$hash","scannedAt":"${scan.scannedAt}","outcome":"first_accepted","ownership":"released"}""")
            db.applyValidationReceipt(receipt.copy(scannedAt="2026-09-01T01:00:00Z"))
            assertEquals(1,db.codeDao().countForShift("s1"))
            db.applyValidationReceipt(receipt)
            assertNull(db.codeDao().get(hash)); assertEquals(0,db.codeDao().countForShift("s1"))
            db.close(); db=open()
            try {
                for(outcome in listOf("first_accepted","pending","reprocessed")) db.applyValidationReceipt(app.markiro.handheld.core.network.ValidationOccurrenceReceipt("s1",hash,scan.scannedAt,outcome))
                assertNull(db.codeDao().get(hash)); assertEquals(0,db.codeDao().countForShift("s1"))
                assertEquals(queued,db.outboxDao().head(10))
                assertEquals(raw,db.validationDao().get("s1",hash)?.raw)
                assertEquals(Verdict.DUPLICATE,ScanRecorder(db).record(shift,raw,"op").verdict)
                val other=CodeEntity(hash,"independent",km.gtin14,km.serial,scan.scannedAt)
                db.codeDao().insert(other)
                db.applyValidationReceipt(receipt)
                assertEquals(other,db.codeDao().get(hash))
                db.applyValidationReceipt(app.markiro.handheld.core.network.ValidationOccurrenceReceipt("s1",hash,scan.scannedAt,"conflict"))
                assertEquals("conflict",db.validationDao().get("s1",hash)?.outcome)
                assertEquals(other,db.codeDao().get(hash))
            } finally { db.close() }
        } finally { context.deleteDatabase(name) }
        }
    }

    @Test fun generatedTypeScriptWireFixturesRoundTripAndKeepFullKm() {
        val json=Json { ignoreUnknownKeys=true; encodeDefaults=true }
        val fixtures=json.parseToJsonElement(checkNotNull(javaClass.classLoader?.getResource("validation-reprocessing-fixtures.json")).readText()).jsonObject
        for(entry in fixtures.getValue("policies").jsonArray) {
            val item=entry.jsonObject
            val dto=json.decodeFromJsonElement(ValidationPrintDto.serializer(),item.getValue("input"))
            assertEquals(item.getValue("expected").jsonObject.getValue("allowPreviouslyAcceptedCodes").jsonPrimitive.content.toBoolean(),dto.allowPreviouslyAcceptedCodes)
        }
        val history=json.decodeFromJsonElement(app.markiro.handheld.core.network.ValidationHistoryPage.serializer(),fixtures.getValue("history"))
        val status=json.decodeFromJsonElement(app.markiro.handheld.core.network.ValidationOccurrenceStatusResponse.serializer(),fixtures.getValue("status"))
        assertEquals(app.markiro.handheld.core.network.VALIDATION_REPROCESSING_PROTOCOL,history.protocol)
        assertEquals(listOf("first_accepted","reprocessed","pending","conflict"),status.occurrences.map { it.outcome })
        assertEquals(fixtures.getValue("codeHash").jsonPrimitive.content,KmCodec.hash(KmCodec.canonicalize(fixtures.getValue("raw").jsonPrimitive.content)))
        assertEquals("closed",history.items.single().shiftStatus)
        val released=json.decodeFromJsonElement(app.markiro.handheld.core.network.ValidationOccurrenceReceipt.serializer(),fixtures.getValue("releasedReceipt"))
        assertEquals("released",released.ownership)
        assertEquals("first_accepted",released.outcome)
        for(invalid in fixtures.getValue("invalidReleasedReceipts").jsonArray) assertTrue(runCatching { json.decodeFromJsonElement(app.markiro.handheld.core.network.ValidationOccurrenceReceipt.serializer(),invalid) }.isFailure)
    }

    @Test fun legacyPolicyDefaultsToFalseAndTrueSurvivesWireParsing() {
        val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
        for (enabled in listOf(false, true)) {
            val dto = json.decodeFromString(ValidationPrintDto.serializer(), """{"mode":"duplicate_dm","allowPreviouslyAcceptedCodes":$enabled}""")
            val wire = json.encodeToJsonElement(ValidationPrintDto.serializer(), dto).jsonObject
            assertEquals(enabled.toString(), wire["allowPreviouslyAcceptedCodes"]?.jsonPrimitive?.content)
        }
    }
    @Test fun occurrenceStorageExistsIndependentlyFromGlobalCodeMirror() {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
        try {
            db.openHelper.writableDatabase.query("SELECT COUNT(*) FROM validation_occurrences").use {
                it.moveToFirst(); assertEquals(0, it.getInt(0))
            }
        } finally { db.close() }
    }
}
