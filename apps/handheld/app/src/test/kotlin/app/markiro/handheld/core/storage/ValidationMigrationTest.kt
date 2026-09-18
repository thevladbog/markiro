package app.markiro.handheld.core.storage

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.scan.ScanRecorder
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.print.PrintPurpose
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.assigned
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class ValidationMigrationTest {
    @Test fun realV10UpgradeBackfillsEffectiveOccurrenceAndRestartKeepsQueueIdentity() = upgradeFrom(10)

    @Test fun realV11UpgradePreservesPalletAuditAlongsideImmutablePrintAndScanQueues() = upgradeFrom(11)

    @Test fun realV12UpgradePreservesValidationFactsAndMigratesOnlyPrinterRouting() = upgradeFrom(12)

    @Test fun realV13UpgradePreservesValidationAndPrinterDestinationsWhenAddingGrants() = upgradeFrom(13)

    private fun upgradeFrom(version: Int) = runTest {
        val context=ApplicationProvider.getApplicationContext<Context>(); val name="validation-${UUID.randomUUID()}.db"
        fun open()=Room.databaseBuilder(context,HandheldDatabase::class.java,name).allowMainThreadQueries().addMigrations(MIGRATION_10_11, MIGRATION_11_12, MIGRATION_12_13, MIGRATION_13_14, MIGRATION_14_15, MIGRATION_15_16, MIGRATION_16_17, MIGRATION_17_18, MIGRATION_18_19).build()
        val raw="010460068200001321legacy\u001d93CRYPTO"; val km=KmCodec.canonicalize(raw); val hash=KmCodec.hash(km)
        val savedTemplate="""{ "dpi":203, "caption":"Кега", "elements":[{"literal":"^FNC1"}] }"""
        val shift=ShiftEntityFixtures.bundled("s1").copy(validationPrintMode="duplicate_dm", allowPreviouslyAcceptedCodes=version >= 12, duplicateTemplate=savedTemplate, duplicateTemplateDigest="a".repeat(64), duplicatePolicyRevision="legacy-revision", duplicateVerification="required")
        val at="2026-09-12T08:00:00Z"
        val bytes=byteArrayOf(0,1,29,94,70,68,-1)
        val savedJob=ProductLabelJobEntity(jobId="legacy-job",shiftId="s1",codeHash=hash,canonicalRaw=raw,acceptedAt=at,operatorId="op",policyRevision="legacy-revision",templateDigest="a".repeat(64),payloadDigest="b".repeat(64),bytesBase64=java.util.Base64.getEncoder().encodeToString(bytes),bytesDigest="c".repeat(64),language="zpl",dpi=203,latestSequence=1,attemptId="legacy-attempt",attemptNo=1,attemptState="prepared",verification="required",verificationOutcome="pending",status="prepared",lastFailure=null)
        val palletAudit = PalletExceptionEntity(id=23, kind="reprint", palletId="legacy-pallet", shiftId="s1", terminalId="device", operatorId="op", reason="unreadable", occurredAt=at, payloadJson="""{ "saved":"pallet-audit", "raw":"\u001dexact" }""", ackedAt=null)
        val savedEvent=ProductLabelEventEntity(eventId="legacy-event",jobId=savedJob.jobId,sequence=1,kind="prepared",payloadJson="""{ "eventId":"legacy-event", "policyRevision":"legacy-revision", "bytesDigest":"${savedJob.bytesDigest}", "payload":"\u001d93CRYPTO" }""",occurredAt=at,ackedAt=null,quarantineCode=null)
        val printer=PrinterEntity("selected", "Сохранённый принтер", "wifi", "192.168.1.40:9100", "zpl", 203, true, "unknown", 17L)
        val otherPrinter=printer.copy(id="other", name="Другой", selected=false, language="tspl", dpi=300)
        val unknownBox=BoxEntity("box", "s1", "000000000000000017", at, at, "op", "unknown", "link lost", null)
        val savedOccurrence=ValidationOccurrenceEntity("s1",hash,at,raw,km.gtin14,km.serial,"op","device","source","OLD-001","reprocessed","reprocessed","reprocessed",false)
        val publication=ValidationHistoryPublication("s1",shift.productId,"publication","snapshot",at,"2026-09-13T08:00:00Z")
        val history=ValidationHistoryEntity("publication",hash,"original","source","OLD-001","closed","2026-09-01T00:00:00Z")
        try {
            val old=open(); old.initializeRecoveryForTest()
            old.shiftDao().upsert(shift)
            old.productLabelJobDao().insert(savedJob)
            if (version >= 11) old.palletExceptionDao().insert(palletAudit)
            old.printerDao().upsert(printer)
            old.printerDao().upsert(otherPrinter)
            old.boxDao().insert(unknownBox)
            if (version >= 12) {
                old.validationDao().insert(savedOccurrence)
                old.validationDao().stage(listOf(history))
                old.validationDao().publish(publication)
            }
            old.productLabelEventDao().insert(savedEvent)
            old.codeDao().insert(CodeEntity(hash,"s1",km.gtin14,km.serial,at))
            old.scanEventDao().insert(ScanEventEntity(shiftId="s1",raw=raw,verdict="ok",scannedAt=at,operatorId="op",codeHash=hash))
            old.scanEventDao().insert(ScanEventEntity(shiftId="s1",raw="older",verdict="ok",scannedAt="2026-09-01T00:00:00Z",operatorId="op",codeHash=hash))
            val queueId=old.outboxDao().insert(OutboxEntity(shiftId="s1",raw=raw,verdict="ok",scannedAt=at,operatorId="op",codeHash=hash,gtin14=km.gtin14,serial=km.serial))
            if (version == 13) old.printerDao().saveDestination(app.markiro.handheld.core.print.PrintDestinationEntity("duplicate",savedJob.jobId,savedJob.attemptId,otherPrinter))
            val sqlite=old.openHelper.writableDatabase
            listOf("grant_state", "grant_tokens", "grant_counters", "grant_evidence", "grant_task_bindings", "grant_task_provenance").forEach { sqlite.execSQL("DROP TABLE $it") }
            if (version < 13) {
                sqlite.execSQL("DROP TABLE printer_assignments")
                sqlite.execSQL("DROP TABLE print_destinations")
            } else {
                app.markiro.handheld.core.print.PrintPurpose.entries.forEach { old.printerDao().assign(app.markiro.handheld.core.print.PrinterAssignmentEntity(it.wire, printer.id)) }
            }
            if (version < 12) {
                val create=sqlite.query("SELECT sql FROM sqlite_master WHERE name='shift_mirror'").use { it.moveToFirst(); it.getString(0) }
                val legacyCreate=create.replace(Regex("`allowPreviouslyAcceptedCodes` INTEGER NOT NULL DEFAULT 0,\\s*"),"")
                check(create!=legacyCreate)
                val columns=sqlite.query("PRAGMA table_info(shift_mirror)").use { cursor -> buildList { while(cursor.moveToNext()) { val column=cursor.getString(1); if(column!="allowPreviouslyAcceptedCodes") add("`$column`") } } }.joinToString(",")
                sqlite.execSQL("ALTER TABLE shift_mirror RENAME TO shift_v12")
                sqlite.execSQL(legacyCreate)
                sqlite.execSQL("INSERT INTO shift_mirror ($columns) SELECT $columns FROM shift_v12")
                sqlite.execSQL("DROP TABLE shift_v12")
                for(table in listOf("validation_occurrences","validation_history","validation_history_publications")) sqlite.execSQL("DROP TABLE $table")
            }
            if (version == 10) {
                sqlite.execSQL("DROP TABLE pallet_exceptions")
                sqlite.execSQL("CREATE TABLE `pallet_exceptions` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `kind` TEXT NOT NULL, `palletId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, `terminalId` TEXT, `operatorId` TEXT, `reason` TEXT NOT NULL, `occurredAt` TEXT NOT NULL)")
            }
            sqlite.version=version; old.close()
            for(restart in 0..1) {
                val db=open(); db.initializeRecoveryForTest()
                try {
                    assertEquals(HANDHELD_DATABASE_VERSION, db.openHelper.readableDatabase.version)
                    assertNull(db.grantDao().state())
                    assertTrue(db.grantDao().evidence().isEmpty())
                    assertEquals(version >= 12, db.shiftDao().get("s1")!!.allowPreviouslyAcceptedCodes)
                    assertEquals(shift,db.shiftDao().get("s1"))
                    assertEquals(printer,db.printerDao().get(printer.id))
                    assertEquals(otherPrinter,db.printerDao().get(otherPrinter.id))
                    PrintPurpose.entries.forEach { assertEquals(printer,db.printerDao().assigned(it)) }
                    assertEquals(unknownBox,db.boxDao().get(unknownBox.boxId))
                    assertEquals(if (version == 13) otherPrinter else null, db.printerDao().destination("duplicate",savedJob.jobId,savedJob.attemptId)?.printer)
                    assertEquals(savedJob,db.productLabelJobDao().get(savedJob.jobId))
                    assertEquals(if (version >= 11) listOf(palletAudit) else emptyList<PalletExceptionEntity>(), db.palletExceptionDao().queued())
                    assertArrayEquals(bytes,java.util.Base64.getDecoder().decode(db.productLabelJobDao().get(savedJob.jobId)!!.bytesBase64))
                    assertEquals(listOf(savedEvent),db.productLabelEventDao().unacked(10))
                    assertEquals(savedTemplate,db.shiftDao().get("s1")!!.duplicateTemplate)
                    val occurrence=db.validationDao().get("s1",hash)!!
                    assertEquals(at,occurrence.scannedAt); assertEquals(raw,occurrence.raw)
                    if (version >= 12) {
                        assertEquals(savedOccurrence,occurrence)
                        assertEquals(publication,db.validationDao().publication("s1"))
                        assertEquals(listOf(history),db.validationDao().history("s1",hash))
                    } else {
                        assertEquals("pending",occurrence.outcome)
                        assertNull(occurrence.lastReceipt)
                        assertTrue(occurrence.originalProjected)
                    }
                    assertEquals(queueId,db.outboxDao().head(1).single().id)
                    assertEquals(raw,db.outboxDao().head(1).single().raw)
                    assertEquals(1,db.codeDao().countForShift("s1"))
                    assertEquals(Verdict.DUPLICATE,ScanRecorder(db).record(db.shiftDao().get("s1")!!,raw,"op").verdict)
                } finally { db.close() }
            }
            if (version < 12) {
                val released=open(); released.initializeRecoveryForTest()
                try {
                    released.codeDao().delete(hash)
                    released.applyValidationReceipt(app.markiro.handheld.core.network.ValidationOccurrenceReceipt("s1",hash,at,"first_accepted"))
                    assertNull(released.codeDao().get(hash))
                    assertEquals(0,released.codeDao().countForShift("s1"))
                } finally { released.close() }
            }
        } finally { context.deleteDatabase(name) }
    }
}
