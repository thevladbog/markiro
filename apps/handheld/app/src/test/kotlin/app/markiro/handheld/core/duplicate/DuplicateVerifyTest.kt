package app.markiro.handheld.core.duplicate

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.RasterResult
import app.markiro.handheld.core.label.RasterizeText
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ShiftEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

private const val VGS = "\u001d"
private const val VRAW = "0104600682000013215Y7HG9${VGS}93Zf8K"
private const val VOTHER = "0104600682000013215Y7HG8${VGS}93Zf8K"

/** The scan's own `scannedAt`: the server joins an event to its code on this. */
private const val ACCEPTED_AT = "2026-09-11T08:00:00.000Z"

@RunWith(AndroidJUnit4::class)
class DuplicateVerifyTest {
    private lateinit var db: HandheldDatabase
    private lateinit var transport: FakeTransport

    private class FakeTransport(var outcome: SendOutcome = SendOutcome.Delivered) : PrinterTransport {
        val sent = mutableListOf<ByteArray>()
        override suspend fun status(printer: PrinterEntity) = PrinterStatus.Ready
        override suspend fun send(printer: PrinterEntity, document: ByteArray): SendOutcome {
            sent += document
            return outcome
        }
    }

    private val template = """
        {"widthMm":30,"heightMm":20,"dpi":203,"language":"zpl","elements":[
          {"kind":"barcode","id":"dm","xMm":2,"yMm":2,"format":"datamatrix","data":"km.code","sizeMm":16}
        ]}
    """.trimIndent()

    private fun shift(verification: String) = ShiftEntity(
        id = "s1", number = "SEP26-001", status = "active", mode = "validation", productId = "p1",
        productName = "Вода 0,5", productPrintName = "Вода", productGtin14 = "04600682000013",
        lineId = "l1", lineName = "Линия 2", counterpartyName = null, plannedQty = 100,
        plannedDate = "2026-09-11", productionDate = "2026-09-11", boxCapacity = null,
        palletBoxCapacity = null, palletsEnabled = false, validationPrintMode = "duplicate_dm",
        closePolicyKind = "admin_only", closeOwnerDeviceId = null, openedAt = "2026-09-11T06:00:00.000Z",
        listFetchedAt = 1L, bundleFetchedAt = 1L, shelfLifeDays = 365,
        duplicateVerification = verification, duplicateTemplate = template,
        duplicateTemplateDigest = "a".repeat(64),
        duplicatePolicyRevision = "66666666-6666-4666-8666-666666666666",
    )

