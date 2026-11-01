package app.markiro.handheld.core.reprint

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.RasterizeText
import app.markiro.handheld.core.label.RasterResult
import app.markiro.handheld.core.print.*
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class SiteReprintEngineTest {
    private lateinit var db: HandheldDatabase
    private var operator: String? = "operator"
    private val sscc = "046800899000000017"
    private val session = UUID.randomUUID().toString()
    private val spec = """{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[{"kind":"barcode","id":"sscc","xMm":2,"yMm":2,"format":"code128","data":"sscc","sizeMm":20}]}"""
    private val template get() = SiteReprintTemplate("template", "Box", "box", spec, "{}")
    private val source get() = SiteReprintSource("box", "other-device-box", sscc, "Original product",
        mapOf("sscc" to sscc, "qty" to "12"), "{}")
    private val renderer = LabelRenderer(RasterizeText { _, _ -> RasterResult("AA", 1, 1, 8, 8) })
    private class Wire : PrinterTransport {
        var sends = 0
        val documents = mutableListOf<ByteArray>()
        val targets = mutableListOf<app.markiro.handheld.core.print.PrinterEntity>()
        var status: PrinterStatus = PrinterStatus.Ready
        var outcome: SendOutcome = SendOutcome.Delivered
        override suspend fun status(printer: app.markiro.handheld.core.print.PrinterEntity) = status
        override suspend fun send(printer: app.markiro.handheld.core.print.PrinterEntity, document: ByteArray): SendOutcome {
            sends++; documents += document; targets += printer; return outcome
        }
    }
    private inner class Backend : SiteReprintBackend {
        var answer: suspend () -> SiteReprintLookup = { SiteReprintLookup.Found(source) }
        var catalog = listOf(template)
        var offline = false
        var onRefresh: () -> Unit = {}
        val reports = mutableListOf<String>()
        override suspend fun lookup(raw: String, operatorId: String) = answer()
        override suspend fun refreshTemplates(): List<SiteReprintTemplate> { onRefresh(); return catalog }
        override fun auditPayload(source: SiteReprintSource, input: SiteReprintAuditInput) = "${input.recordId}:${input.outcome}:${input.sequence}"
        override suspend fun report(payload: String): SiteReprintReceipt {
            reports += payload
            if (offline) throw IOException("offline")
            return SiteReprintReceipt.Accepted
        }
    }
    @Before fun open() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
        db.printerDao().upsert(PrinterEntity("p", "Box printer", "wifi", "original:9100", "zpl", 203, false, null, null))
        db.printerDao().assign(PrinterAssignmentEntity("box", "p"))
    }
    @After fun close() = db.close()
    private fun engine(backend: Backend, wire: Wire) = SiteReprintEngine(db, backend, renderer, wire, { operator })

    @Test fun aScanImmediatelyPrintsAndAuditReplayNeverPrintsAgain() = runTest {
        val backend = Backend(); val wire = Wire(); val engine = engine(backend, wire)
        val result = engine.print(sscc, "damaged", session, "operator") as SiteReprintResult.Printed
        assertEquals(1, wire.sends)
        assertEquals(listOf("prepared", "sending", "sent"), db.siteReprintDao().history(result.jobId).map { it.payload.split(':')[1] })
        assertNull(engine.pending())
        backend.offline = true
        engine.flushAudit()
        val first = backend.reports.single()
        backend.offline = false
        engine.flushAudit()
        assertEquals(first, backend.reports[1])
        assertEquals(1, wire.sends)
        assertTrue(db.siteReprintDao().history(result.jobId).all { it.state == "accepted" })
    }

    @Test fun unknownBlocksFreshScansAndRetryReplaysFrozenPrinterLayoutAndBytes() = runTest {
        val backend = Backend(); val wire = Wire().also { it.outcome = SendOutcome.Unknown("lost") }
        val engine = engine(backend, wire)
        val result = engine.print(sscc, "lost", session, "operator") as SiteReprintResult.Unknown
        assertTrue(engine.print(sscc, "lost", session, "operator") is SiteReprintResult.Unknown)
        assertEquals(1, wire.sends)
        db.printerDao().upsert(PrinterEntity("replacement", "New", "wifi", "new:9100", "tspl", 300, false, null, null))
        db.printerDao().assign(PrinterAssignmentEntity("box", "replacement"))
        backend.catalog = emptyList()
        wire.outcome = SendOutcome.Delivered
        assertTrue(engine.retry(result.jobId, "operator") is SiteReprintResult.Printed)
        assertEquals(2, wire.sends)
        assertArrayEquals(wire.documents[0], wire.documents[1])
        assertEquals("original:9100", wire.targets[1].address)
        assertEquals(2, db.siteReprintDao().job(result.jobId)?.attempt)
    }

    @Test fun restartConvertsSendingToUnknownWithoutTouchingPrinter() = runTest {
        val backend = Backend(); val wire = Wire(); val first = engine(backend, wire)
        val printed = first.print(sscc, "damaged", session, "operator") as SiteReprintResult.Printed
        val job = checkNotNull(db.siteReprintDao().job(printed.jobId))
        db.siteReprintDao().save(job.copy(state = "sending"))
        val restarted = engine(backend, wire)
        assertEquals("unknown", restarted.pending()?.state)
        assertEquals(1, wire.sends)
        assertEquals("process_interrupted", db.siteReprintDao().job(job.jobId)?.error)
    }

    @Test fun mismatchingVerificationDoesNotPrintOrClearUnknownJob() = runTest {
        val backend = Backend(); val wire = Wire().also { it.outcome = SendOutcome.Unknown("lost") }
        val engine = engine(backend, wire)
        val unknown = engine.print(sscc, "lost", session, "operator") as SiteReprintResult.Unknown
        val wrong = engine.verify(unknown.jobId, "146800899000000015", "operator") as SiteReprintResult.Failed
        assertEquals("verification_mismatch", wrong.code)
        assertEquals("unknown", engine.pending()?.state)
        assertTrue(engine.verify(unknown.jobId, sscc, "operator") is SiteReprintResult.Printed)
        assertNull(engine.pending())
        assertEquals(1, wire.sends)
    }

    @Test fun aLateLookupFromThePreviousOperatorNeverPrints() = runTest {
        val backend = Backend(); val wire = Wire(); val engine = engine(backend, wire)
        val arrived = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        backend.answer = { arrived.complete(Unit); release.await(); SiteReprintLookup.Found(source) }
        val running = async { engine.print(sscc, "damaged", session, "operator") }
        arrived.await()
        assertEquals(SiteReprintResult.Busy, engine.print(sscc, "damaged", session, "operator"))
        operator = "another-operator"; release.complete(Unit)
        assertEquals("operator_changed", (running.await() as SiteReprintResult.Failed).code)
        assertEquals(0, wire.sends)
    }

    @Test fun noPaperIsRecoverableWithoutLookingUpTheSourceAgain() = runTest {
        val backend = Backend(); val wire = Wire().also { it.status = PrinterStatus.NotReady(NotReadyReason.NO_PAPER) }
        val engine = engine(backend, wire)
        val failed = engine.print(sscc, "not_printed", session, "operator") as SiteReprintResult.Failed
        assertEquals("no_paper", failed.code)
        assertEquals(0, wire.sends)
        backend.answer = { error("retry must not look up historical fields again") }
        wire.status = PrinterStatus.Ready
        assertTrue(engine.retry(checkNotNull(failed.jobId), "operator") is SiteReprintResult.Printed)
    }

    @Test fun missingAssignmentsOrAmbiguousTemplatesNeverSend() = runTest {
        val backend = Backend(); val wire = Wire(); val engine = engine(backend, wire)
        db.printerDao().assign(PrinterAssignmentEntity("box", null))
        assertEquals("printer_unconfigured", (engine.print(sscc, "lost", session, "operator") as SiteReprintResult.Failed).code)
        db.printerDao().assign(PrinterAssignmentEntity("box", "p"))
        backend.catalog = listOf(template, template.copy(id = "other"))
        assertEquals("template_unconfigured", (engine.print(sscc, "lost", session, "operator") as SiteReprintResult.Failed).code)
        assertEquals(0, wire.sends)
    }

    @Test fun unavailableHistoricalFieldsCannotBePrintedByAnAssignedLayout() = runTest {
        val backend = Backend(); val wire = Wire(); val engine = engine(backend, wire)
        val withExpiry = spec.replace("\"elements\":[", "\"elements\":[{\"kind\":\"field\",\"id\":\"expiry\",\"xMm\":2,\"yMm\":30,\"field\":\"expiry\",\"fontSizePt\":8},")
        backend.catalog = listOf(template.copy(specJson = withExpiry))
        backend.answer = { SiteReprintLookup.Found(source.copy(fields = source.fields + ("expiry" to ""), unavailableFields = listOf("expiry"))) }
        val refused = engine.print(sscc, "lost", session, "operator") as SiteReprintResult.Failed
        assertEquals("source_fields_missing", refused.code)
        assertEquals(0, wire.sends)
    }

    @Test fun sourceIdentityAndKindCannotBeSubstitutedByTheLookup() = runTest {
        val backend = Backend(); val wire = Wire(); val engine = engine(backend, wire)
        backend.answer = { SiteReprintLookup.Found(source.copy(identity = "146800899000000015")) }
        assertTrue(engine.print(sscc, "lost", session, "operator") is SiteReprintResult.Unavailable)
        assertEquals(0, wire.sends)
    }
    @Test fun definiteFailureCanBeCancelledButUnknownDeliveryCannot() = runTest {
        val backend = Backend(); val wire = Wire().also { it.status = PrinterStatus.NotReady(NotReadyReason.NO_PAPER) }
        val engine = engine(backend, wire)
        val failed = engine.print(sscc, "lost", session, "operator") as SiteReprintResult.Failed
        assertTrue(engine.cancel(checkNotNull(failed.jobId), "operator") is SiteReprintResult.Cancelled)
        assertNull(engine.pending())
        wire.status = PrinterStatus.Ready
        wire.outcome = SendOutcome.Unknown("lost")
        val unknown = engine.print(sscc, "lost", session, "operator") as SiteReprintResult.Unknown
        assertTrue(engine.cancel(unknown.jobId, "operator") is SiteReprintResult.Unknown)
        assertEquals("unknown", engine.pending()?.state)
        assertEquals(1, wire.sends)
    }

    @Test fun rejectedAuditQuarantinesLaterEventsWithoutReprinting() = runTest {
        val backend = Backend(); val wire = Wire(); val engine = engine(backend, wire)
        val printed = engine.print(sscc, "damaged", session, "operator") as SiteReprintResult.Printed
        val first = db.siteReprintDao().history(printed.jobId).first()
        db.siteReprintDao().acknowledge(first.recordId, first.payload, "rejected", "source_changed")
        engine.flushAudit()
        assertTrue(backend.reports.isEmpty())
        assertEquals(1, wire.sends)
        val counts = db.siteReprintDao().counts(first.ownerJson, first.generation)
        assertEquals(ReprintAuditCounts(2, 1), counts)
    }

    @Test fun datasetReplacementArchivesUnknownEvidenceWithoutRebindingHardwareJobs() = runTest {
        val backend = Backend(); val wire = Wire().also { it.outcome = SendOutcome.Unknown("lost") }
        val engine = engine(backend, wire)
        val unknown = engine.print(sscc, "damaged", session, "operator") as SiteReprintResult.Unknown
        val original = checkNotNull(db.siteReprintDao().job(unknown.jobId))
        db.runInTransaction { app.markiro.handheld.core.storage.clearHostDatasetBusinessTables(db) }
        assertNull(db.siteReprintDao().job(unknown.jobId))
        val archived = db.metaDao().withPrefix("site_reprint_evidence:").single().value
        assertTrue(archived.contains(original.jobId))
        assertTrue(archived.contains(original.bytesBase64))
        assertNotNull(db.printerDao().assigned(PrintPurpose.BOX))
        assertEquals(1, wire.sends)
    }

    @Test fun unitAndPalletUseTheirOwnConfiguredPurposeAndPreserveFullUnitCode() = runTest {
        val backend = Backend(); val wire = Wire(); val engine = engine(backend, wire)
        val km = "010460068200001321abcDEF1234567\u001d93crypto"
        val unitSpec = spec.replace("code128", "datamatrix").replace("\"data\":\"sscc\"", "\"data\":\"km.code\"")
        val unit = source.copy(kind = "unit", identity = app.markiro.handheld.core.km.KmCodec.hash(app.markiro.handheld.core.duplicate.parseDuplicateKm(km)), fields = mapOf("km.code" to km))
        db.printerDao().assign(PrinterAssignmentEntity("duplicate", "p"))
        backend.catalog = listOf(template.copy(kind = "unit", specJson = unitSpec))
        backend.answer = { SiteReprintLookup.Found(unit) }
        val printed = engine.print(km, "damaged", session, "operator") as SiteReprintResult.Printed
        val frozen = Json.decodeFromString<SiteReprintSource>(checkNotNull(db.siteReprintDao().job(printed.jobId)).sourceJson)
        assertEquals(km, frozen.fields["km.code"])
        db.printerDao().assign(PrinterAssignmentEntity("pallet", "p"))
        backend.catalog = listOf(template.copy(kind = "pallet"))
        backend.answer = { SiteReprintLookup.Found(source.copy(kind = "pallet", sourceJson = "{\"data\":{\"brandingJson\":null}}")) }
        assertTrue(engine.print(sscc, "damaged", session, "operator") is SiteReprintResult.Printed)
        assertEquals(2, wire.sends)
    }

    @Test fun clockCorrectionCannotReorderCausalAuditEvents() = runTest {
        val backend = Backend(); val wire = Wire()
        var time = 10_000L
        val engine = SiteReprintEngine(db, backend, renderer, wire, { operator }, { time.also { time -= 1_000 } })
        engine.print(sscc, "damaged", session, "operator")
        engine.flushAudit()
        assertEquals(listOf("prepared", "sending", "sent"), backend.reports.map { it.split(':')[1] })
        assertEquals(1, wire.sends)
    }

    @Test fun sourceDefaultIsBoundAfterTheLatestCatalogRefresh() = runTest {
        val backend = Backend(); val wire = Wire(); val engine = engine(backend, wire)
        var refreshed = false
        backend.catalog = listOf(template, template.copy(id = "new-default"))
        backend.onRefresh = { refreshed = true }
        backend.answer = { SiteReprintLookup.Found(source.copy(defaultTemplateId = if (refreshed) "new-default" else "template")) }
        val printed = engine.print(sscc, "damaged", session, "operator") as SiteReprintResult.Printed
        val frozen = Json.decodeFromString<SiteReprintTemplate>(checkNotNull(db.siteReprintDao().job(printed.jobId)).templateJson)
        assertEquals("new-default", frozen.id)
    }

    @Test fun malformedOrIncompleteScansAreRefusedBeforeAnyLookupAndLeaveScanningReady() = runTest {
        val backend = Backend(); val wire = Wire(); val engine = engine(backend, wire)
        backend.answer = { error("invalid input must not reach a backend") }
        for (raw in listOf("not-a-code", "010460068200001321abcDEF1234567")) {
            assertTrue(engine.print(raw, "damaged", session, "operator") is SiteReprintResult.Unavailable)
        }
        assertNull(engine.pending())
        assertEquals(0, wire.sends)
    }

}
