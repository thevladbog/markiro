package app.markiro.handheld.core.reprint

import app.markiro.handheld.core.print.applyPrinterOutputMode

import app.markiro.handheld.core.duplicate.compareDuplicateKm
import app.markiro.handheld.core.duplicate.DuplicateMatch
import app.markiro.handheld.core.duplicate.parseDuplicateKm
import app.markiro.handheld.core.inventory.ScanClassifier
import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.km.KmException
import app.markiro.handheld.core.label.*
import app.markiro.handheld.core.print.*
import app.markiro.handheld.core.storage.DeviceOwner
import app.markiro.handheld.core.storage.GenerationToken
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaEntity
import app.markiro.handheld.core.storage.RecoveryBlocked
import app.markiro.handheld.core.util.Iso
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.IOException
import java.util.Base64
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/** Only this engine touches hardware for site-wide reprints; audit replay never enters this path. */
@Singleton
class SiteReprintEngine(
    private val db: HandheldDatabase,
    private val backend: SiteReprintBackend,
    private val renderer: LabelRenderer,
    private val transport: PrinterTransport,
    private val currentOperator: () -> String?,
    private val clock: () -> Long = System::currentTimeMillis,
) : SiteReprintOperations {
    @Inject constructor(db: HandheldDatabase, backend: SiteReprintBackend, renderer: LabelRenderer,
        transport: PrinterTransport, session: SessionHolder) : this(db, backend, renderer, transport,
        { session.state.value.takeUnless { it.locked }?.operator?.operatorId })

    private val printing = Mutex()
    private val uploading = Mutex()
    private val dao get() = db.siteReprintDao()
    private val json = Json { ignoreUnknownKeys = true }
    private fun owner(token: GenerationToken) = json.encodeToString(token.owner)
    private fun now() = Iso.format(clock())
    private fun authorized(operatorId: String) = currentOperator() == operatorId

    override suspend fun refreshTemplates() = db.recovery.work {
        cacheTemplates(backend.refreshTemplates())
    }

    private suspend fun cacheTemplates(templates: List<SiteReprintTemplate>) = db.recovery.commit {
        val previous = db.metaDao().get(CATALOG)?.let { runCatching { json.decodeFromString<List<SiteReprintTemplate>>(it) }.getOrNull() }.orEmpty()
        for (old in previous) if (templates.none { it.id == old.id }) db.printTemplateDao().removeTemplate(old.id)
        for (t in templates) {
            val purpose = purpose(t.kind) ?: continue
            if (printableTemplate(t.specJson) == null) continue
            db.printTemplateDao().cache(CachedLabelTemplate(t.id, purpose.wire, t.name, t.specJson,
                t.productId, t.groupCodes?.let { json.encodeToString(it) }))
        }
        db.metaDao().put(MetaEntity(CATALOG, json.encodeToString(templates)))
    }

    override suspend fun print(raw: String, reason: String, sessionId: String, operatorId: String): SiteReprintResult {
        if (!printing.tryLock()) return SiteReprintResult.Busy
        var preparedId: String? = null
        try {
            return db.recovery.work {
                if (!authorized(operatorId)) return@work SiteReprintResult.Failed("operator_changed")
                if (reason !in REASONS || runCatching { UUID.fromString(sessionId) }.isFailure) return@work SiteReprintResult.Failed("reason_required")
                val token = db.recovery.token()
                recoverInterrupted(token)
                dao.unresolved(owner(token), token.generation).firstOrNull()?.let { return@work result(it) }
                if (siteReprintSscc(raw) == null) {
                    try { parseDuplicateKm(raw) }
                    catch (invalid: KmException) {
                        return@work SiteReprintResult.Unavailable(if (invalid.code == "KM_REPRINT_INCOMPLETE") "incomplete_km" else "source_not_printable")
                    }
                }
                // Bind source defaults only after their current reference data is available.
                val templates = backend.refreshTemplates()
                cacheTemplates(templates)
                if (!authorized(operatorId)) return@work SiteReprintResult.Failed("operator_changed")
                val source = when (val answer = backend.lookup(raw, operatorId)) {
                    is SiteReprintLookup.Found -> answer.source
                    SiteReprintLookup.NotFound -> return@work SiteReprintResult.NotFound
                    is SiteReprintLookup.Unavailable -> return@work SiteReprintResult.Unavailable(answer.code)
                }
                if (!validSource(source, raw)) return@work SiteReprintResult.Unavailable("source_mismatch")
                if (!authorized(operatorId)) return@work SiteReprintResult.Failed("operator_changed")
                val purpose = purpose(source.kind) ?: return@work SiteReprintResult.Unavailable("source_not_printable")
                val configured = db.recovery.commit {
                    val printer = db.printerDao().assigned(purpose) ?: return@commit null
                    val chosenId = db.printTemplateDao().choice(printer.id, purpose.wire)?.templateId
                    val fitting = templates.filter { it.kind == source.kind && fits(it, source) }
                    val template = if (chosenId != null) fitting.firstOrNull { it.id == chosenId } else {
                        source.defaultTemplateId?.let { id ->
                            fitting.firstOrNull { it.id == id } ?: fitting.firstOrNull { it.lotNumberSourceId == id }
                        } ?: fitting.singleOrNull()
                    }
                    printer to template
                } ?: return@work SiteReprintResult.Failed("printer_unconfigured")
                val (printer, template) = configured
                if (template == null) return@work SiteReprintResult.Failed("template_unconfigured")
                val spec = printableTemplate(template.specJson) ?: return@work SiteReprintResult.Failed("template_invalid")
                if (!validBarcode(spec, source.kind)) return@work SiteReprintResult.Failed("template_incompatible")
                val usedFields = spec.elements.mapNotNull { element -> when (element) {
                    is LabelElement.Field -> element.field.wire
                    is LabelElement.Barcode -> (element.data as? BarcodeSource.Field)?.field?.wire
                    else -> null
                } }
                if (usedFields.any { it in source.unavailableFields || it !in source.fields })
                    return@work SiteReprintResult.Failed("source_fields_missing")
                val fields = source.fields.mapKeys { LabelField.fromWire(it.key) }
                val language = PrinterLanguage.fromWire(printer.language)
                val bytes = applyPrinterOutputMode(if (source.kind == "pallet" && db.deviceConfigDao().get()?.backend == "cloud") {
                    val logo = historicalReprintLogo(source, token.owner.tenantId)
                    if (logo == null && spec.elements.any { it is LabelElement.OrganizationLogo }) return@work SiteReprintResult.Failed("branding_unavailable")
                    renderer.renderWithLogo(spec, fields, language, printer.dpi, logo)
                } else renderer.render(spec, fields, language, printer.dpi), printer.language, printer.outputMode)
                if (bytes.isEmpty()) return@work SiteReprintResult.Failed("render_failed")
                if (!authorized(operatorId)) return@work SiteReprintResult.Failed("operator_changed")
                val at = now()
                val job = SiteReprintJob(UUID.randomUUID().toString(), sessionId, owner(token), token.generation,
                    operatorId, db.deviceConfigDao().get()?.backend ?: throw RecoveryBlocked(),
                    json.encodeToString(source), json.encodeToString(template), json.encodeToString(ReprintPrinter.of(printer)),
                    Base64.getEncoder().encodeToString(bytes), reason, "prepared", null, UUID.randomUUID().toString(), 1, 0, at, at)
                db.recovery.printing {
                    if (!authorized(operatorId)) return@printing SiteReprintResult.Failed("operator_changed")
                    val saved = transition(job, "prepared")
                    preparedId = job.jobId
                    send(saved, operatorId)
                }
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: IOException) { return SiteReprintResult.Failed("network_required") }
        catch (_: LabelRenderException) { return SiteReprintResult.Failed("render_failed") }
        catch (_: Exception) {
            // A failed journal write after transport started is uncertain, never a fresh printable job.
            return preparedId?.let { SiteReprintResult.Unknown(it, "") } ?: SiteReprintResult.Failed("operation_failed")
        } finally { printing.unlock() }
    }

    override suspend fun retry(jobId: String, operatorId: String): SiteReprintResult = exclusive {
        val job = ownedJob(jobId, operatorId) ?: return@exclusive SiteReprintResult.Failed("operator_changed")
        if (job.state !in setOf("prepared", "failed", "unknown")) return@exclusive result(job)
        val ready = if (job.state == "prepared") job else transition(job.copy(attempt = job.attempt + 1,
            attemptId = UUID.randomUUID().toString()), "prepared")
        db.recovery.printing { send(ready, operatorId) }
    }

    override suspend fun cancel(jobId: String, operatorId: String): SiteReprintResult = exclusive {
        val job = ownedJob(jobId, operatorId) ?: return@exclusive SiteReprintResult.Failed("operator_changed")
        if (job.state !in setOf("prepared", "failed")) return@exclusive result(job)
        transition(job, "cancelled")
        SiteReprintResult.Cancelled(jobId)
    }

    override suspend fun verify(jobId: String, raw: String, operatorId: String): SiteReprintResult = exclusive {
        val job = ownedJob(jobId, operatorId) ?: return@exclusive SiteReprintResult.Failed("operator_changed")
        if (job.state != "unknown") return@exclusive result(job)
        val source = json.decodeFromString<SiteReprintSource>(job.sourceJson)
        val matches = if (source.kind == "unit") compareDuplicateKm(source.fields.getValue("km.code"), raw) == DuplicateMatch.MATCH
            else ScanClassifier.parseSscc(raw.trim()) == source.identity
        if (!matches) return@exclusive SiteReprintResult.Failed("verification_mismatch", jobId)
        result(transition(job, "verified"))
    }

    private suspend fun exclusive(block: suspend () -> SiteReprintResult): SiteReprintResult {
        if (!printing.tryLock()) return SiteReprintResult.Busy
        try { return db.recovery.work { block() } }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { return SiteReprintResult.Failed("operation_failed") }
        finally { printing.unlock() }
    }

    private suspend fun ownedJob(id: String, operatorId: String): SiteReprintJob? {
        if (!authorized(operatorId)) return null
        val token = db.recovery.token()
        val job = dao.job(id) ?: return null
        return job.takeIf { it.ownerJson == owner(token) && it.generation == token.generation && it.operatorId == operatorId }
    }

    private suspend fun send(job: SiteReprintJob, operatorId: String): SiteReprintResult {
        if (!authorized(operatorId)) return SiteReprintResult.Failed("operator_changed", job.jobId)
        val printer = json.decodeFromString<ReprintPrinter>(job.printerJson).entity()
        val status = transport.statusRemembered(printer, db.printerDao(), db.recovery)
        if (status is PrinterStatus.NotReady) {
            val reason = if (status.reason == NotReadyReason.PAPER_JAM) NotReadyReason.OTHER else status.reason
            return result(transition(job, "failed", reason.name.lowercase()))
        }
        if (!authorized(operatorId)) return SiteReprintResult.Failed("operator_changed", job.jobId)
        val sending = transition(job, "sending")
        val outcome = try { transport.sendRemembered(printer, Base64.getDecoder().decode(job.bytesBase64), db.printerDao(), db.recovery) }
            catch (_: Exception) { SendOutcome.Unknown("transport_interrupted") }
        val saved = when (outcome) {
            SendOutcome.Delivered -> transition(sending, "sent")
            is SendOutcome.Refused -> transition(sending, "failed", outcome.reason.name.lowercase())
            is SendOutcome.Unknown -> transition(sending, "unknown", "print_outcome_unknown")
        }
        return result(saved)
    }

    private suspend fun transition(job: SiteReprintJob, state: String, error: String? = null): SiteReprintJob = db.recovery.commit {
        val next = job.copy(state = state, error = error, sequence = job.sequence + 1, updatedAt = now())
        val source = json.decodeFromString<SiteReprintSource>(job.sourceJson)
        val template = json.decodeFromString<SiteReprintTemplate>(job.templateJson)
        val printer = json.decodeFromString<ReprintPrinter>(job.printerJson)
        val eventId = UUID.randomUUID().toString()
        val input = SiteReprintAuditInput(eventId, job.sessionId, job.jobId, job.attemptId, job.attempt,
            job.reason, state, error, template, printer.id, printer.language, printer.dpi, job.bytesBase64,
            job.operatorId, next.updatedAt, next.sequence)
        val payload = backend.auditPayload(source, input)
        dao.save(next)
        dao.append(SiteReprintAudit(eventId, job.jobId, job.ownerJson, job.generation, job.backend,
            next.sequence, next.updatedAt, payload))
        next
    }

    private suspend fun recoverInterrupted(token: GenerationToken) {
        for (job in dao.unresolved(owner(token), token.generation)) if (job.state == "sending") transition(job, "unknown", "process_interrupted")
    }

    override suspend fun pending(): SiteReprintJob? {
        if (!printing.tryLock()) return null
        try { return db.recovery.work {
            val token = db.recovery.token()
            recoverInterrupted(token)
            dao.unresolved(owner(token), token.generation).firstOrNull()
        } } finally { printing.unlock() }
    }

    override suspend fun flushAudit() {
        if (!uploading.tryLock()) return
        try { db.recovery.work {
            val token = db.recovery.token()
            // Recovery does no I/O to the printer. Defer it if a live send owns the journal.
            if (printing.tryLock()) try { recoverInterrupted(token) } finally { printing.unlock() }
            for (event in dao.owed(owner(token), token.generation)) {
                val answer = try { backend.report(event.payload) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { break }
                db.recovery.commit(token) {
                    dao.acknowledge(event.recordId, event.payload,
                        if (answer is SiteReprintReceipt.Accepted) "accepted" else "rejected",
                        (answer as? SiteReprintReceipt.Rejected)?.code)
                }
                if (answer is SiteReprintReceipt.Rejected) break
            }
        } } finally { uploading.unlock() }
    }

    private fun result(job: SiteReprintJob): SiteReprintResult {
        val source = json.decodeFromString<SiteReprintSource>(job.sourceJson)
        val description = source.productName
        return when (job.state) {
            "sent", "verified" -> SiteReprintResult.Printed(job.jobId, description)
            "unknown", "sending" -> SiteReprintResult.Unknown(job.jobId, description)
            else -> SiteReprintResult.Failed(job.error ?: "pending_print", job.jobId)
        }
    }

    private fun fits(t: SiteReprintTemplate, s: SiteReprintSource) =
        (t.productId == null || t.productId == s.productId) &&
            (t.groupCodes == null || s.groupCode in t.groupCodes) &&
            (s.fields[LabelField.LOT_NUMBER.wire].isNullOrEmpty() || printableTemplate(t.specJson)?.bindsLotNumber() == true)

    private fun validSource(s: SiteReprintSource, raw: String): Boolean = try {
        when (s.kind) {
            "box", "pallet" -> s.fields["sscc"] == s.identity && siteReprintSscc(raw) == s.identity
            "unit" -> {
                val printed = parseDuplicateKm(s.fields.getValue("km.code"))
                printed.canonicalRaw == parseDuplicateKm(raw).canonicalRaw && KmCodec.hash(printed) == s.identity
            }
            else -> false
        }
    } catch (_: Exception) { false }

    private fun validBarcode(spec: LabelSpec, kind: String): Boolean {
        val barcodes = spec.elements.filterIsInstance<LabelElement.Barcode>()
        return if (kind == "unit") barcodes.count { it.format == BarcodeFormat.DATAMATRIX && it.data == BarcodeSource.Field(LabelField.KM_CODE) } == 1 &&
            barcodes.none { it.data == BarcodeSource.Field(LabelField.SSCC) }
        else barcodes.count { it.format == BarcodeFormat.CODE128 && it.data == BarcodeSource.Field(LabelField.SSCC) } == 1 &&
            spec.elements.none { (it is LabelElement.Barcode && it.data == BarcodeSource.Field(LabelField.KM_CODE)) || (it is LabelElement.Field && it.field == LabelField.KM_CODE) }
    }

    companion object {
        const val CATALOG = "site_reprint_catalog"
        val REASONS = setOf("not_printed", "damaged", "lost")
        fun purpose(kind: String): PrintPurpose? = when (kind) { "unit" -> PrintPurpose.DUPLICATE; "box" -> PrintPurpose.BOX; "pallet" -> PrintPurpose.PALLET; else -> null }
    }
}
