package app.markiro.handheld.core.duplicate

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.RasterResult
import app.markiro.handheld.core.label.RasterizeText
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ShiftEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

private const val GS = "\u001d"
private const val RAW = "0104600682000013215Y7HG9${GS}93Zf8K"
private const val OTHER = "0104600682000013215Y7HG8${GS}93Zf8K"

/** The scan's own `scannedAt`: the server joins an event to its code on this. */
private const val ACCEPTED_AT = "2026-09-11T08:00:00.000Z"

@RunWith(AndroidJUnit4::class)
class DuplicateJobsTest {
    private lateinit var db: HandheldDatabase
    private lateinit var transport: FakeTransport

    private class FakeTransport(
        var nextStatus: PrinterStatus = PrinterStatus.Ready,
        var outcome: SendOutcome = SendOutcome.Delivered,
    ) : PrinterTransport {
        val sent = mutableListOf<ByteArray>()
        override suspend fun status(printer: PrinterEntity) = nextStatus
        override suspend fun send(printer: PrinterEntity, document: ByteArray): SendOutcome {
            sent += document
            return outcome
        }
    }

    /** A duplicate template: the marking code as a Data Matrix, plus one line of text. */
    private val template = """
        {"widthMm":30,"heightMm":20,"dpi":203,"language":"zpl","elements":[
          {"kind":"barcode","id":"dm","xMm":2,"yMm":2,"format":"datamatrix","data":"km.code","sizeMm":16},
          {"kind":"field","id":"q","xMm":2,"yMm":18,"field":"qty","fontSizePt":6}
        ]}
    """.trimIndent()

    private fun shift(verification: String = Verification.NONE) = ShiftEntity(
        id = "s1",
        number = "SEP26-001",
        status = "active",
        mode = "validation",
        productId = "p1",
        productName = "Вода 0,5",
        productPrintName = "Вода",
        productGtin14 = "04600682000013",
        lineId = "l1",
        lineName = "Линия 2",
        counterpartyName = null,
        plannedQty = 100,
        plannedDate = "2026-09-11",
        productionDate = "2026-09-11",
        boxCapacity = null,
        palletCapacity = null,
        palletsEnabled = false,
        validationPrintMode = "duplicate_dm",
        closePolicyKind = "admin_only",
        closeOwnerDeviceId = null,
        openedAt = "2026-09-11T06:00:00.000Z",
        listFetchedAt = 1L,
        bundleFetchedAt = 1L,
        shelfLifeDays = 365,
        duplicateVerification = verification,
        duplicateTemplate = template,
        duplicateTemplateDigest = "a".repeat(64),
        duplicatePolicyRevision = "66666666-6666-4666-8666-666666666666",
    )

    private suspend fun selectPrinter(language: String = "zpl", dpi: Int = 203, id: String = "p1") {
        db.printerDao().upsert(
            PrinterEntity(
                id = id, name = "Zebra", transport = "wifi", address = "10.0.0.1:9100",
                language = language, dpi = dpi, selected = true, lastStatus = null, lastSeenAt = null,
            ),
        )
    }

