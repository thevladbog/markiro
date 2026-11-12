package app.markiro.handheld.core.print

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import app.markiro.handheld.core.label.LabelElement
import app.markiro.handheld.core.label.LabelField
import app.markiro.handheld.core.label.LabelRenderException
import app.markiro.handheld.core.label.LabelSpec
import app.markiro.handheld.core.label.LabelSpecCodec
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletKind
import app.markiro.handheld.core.storage.PalletLabelTemplateEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/** Received reference data, never a new source of authority for production operators. */
@Entity(tableName = "label_template_catalog", primaryKeys = ["id"])
data class CachedLabelTemplate(
    val id: String,
    val purpose: String,
    val name: String,
    val specJson: String,
    val productId: String? = null,
    val groupCodes: String? = null,
) {
    fun fits(product: String?, group: Int?): Boolean {
        if (productId != null && productId != product) return false
        val groups = groupCodes ?: return true
        val array = try { Json.parseToJsonElement(groups) as? JsonArray } catch (_: IllegalArgumentException) { null }
            ?: return false
        return group != null && array.any { (it as? JsonPrimitive)?.intOrNull == group }
    }
}

@Entity(tableName = "printer_template_choices", primaryKeys = ["printerId", "purpose"])
data class PrinterTemplateChoice(val printerId: String, val purpose: String, val templateId: String)

/** Separate from the destination: explicit replacement of a printer must not change the layout. */
@Entity(tableName = "print_template_snapshots", primaryKeys = ["purpose", "jobId"])
data class PrintTemplateSnapshot(val purpose: String, val jobId: String, val specJson: String?, val reason: String? = null)

@Dao
interface PrintTemplateDao {
    @Query("SELECT * FROM label_template_catalog ORDER BY name, id")
    fun observeCatalog(): Flow<List<CachedLabelTemplate>>
    @Query("SELECT * FROM label_template_catalog WHERE id = :id")
    suspend fun template(id: String): CachedLabelTemplate?
    @Upsert suspend fun cache(row: CachedLabelTemplate)
    @Query("DELETE FROM label_template_catalog WHERE id = :id")
    suspend fun removeTemplate(id: String)
    @Query("SELECT * FROM printer_template_choices")
    fun observeChoices(): Flow<List<PrinterTemplateChoice>>
    @Query("SELECT * FROM printer_template_choices WHERE printerId = :printerId AND purpose = :purpose")
    suspend fun choice(printerId: String, purpose: String): PrinterTemplateChoice?
    @Upsert suspend fun choose(row: PrinterTemplateChoice)
    @Query("DELETE FROM printer_template_choices WHERE printerId = :printerId AND purpose = :purpose")
    suspend fun clearChoice(printerId: String, purpose: String)
    @Query("DELETE FROM printer_template_choices WHERE printerId = :printerId")
    suspend fun removePrinter(printerId: String)
    @Query("SELECT * FROM print_template_snapshots WHERE purpose = :purpose AND jobId = :jobId")
    suspend fun snapshot(purpose: String, jobId: String): PrintTemplateSnapshot?
    @Query("UPDATE print_template_snapshots SET specJson = :spec, reason = :reason WHERE purpose = :purpose AND jobId = :jobId AND specJson IS :oldSpec AND reason IS :oldReason")
    suspend fun recoverUnsent(purpose: String, jobId: String, spec: String?, reason: String?, oldSpec: String?, oldReason: String?)
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun freeze(row: PrintTemplateSnapshot)
    @Query("UPDATE print_template_snapshots SET specJson = :spec WHERE purpose = :purpose AND jobId = :jobId AND specJson IS NULL AND reason IS NULL")
    suspend fun fillMissingSource(purpose: String, jobId: String, spec: String)
}

/** Uses the existing supported Kotlin spec model; preview and printing consume this same JSON. */
fun printableTemplate(json: String): LabelSpec? = try {
    LabelSpecCodec.parse(json).takeIf {
        it.widthMm.isFinite() && it.heightMm.isFinite() && it.widthMm in 10.0..300.0 && it.heightMm in 10.0..300.0 && it.dpi in setOf(203, 300)
    }
} catch (_: LabelRenderException) {
    null
} catch (_: IllegalArgumentException) {
    null
}

internal fun LabelSpec.bindsLotNumber(): Boolean =
    elements.any { it is LabelElement.Field && it.field == LabelField.LOT_NUMBER }

class PrintTemplateStore(private val db: HandheldDatabase) {
    private val dao get() = db.printTemplateDao()

    suspend fun cache(row: CachedLabelTemplate) = db.recovery.commit {
        if (row.purpose !in setOf("box", "pallet", "duplicate") || printableTemplate(row.specJson) == null) dao.removeTemplate(row.id)
        else dao.cache(row)
    }

