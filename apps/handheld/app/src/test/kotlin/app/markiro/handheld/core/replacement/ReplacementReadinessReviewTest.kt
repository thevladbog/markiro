package app.markiro.handheld.core.replacement

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import kotlinx.coroutines.flow.first
import app.markiro.handheld.core.network.ValidationOccurrenceReceipt
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ReplacementReadinessReviewTest {
    @Test fun pendingValidationOccurrenceCannotReportEveryMandatoryChannelAsZero() = runTest {
        val db=Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(),HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
        try {
            db.validationDao().insert(ValidationOccurrenceEntity(
                shiftId="11111111-1111-4111-8111-111111111111",codeHash="a".repeat(64),
                scannedAt="2026-09-16T00:00:00Z",raw="retained-evidence",gtin14="04600000000015",serial="serial",
                operatorId=null,deviceId=db.recovery.token().owner.deviceId,sourceShiftId=null,sourceShiftNumber=null,
                kind="first_accepted",outcome="pending",
            ))
            val snapshot=ReplacementReadiness(db).snapshot()
            assertTrue("Unreconciled validation occurrence was reported as a completely drained device: $snapshot",
                snapshot.getValue("pending").jsonObject.values.sumOf { it.jsonPrimitive.long } > 0 ||
                    snapshot.getValue("conflicts").jsonPrimitive.long > 0)
        } finally { db.close() }
    }
    @Test fun onlyPendingOccurrencesCountAndSchemaLossIsNotMeasuredZero() = runTest {
        val db=Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(),HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
        try {
            val row=ValidationOccurrenceEntity("shift","a".repeat(64),"2026-09-16T00:00:00Z","saved raw","04600000000015","serial",null,db.recovery.token().owner.deviceId,null,null,"first_accepted","pending")
            db.validationDao().insert(row)
            db.validationDao().insert(row.copy(codeHash="b".repeat(64),outcome="reprocessed",kind="reprocessed"))
            val local=ReplacementReadiness(db)
            assertEquals(db.validationDao().pendingCount().first().toLong(),local.snapshot().getValue("pending").jsonObject.getValue("scans").jsonPrimitive.long)
            db.applyValidationReceipt(ValidationOccurrenceReceipt(row.shiftId,row.codeHash,row.scannedAt,"pending"))
            assertEquals(1L,local.snapshot().getValue("pending").jsonObject.getValue("scans").jsonPrimitive.long)
            db.applyValidationReceipt(ValidationOccurrenceReceipt(row.shiftId,row.codeHash,row.scannedAt,"first_accepted"))
            assertEquals(0L,local.snapshot().getValue("pending").jsonObject.getValue("scans").jsonPrimitive.long)
            assertEquals("saved raw",db.validationDao().get(row.shiftId,row.codeHash)?.raw)
            db.openHelper.writableDatabase.execSQL("DROP TABLE validation_occurrences")
            assertEquals("unsupported",local.snapshot().getValue("pending").jsonObject.getValue("scans").jsonPrimitive.content)
        } finally { db.close() }
    }

    @Test fun warehouseMembershipQueuesAndRejectedConflictsPreventFalseReadiness() = runTest {
        val db=Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(),HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
        try {
            val pending = PalletMembershipEntity("p", "box", "t", null, MembershipStatus.PENDING, null, null, null, null)
            db.palletMembershipDao().insert(pending)
            db.palletMembershipDao().insert(pending.copy(sscc="sent", status=MembershipStatus.SENT))
            db.palletMembershipDao().insert(pending.copy(sscc="rejected", status=MembershipStatus.REJECTED))
            db.palletMembershipRemovalDao().insert(PalletMembershipRemovalEntity(palletId="p", sscc="removed", removedAt="t", operatorId=null, status=RemovalStatus.PENDING))
            val snapshot=ReplacementReadiness(db).snapshot()
            assertEquals(3L, snapshot.getValue("pending").jsonObject.getValue("boxes").jsonPrimitive.long)
            assertEquals(1L, snapshot.getValue("conflicts").jsonPrimitive.long)
            assertEquals(3L, db.recovery.summary().getValue("pallets"))
            db.palletMembershipDao().acknowledge("p", "t")
            assertEquals(0L, ReplacementReadiness(db).snapshot().getValue("conflicts").jsonPrimitive.long)
        } finally { db.close() }
    }

}