    private fun jobs(clock: () -> Long = { 1_757_577_600_000L }): DuplicateJobs = DuplicateJobs(
        db = db,
        renderer = LabelRenderer(RasterizeText { _, _ -> RasterResult("00", 1, 1, 1, 1) }),
        transport = transport,
        clock = clock,
    )

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        transport = FakeTransport()
        db.shiftDao().upsert(shift())
        selectPrinter()
    }

    @After
    fun tearDown() = db.close()

    private suspend fun accept(raw: String = RAW, shift: ShiftEntity = shift()) =
        jobs().accept(shift, raw, "c".repeat(64), "55555555-5555-4555-8555-555555555555", "Иванова Анна", ACCEPTED_AT)

    /** Caught before the first unit is accepted, not halfway through a shift. */
    @Test
    fun aShiftWithNoSelectedPrinterIsRefusedByPreflight() = runTest {
        db.printerDao().clear()
        assertEquals(DuplicateReason.PRINTER_UNCONFIGURED, jobs().preflight(shift()))
    }

    @Test
    fun aShiftWithNoTemplateIsRefusedByPreflight() = runTest {
        assertEquals(DuplicateReason.TEMPLATE_MISSING, jobs().preflight(shift().copy(duplicateTemplate = null)))
    }

    @Test
    fun aTemplateThatWillNotParseIsRefusedByPreflight() = runTest {
        assertEquals(DuplicateReason.TEMPLATE_INVALID, jobs().preflight(shift().copy(duplicateTemplate = "{")))
    }

    @Test
    fun aReadyShiftPassesPreflight() = runTest {
        assertNull(jobs().preflight(shift()))
    }

    /** The bytes are rendered once and stored; nothing ever re-renders them. */
    @Test
    fun acceptingAUnitStoresTheBytesAndAPreparedEvent() = runTest {
        val outcome = accept()
        val jobId = (outcome as DuplicateOutcome.Prepared).jobId
        val job = checkNotNull(db.productLabelJobDao().get(jobId))
        assertEquals("prepared", job.status)
        assertEquals(1, job.attemptNo)
        assertNotNull(job.bytesBase64)
        assertEquals(productLabelBytesDigest(android.util.Base64.decode(job.bytesBase64, android.util.Base64.NO_WRAP)), job.bytesDigest)
        assertEquals(duplicatePayloadDigest(RAW), job.payloadDigest)
        val events = db.productLabelEventDao().bySequence(jobId)
        assertEquals(listOf("prepared"), events.map { it.kind })
        assertEquals(1, events.single().sequence)
        // Nothing was sent by accepting.
        assertTrue(transport.sent.isEmpty())
    }

    /** The whole slice turns on this: the operator is holding a sticker. */
    @Test
    fun aSecondUnitIsRefusedWhileAJobIsUnresolved() = runTest {
        accept()
        val second = accept(OTHER)
        assertEquals(DuplicateReason.JOB_OUTSTANDING, (second as DuplicateOutcome.Refused).reason)
        assertEquals(1, db.productLabelEventDao().unacked(10).size)
    }

    /** A code with no crypto tail cannot be reproduced, so it must never reach a label. */
    @Test
    fun aCodeWithoutItsCryptoTailIsRefused() = runTest {
        val outcome = accept("0104600682000013215Y7HG9")
        assertEquals(DuplicateReason.CODE_INCOMPLETE, (outcome as DuplicateOutcome.Refused).reason)
        assertNull(db.productLabelJobDao().openJob("s1"))
    }

    @Test
    fun aDeliveredSendRecordsSendingThenSent() = runTest {
        val jobId = (accept() as DuplicateOutcome.Prepared).jobId
        assertEquals(DuplicateSend.Sent, jobs().send(jobId))
        assertEquals(listOf("prepared", "sending", "sent"), db.productLabelEventDao().bySequence(jobId).map { it.kind })
        val job = checkNotNull(db.productLabelJobDao().get(jobId))
        assertEquals(AttemptState.SENT, job.attemptState)
        assertEquals(JobStatus.COMPLETED, job.status)
        assertEquals(1, transport.sent.size)
    }

    /** Under `required` a delivered send is not done: the sticker has to be scanned back. */
    @Test
    fun underRequiredVerificationADeliveredSendAwaitsTheScan() = runTest {
        db.shiftDao().upsert(shift(Verification.REQUIRED))
        val jobId = (accept(shift = shift(Verification.REQUIRED)) as DuplicateOutcome.Prepared).jobId
        jobs().send(jobId)
        assertEquals(JobStatus.AWAITING_VERIFICATION, db.productLabelJobDao().get(jobId)?.status)
    }

    /**
     * The printer's own words stay on the device.
     *
     * `failed_before_send` admits only `printer_unconfigured` and
     * `printer_changed`; sending `no_paper` made the server reject the whole
     * batch, which wedged the queue for scans and shift closures too. The
     * attempt therefore stays `prepared`, which is also what lets «Повторить
     * печать» work once the paper is back.
     */
    @Test
    fun aPrinterThatIsNotReadyIsRecordedOnlyOnTheDevice() = runTest {
        val jobId = (accept() as DuplicateOutcome.Prepared).jobId
        transport.nextStatus = PrinterStatus.NotReady(NotReadyReason.NO_PAPER)
        assertEquals(DuplicateReason.NO_PAPER, (jobs().send(jobId) as DuplicateSend.Failed).reason)
        val job = checkNotNull(db.productLabelJobDao().get(jobId))
        assertEquals(DuplicateReason.NO_PAPER, job.lastFailure)
        assertEquals(AttemptState.PREPARED, job.attemptState)
        // Asked before sending, so nothing left the device -- and no event either.
        assertTrue(transport.sent.isEmpty())
        assertEquals(listOf("prepared"), db.productLabelEventDao().bySequence(jobId).map { it.kind })
    }

    /** The one refusal the protocol does name reaches the server. */
    @Test
    fun aPrinterThatVanishedIsRecordedAsAnEvent() = runTest {
        val jobId = (accept() as DuplicateOutcome.Prepared).jobId
        db.printerDao().clear()
        assertEquals(DuplicateReason.PRINTER_UNCONFIGURED, (jobs().send(jobId) as DuplicateSend.Failed).reason)
        assertEquals(listOf("prepared", "failed_before_send"), db.productLabelEventDao().bySequence(jobId).map { it.kind })
    }

    /**
     * Every code that reaches the wire must be one the server's schema admits.
     * A stray one is a 400 on the whole batch, and a 400 on the whole batch is a
     * queue that never moves again -- scans and shift closures included.
     */
    @Test
    fun noEventCarriesAnErrorCodeTheServerWouldRefuse() = runTest {
        val allowed = mapOf(
            "failed_before_send" to setOf("printer_unconfigured", "printer_changed"),
            "delivery_unknown" to setOf("transport_failed", "persistence_failed", "interrupted"),
        )
        // Drive every path that can record one.
        val a = (accept() as DuplicateOutcome.Prepared).jobId
        transport.nextStatus = PrinterStatus.NotReady(NotReadyReason.NO_PAPER)
        jobs().send(a)
        transport.nextStatus = PrinterStatus.Ready
        transport.outcome = SendOutcome.Refused(NotReadyReason.HEAD_OPEN)
        jobs().send(a)
        jobs().demoteInterrupted()

        for (event in db.productLabelEventDao().bySequence(a)) {
            val codes = allowed[event.kind] ?: continue
            val code = Regex("\"errorCode\":\"([^\"]+)\"").find(event.payloadJson)?.groupValues?.get(1)
            assertTrue("${event.kind} carries $code", code != null && code in codes)
        }
    }

    @Test
    fun anUnknownSendRecordsDeliveryUnknownAndNothingResends() = runTest {
        val jobId = (accept() as DuplicateOutcome.Prepared).jobId
        transport.outcome = SendOutcome.Unknown("transport_failed")
        assertEquals("transport_failed", (jobs().send(jobId) as DuplicateSend.Unknown).cause)
        val job = checkNotNull(db.productLabelJobDao().get(jobId))
        assertEquals(AttemptState.DELIVERY_UNKNOWN, job.attemptState)
        assertEquals(JobStatus.ATTENTION, job.status)
        assertEquals(1, transport.sent.size)
    }

    /**
     * The domain refuses a reprint whose bytes, language or dpi differ, so a job
     * prepared on another printer can never be reprinted. Catching it before the
     * send is the only thing that stops a dead end.
     */
    @Test
    fun changingThePrinterBetweenPrepareAndSendFailsBeforeSending() = runTest {
        val jobId = (accept() as DuplicateOutcome.Prepared).jobId
        db.printerDao().clear()
        selectPrinter(language = "tspl", dpi = 300, id = "p2")
        assertEquals(DuplicateReason.PRINTER_CHANGED, (jobs().send(jobId) as DuplicateSend.Failed).reason)
        assertTrue(transport.sent.isEmpty())
        val events = db.productLabelEventDao().bySequence(jobId)
        assertEquals(listOf("prepared", "failed_before_send"), events.map { it.kind })
    }

    /** Resuming would be an automatic resend of a label that may already exist. */
    @Test
    fun aJobLeftInSendingBecomesUnknownWithInterruptedAtStartup() = runTest {
        val jobId = (accept() as DuplicateOutcome.Prepared).jobId
        // Freeze the attempt mid-send, exactly as a killed process leaves it.
        val job = db.productLabelJobDao().get(jobId)!!
        db.productLabelJobDao().update(job.copy(attemptState = AttemptState.SENDING, status = JobStatus.SENDING, latestSequence = 2))
        db.productLabelEventDao().insert(
            app.markiro.handheld.core.storage.ProductLabelEventEntity(
                eventId = "e-sending", jobId = jobId, sequence = 2, kind = "sending",
                payloadJson = "{}", occurredAt = "2026-09-11T08:00:02.000Z", ackedAt = null, quarantineCode = null,
            ),
        )

        jobs().demoteInterrupted()

        val after = checkNotNull(db.productLabelJobDao().get(jobId))
        assertEquals(AttemptState.DELIVERY_UNKNOWN, after.attemptState)
        assertEquals(JobStatus.ATTENTION, after.status)
        val last = db.productLabelEventDao().bySequence(jobId).last()
        assertEquals("delivery_unknown", last.kind)
        assertTrue(last.payloadJson.contains("interrupted"))
        // Nothing was resent.
        assertTrue(transport.sent.isEmpty())
    }

    /** The queued JSON is what gets sent, so it must carry the wire shape verbatim. */
    @Test
    fun theQueuedEventCarriesTheWireFields() = runTest {
        val jobId = (accept() as DuplicateOutcome.Prepared).jobId
        val payload = db.productLabelEventDao().bySequence(jobId).single().payloadJson
        for (field in listOf("eventId", "jobId", "attemptId", "sequence", "shiftId", "codeHash", "acceptedAt",
            "policyRevision", "templateDigest", "payloadDigest", "operatorId", "occurredAt", "kind",
            "attemptNo", "language", "dpi", "bytesDigest")) {
            assertTrue("$field missing from $payload", payload.contains("\"$field\""))
        }
        // A `prepared` carries no errorCode and no scannedPayloadDigest; the
        // server's schema is strict per kind and would reject either.
        assertTrue(!payload.contains("errorCode"))
        assertTrue(!payload.contains("scannedPayloadDigest"))
        // The first attempt's reason is null and must be present as null.
        assertTrue(payload.contains("\"reason\":null"))
    }

    /**
     * Found end to end: the server joins an event to its accepted code on
     * `codes.scannedAt = event.acceptedAt`, so a fresh reading of the clock here
     * made every event `parent_missing` -- quarantined one by one while the
     * device showed nothing wrong.
     */
    @Test
    fun theJobCarriesTheScansOwnTimestampNotTheClock() = runTest {
        val jobId = (jobs { 9_999_999_999_999L }
            .accept(shift(), RAW, "c".repeat(64), "55555555-5555-4555-8555-555555555555", null, ACCEPTED_AT)
            as DuplicateOutcome.Prepared).jobId
        val job = checkNotNull(db.productLabelJobDao().get(jobId))
        assertEquals(ACCEPTED_AT, job.acceptedAt)
        assertTrue(db.productLabelEventDao().bySequence(jobId).single().payloadJson.contains("\"acceptedAt\":\"$ACCEPTED_AT\""))
    }
}