    private fun jobs() = DuplicateJobs(
        db = db,
        renderer = LabelRenderer(RasterizeText { _, _ -> RasterResult("00", 1, 1, 1, 1) }),
        transport = transport,
        clock = { 1_757_577_600_000L },
    )

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        transport = FakeTransport()
        db.printerDao().upsert(
            PrinterEntity(
                id = "p1", name = "Zebra", transport = "wifi", address = "10.0.0.1:9100",
                language = "zpl", dpi = 203, selected = true, lastStatus = null, lastSeenAt = null,
            ),
        )
    }

    @After
    fun tearDown() = db.close()

    /** Accepts a unit and sends it, leaving the job wherever the send left it. */
    private suspend fun printed(verification: String = Verification.REQUIRED): String {
        val s = shift(verification)
        db.shiftDao().upsert(s)
        val jobId = (jobs().accept(s, VRAW, "c".repeat(64), "55555555-5555-4555-8555-555555555555", null, ACCEPTED_AT) as DuplicateOutcome.Prepared).jobId
        jobs().send(jobId)
        return jobId
    }

    @Test
    fun scanningTheSameStickerCompletesTheJob() = runTest {
        val jobId = printed()
        assertEquals(DuplicateMatch.MATCH, jobs().verify(jobId, VRAW))
        val job = checkNotNull(db.productLabelJobDao().get(jobId))
        assertEquals(JobStatus.COMPLETED, job.status)
        assertEquals(VerificationOutcome.VERIFIED, job.verificationOutcome)
        assertEquals("verified", db.productLabelEventDao().bySequence(jobId).last().kind)
    }

    /**
     * A different unit of the same product shares the identity hash the scan loop
     * uses for duplicates, and must still be refused here.
     */
    @Test
    fun scanningADifferentUnitIsAMismatchAndTheJobStaysOutstanding() = runTest {
        val jobId = printed()
        assertEquals(DuplicateMatch.MISMATCH, jobs().verify(jobId, VOTHER))
        val job = checkNotNull(db.productLabelJobDao().get(jobId))
        assertEquals(JobStatus.AWAITING_VERIFICATION, job.status)
        assertEquals(VerificationOutcome.PENDING, job.verificationOutcome)
        val last = db.productLabelEventDao().bySequence(jobId).last()
        assertEquals("verification_rejected", last.kind)
        assertTrue(last.payloadJson.contains("\"reason\":\"mismatch\""))
    }

    @Test
    fun scanningSomethingUnreadableIsInvalidAndTheJobStaysOutstanding() = runTest {
        val jobId = printed()
        assertEquals(DuplicateMatch.INVALID, jobs().verify(jobId, "garbage"))
        assertEquals(JobStatus.AWAITING_VERIFICATION, db.productLabelJobDao().get(jobId)?.status)
        assertTrue(db.productLabelEventDao().bySequence(jobId).last().payloadJson.contains("\"reason\":\"invalid\""))
    }

    /** The operator can try again; nothing about the job settled. */
    @Test
    fun aRejectedVerificationCanBeFollowedByASuccessfulOne() = runTest {
        val jobId = printed()
        jobs().verify(jobId, VOTHER)
        assertEquals(DuplicateMatch.MATCH, jobs().verify(jobId, VRAW))
        assertEquals(JobStatus.COMPLETED, db.productLabelJobDao().get(jobId)?.status)
    }

    /**
     * The domain accepts `verified` out of `delivery_unknown` even when the policy
     * is `none`. This is the only verification such a shift ever performs, and it
     * is how "did a label come out?" gets answered without a reprint.
     */
    @Test
    fun anUnknownDeliveryIsResolvedByAScanUnderNoVerification() = runTest {
        transport.outcome = SendOutcome.Unknown("transport_failed")
        val jobId = printed(Verification.NONE)
        assertEquals(JobStatus.ATTENTION, db.productLabelJobDao().get(jobId)?.status)

        assertEquals(DuplicateMatch.MATCH, jobs().verify(jobId, VRAW))
        assertEquals(JobStatus.COMPLETED, db.productLabelJobDao().get(jobId)?.status)
        // Resolved by looking, not by printing a second sticker.
        assertEquals(1, transport.sent.size)
    }

    @Test
    fun aReprintReplaysTheSameBytesUnderANewAttempt() = runTest {
        transport.outcome = SendOutcome.Unknown("transport_failed")
        val jobId = printed(Verification.NONE)
        val before = checkNotNull(db.productLabelJobDao().get(jobId))

        transport.outcome = SendOutcome.Delivered
        assertEquals(DuplicateOutcome.Prepared(jobId), jobs().reprint(jobId, ReprintReason.DAMAGED))
        jobs().send(jobId)

        val after = checkNotNull(db.productLabelJobDao().get(jobId))
        assertEquals(2, after.attemptNo)
        assertNotEquals(before.attemptId, after.attemptId)
        assertEquals(before.bytesDigest, after.bytesDigest)
        assertEquals(2, transport.sent.size)
        assertTrue(transport.sent[0].contentEquals(transport.sent[1]))
    }

    @Test
    fun aReprintCarriesItsReasonAndTheFirstAttemptCarriesNone() = runTest {
        transport.outcome = SendOutcome.Unknown("transport_failed")
        val jobId = printed(Verification.NONE)
        jobs().reprint(jobId, ReprintReason.LOST)
        val prepares = db.productLabelEventDao().bySequence(jobId).filter { it.kind == "prepared" }
        assertEquals(2, prepares.size)
        assertTrue(prepares[0].payloadJson.contains("\"reason\":null"))
        assertTrue(prepares[1].payloadJson.contains("\"reason\":\"lost\""))
    }

    @Test
    fun aReprintIsRefusedWhileAnAttemptIsStillInFlight() = runTest {
        val s = shift(Verification.NONE)
        db.shiftDao().upsert(s)
        val jobId = (jobs().accept(s, VRAW, "c".repeat(64), "55555555-5555-4555-8555-555555555555", null, ACCEPTED_AT) as DuplicateOutcome.Prepared).jobId
        // Never sent: the attempt is still `prepared`.
        val outcome = jobs().reprint(jobId, ReprintReason.DAMAGED)
        assertEquals(DuplicateReason.ATTEMPT_IN_FLIGHT, (outcome as DuplicateOutcome.Refused).reason)
        assertEquals(1, db.productLabelEventDao().bySequence(jobId).size)
    }

    /** The attempt is what freezes, not the job. */
    @Test
    fun aVerifiedAttemptTakesNoFurtherEventOfItsOwn() = runTest {
        val jobId = printed()
        jobs().verify(jobId, VRAW)
        val settled = db.productLabelEventDao().bySequence(jobId).size
        // A second verification of the same attempt is refused rather than recorded.
        assertEquals(DuplicateMatch.MATCH, jobs().verify(jobId, VRAW))
        assertEquals(settled, db.productLabelEventDao().bySequence(jobId).size)
    }

    /** A verified label can be damaged later; under `required` the new copy must be scanned back. */
    @Test
    fun aCompletedJobTakesAReprintWhichDropsBackToPendingVerification() = runTest {
        val jobId = printed()
        jobs().verify(jobId, VRAW)
        assertEquals(JobStatus.COMPLETED, db.productLabelJobDao().get(jobId)?.status)

        assertEquals(DuplicateOutcome.Prepared(jobId), jobs().reprint(jobId, ReprintReason.DAMAGED))
        val after = checkNotNull(db.productLabelJobDao().get(jobId))
        assertEquals(2, after.attemptNo)
        assertEquals(VerificationOutcome.PENDING, after.verificationOutcome)
        assertEquals(JobStatus.PREPARED, after.status)
    }

    /** Retention dropped the bytes at shift close; there is nothing to replay. */
    @Test
    fun aReprintAfterTheBytesAreGoneIsRefusedRatherThanReRendered() = runTest {
        transport.outcome = SendOutcome.Unknown("transport_failed")
        val jobId = printed(Verification.NONE)
        db.productLabelJobDao().dropBytesForShift("s1")
        val outcome = jobs().reprint(jobId, ReprintReason.DAMAGED)
        assertEquals(DuplicateReason.BYTES_GONE, (outcome as DuplicateOutcome.Refused).reason)
    }
}
