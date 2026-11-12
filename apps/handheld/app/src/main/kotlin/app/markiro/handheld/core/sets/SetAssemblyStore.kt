package app.markiro.handheld.core.sets

import app.markiro.handheld.core.host.HostSyncEngine
import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.km.ParsedKm
import app.markiro.handheld.core.network.SetItemDto
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostOutboxEntity
import app.markiro.handheld.core.storage.MetaEntity
import app.markiro.handheld.core.storage.SetAssemblyClaimEntity
import app.markiro.handheld.core.storage.SetAssemblyEntity
import app.markiro.handheld.core.util.Iso
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

const val SET_ASSEMBLED = "set_assembled"

fun String?.decodeSetItems(): List<SetItemDto> = this?.let { Json.decodeFromString<List<SetItemDto>>(it) }.orEmpty()

class SetAssemblyStore(
    private val db: HandheldDatabase,
    private val now: () -> String = { Iso.format(System.currentTimeMillis()) },
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    fun observeDraft(shiftId: String) = db.metaDao().observe(draftKey(shiftId)).map(::decodeDraft)

    suspend fun scan(shiftId: String, raw: String, operatorId: String): SetScanResult? = db.recovery.commit {
        val config = db.deviceConfigDao().get() ?: return@commit null
        if (config.backend != "host" || config.activeShiftId != shiftId) return@commit null
        val shift = db.shiftDao().get(shiftId) ?: return@commit null
        val kitGtin = shift.productGtin14 ?: return@commit null
        val recipe = shift.setItemsJson.decodeSetItems()
        if (shift.status != "active" || recipe.isEmpty()) return@commit null
        val draft = decodeDraft(db.metaDao().get(draftKey(shiftId)))
        val input = setCodeOrNull(raw)
        val relevant = if (input?.gtin14 == kitGtin) draft + raw else listOf(raw)
        val hashes = relevant.mapNotNull(::setCodeOrNull).map(KmCodec::hash)
        val claimed = hashes.chunked(500).flatMap { db.setAssemblyDao().claimed(it) }.toSet()
        val result = judgeSetScan(kitGtin, recipe, draft, raw, claimed)
        if (result.status == SetScanStatus.ITEM_ADDED) {
            val encoded = Json.encodeToString(result.items)
            if (encoded.toByteArray(Charsets.UTF_8).size > MAX_SET_FACT_BYTES) {
                return@commit SetScanResult(SetScanStatus.TOO_LARGE, draft, result.remaining + 1)
            }
            db.metaDao().put(MetaEntity(draftKey(shiftId), encoded))
        }
        result.setCode?.let {
            if (!finish(shiftId, operatorId, it, result.items.map(KmCodec::canonicalize))) {
                return@commit result.copy(status = SetScanStatus.TOO_LARGE, setCode = null)
            }
        }
        result
    }

    suspend fun undo(shiftId: String, index: Int, raw: String) = db.recovery.commit {
        val config = db.deviceConfigDao().get() ?: return@commit
        if (config.backend != "host" || config.activeShiftId != shiftId) return@commit
        val key = draftKey(shiftId)
        val items = decodeDraft(db.metaDao().get(key)).toMutableList()
        if (items.getOrNull(index) != raw) return@commit
        items.removeAt(index)
        if (items.isEmpty()) db.metaDao().remove(key)
        else db.metaDao().put(MetaEntity(key, Json.encodeToString(items)))
    }

    private suspend fun finish(shiftId: String, operatorId: String, setCode: ParsedKm, items: List<ParsedKm>): Boolean {
        val id = newId()
        val assembledAt = now()
        val body = buildJsonObject {
            put("id", id)
            put("kind", SET_ASSEMBLED)
            put("shiftId", shiftId)
            put("operatorId", operatorId)
            put("data", buildJsonObject {
                put("assembledAt", assembledAt)
                put("setCode", scannedCode(setCode))
                put("items", JsonArray(items.map(::scannedCode)))
            })
        }.toString()
        // Leave space for the envelope and the Android cursor metadata for a single large record.
        if (body.toByteArray(Charsets.UTF_8).size > MAX_SET_FACT_BYTES) return false
        db.setAssemblyDao().insert(SetAssemblyEntity(id, shiftId, "queued"))
        db.setAssemblyDao().claim((items + setCode).map { SetAssemblyClaimEntity(KmCodec.hash(it), id) })
        check(db.hostOutboxDao().insert(HostOutboxEntity(
            recordId = id,
            target = HostSyncEngine.TARGET,
            kind = SET_ASSEMBLED,
            sourceKind = SET_ASSEMBLED,
            sourceKey = id,
            body = body,
            state = "queued",
            reason = null,
            createdAt = assembledAt,
        )) > 0)
        db.metaDao().remove(draftKey(shiftId))
        return true
    }

    companion object {
        private const val MAX_SET_FACT_BYTES = 1_887_436 // 1.8 MiB on the host
        fun draftKey(shiftId: String) = "set_assembly_draft:$shiftId"

        private fun decodeDraft(raw: String?): List<String> = raw?.let { Json.decodeFromString<List<String>>(it) }.orEmpty()

        private fun scannedCode(code: ParsedKm) = buildJsonObject {
            put("codeHash", KmCodec.hash(code))
            put("gtin14", code.gtin14)
            put("serial", code.serial)
            put("canonical", code.canonicalRaw)
        }
    }
}