    suspend fun select(printerId: String, purpose: PrintPurpose, templateId: String?, expectedSpec: String? = null): Boolean = db.recovery.commit {
        if (db.printerDao().get(printerId) == null) return@commit false
        if (templateId == null) {
            dao.clearChoice(printerId, purpose.wire)
        } else {
            val template = dao.template(templateId) ?: return@commit false
            if (template.purpose != purpose.wire || printableTemplate(template.specJson) == null || (expectedSpec != null && template.specJson != expectedSpec)) return@commit false
            dao.choose(PrinterTemplateChoice(printerId, purpose.wire, templateId))
        }
        db.printerDao().assign(PrinterAssignmentEntity(purpose.wire, printerId))
        true
    }

    private suspend fun resolve(
        purpose: PrintPurpose, jobId: String, source: String?, productId: String?, groupCode: Int?,
        requiresLotNumber: Boolean, printerId: String? = null,
    ): PrintTemplateSnapshot {
        val target = printerId ?: db.printerDao().assigned(purpose)?.id
        val choice = target?.let { dao.choice(it, purpose.wire) }
        val spec = if (choice == null) {
            source
        } else {
            val template = dao.template(choice.templateId)
            if (template == null || template.purpose != purpose.wire || !template.fits(productId, groupCode)) {
                return PrintTemplateSnapshot(purpose.wire, jobId, null, "template_incompatible")
            }
            template.specJson
        }
        if (spec != null && (choice != null || requiresLotNumber)) {
            val parsed = printableTemplate(spec)
                ?: return PrintTemplateSnapshot(purpose.wire, jobId, null, "template_invalid")
            if (requiresLotNumber && !parsed.bindsLotNumber()) {
                return PrintTemplateSnapshot(purpose.wire, jobId, null, "template_incompatible")
            }
        }
        return PrintTemplateSnapshot(purpose.wire, jobId, spec)
    }

    suspend fun freeze(
        purpose: PrintPurpose, jobId: String, source: String?, productId: String?, groupCode: Int? = null,
        requiresLotNumber: Boolean = false,
    ): PrintTemplateSnapshot = db.recovery.commit {
        require(purpose != PrintPurpose.DUPLICATE)
        dao.snapshot(purpose.wire, jobId)?.let { return@commit it }
        val row = resolve(purpose, jobId, source, productId, groupCode, requiresLotNumber)
        dao.freeze(row)
        // Same transaction as closure and layout: no assignment edit can retarget a queued job.
        PrintDestinations(db).retain(purpose, jobId)
        row
    }

    /** Recovery is allowed only after a definite pre-render template refusal, never after sending bytes. */
    suspend fun forPrint(
        purpose: PrintPurpose, jobId: String, source: String?, productId: String?, groupCode: Int? = null,
        recoverUnsent: Boolean = false, requiresLotNumber: Boolean = false,
    ): PrintTemplateSnapshot = db.recovery.commit {
        var row = freeze(purpose, jobId, source, productId, groupCode, requiresLotNumber)
        if (recoverUnsent && (row.reason != null || row.specJson?.let { printableTemplate(it) == null } == true)) {
            val target = PrintDestinations(db).get(purpose, jobId)?.id
            val resolved = resolve(purpose, jobId, source, productId, groupCode, requiresLotNumber, target)
            dao.recoverUnsent(purpose.wire, jobId, resolved.specJson, resolved.reason, row.specJson, row.reason)
            row = checkNotNull(dao.snapshot(purpose.wire, jobId))
        }
        // A legacy job missing its source may acquire that source later, never a new override.
        if (row.specJson == null && row.reason == null && source != null) {
            dao.fillMissingSource(purpose.wire, jobId, source)
            row.copy(specJson = source)
        } else row
    }

    suspend fun freezeBox(boxId: String, shiftId: String) {
        val shift = db.shiftDao().get(shiftId)
        val group = shift?.productId?.let { db.palletProductDao().byId(it)?.chzProductGroupCode }
        freeze(PrintPurpose.BOX, boxId, shift?.boxLabelTemplate, shift?.productId, group, requiresLotNumber = shift?.lotNumber != null)
    }

    suspend fun freezePallet(pallet: PalletEntity) {
        val shift = pallet.shiftId?.let { db.shiftDao().get(it) }
        val productId = if (pallet.kind == PalletKind.WAREHOUSE) pallet.productId else shift?.productId
        val group = productId?.let { db.palletProductDao().byId(it)?.chzProductGroupCode }
        val source = if (pallet.kind == PalletKind.WAREHOUSE) {
            group?.let { db.palletLabelTemplateDao().get(PalletLabelTemplateEntity.category(it)) }?.specJson
                ?: db.palletLabelTemplateDao().get(PalletLabelTemplateEntity.ORG)?.specJson
        } else shift?.palletLabelTemplateSpec
        freeze(PrintPurpose.PALLET, pallet.palletId, source, productId, group, requiresLotNumber = shift?.lotNumber != null)
    }
}
