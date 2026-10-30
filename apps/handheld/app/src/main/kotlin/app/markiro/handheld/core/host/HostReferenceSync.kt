package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.ChangeItemDto
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostApiError
import app.markiro.handheld.core.network.host.HostFailure
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.OperatorBadgeEntity
import app.markiro.handheld.core.storage.OperatorEntity
import app.markiro.handheld.core.storage.PalletLabelTemplateEntity
import app.markiro.handheld.core.storage.PalletPermissionEntity
import app.markiro.handheld.core.storage.PalletProductEntity
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * The host's reference data (`GET /v1/changes`) into Room (spec 8.5, point 1): operators, their badges, the products of the pallet mode, the
 * labels' templates and the names of the line and the organization. Every page is applied in one transaction and its revision is kept with
 * it, so a crash re-reads the page. A record of access (`operators`, `operator_badges`) that cannot be read removes the local copy: an
 * unreadable verifier is no way in (the station's rule). A feed of another host stops the sync and writes nothing.
 */
class HostReferenceSync(
    private val db: HandheldDatabase,
    private val config: DeviceConfigDao,
    private val meta: MetaStore,
    private val api: HostApi,
    private val pageSize: Int = 500,
) {
    suspend fun sync(): Result<Unit> = runCatching {
        while (true) {
            val current = config.get() ?: error("the device is not paired")
            val since = current.hostRev ?: 0L
            val page = api.changes(since, pageSize).getOrThrow()
            if (current.hostId != null && page.hostId != current.hostId) throw HostApiError(HostFailure.Constraint("host_mismatch"))
            db.recovery.commit { applyPage(page.items, page.rev) }
            if (!page.hasMore) break
        }
    }

    private suspend fun applyPage(items: List<ChangeItemDto>, rev: Long) {
        for (item in items) {
            when (item.entity) {
                "operators" -> operator(item)
                "operator_badges" -> badge(item)
                "products" -> product(item)
                "lines" -> line(item)
                "label_templates" -> template(item)
                "category_template_defaults" -> categoryDefault(item)
                "org_profile" -> organization(item)
                "code_releases" -> releaseCodes(item)
                else -> Unit // `site`: nothing a handheld keeps
            }
        }
        rebuildPalletTemplates()
        rebuildPalletPermissions()
        resolveLineName()
        config.get()?.let { config.upsert(it.copy(hostRev = rev)) }
    }

    /**
     * The device's own record (`GET /v1/device`): the line the office assigned, which may come after the pairing or change later. A new line is
     * stored with its name when the feed already carried it. A failure changes nothing and is the caller's to ignore (the next beat asks again).
     */
    suspend fun refreshDevice(): Result<Unit> = runCatching {
        val device = api.device().getOrThrow()
        db.recovery.commit {
            val own = config.get() ?: return@commit
            if (own.lineId != device.lineId) config.upsert(own.copy(lineId = device.lineId, lineName = null))
            resolveLineName()
        }
    }

    /** The name of the device's own line from the lines the feed carried (the line may be assigned after the feed was read). */
    suspend fun refreshLineName() = db.recovery.commit { resolveLineName() }

    private suspend fun resolveLineName() {
        val own = config.get() ?: return
        val id = own.lineId ?: return
        val name = meta.get(lineKey(id)) ?: return
        if (name != own.lineName) config.upsert(own.copy(lineName = name))
    }

    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull

    private suspend fun releaseCodes(item: ChangeItemDto) {
        check(!item.deleted) { "A code release cannot be deleted" }
        val data=checkNotNull(item.data)
        val shiftId=checkNotNull(data.text("shiftId"))
        val at=checkNotNull(data.text("releasedAt"))
        java.time.Instant.parse(at)
        db.boxRegistryDao().removeBox(item.id)
        val box=db.boxDao().get(item.id) ?: return
        check(box.shiftId==shiftId && box.closedAt!=null) { "Code release does not match a closed local box" }
        db.boxDao().markDisassembled(box.boxId,at)
        // Keep raw outbox sources and frozen host bytes: only receipts retire those.
        db.codeDao().deleteInBox(box.boxId)
    }

    private suspend fun operator(item: ChangeItemDto) {
        val data = item.data
        val login = data?.text("login")
        val name = data?.text("name")
        val phc = data?.text("pinPhc")
        if (item.deleted || data == null || login == null || name == null || phc == null || !isReadableVerifier(phc)) {
            db.operatorDao().delete(item.id)
            db.operatorBadgeDao().deleteOf(item.id)
            return
        }
        db.operatorDao().upsert(OperatorEntity(item.id, name, login, data.text("role").orEmpty(), phc, null, true))
    }

    private suspend fun badge(item: ChangeItemDto) {
        val data = item.data
        val operatorId = data?.text("operatorId")
        val phc = data?.text("badgePhc")
        if (item.deleted || operatorId == null || phc == null || !isReadableVerifier(phc)) {
            db.operatorBadgeDao().delete(item.id)
            return
        }
        db.operatorBadgeDao().upsert(OperatorBadgeEntity(item.id, operatorId, phc, data.text("label")))
    }

    /** `pbkdf2$sha256$<iterations>$<salt>$<digest>`, the shape [app.markiro.handheld.core.auth.PhcVerifier] verifies. */
    private fun isReadableVerifier(phc: String): Boolean {
        val parts = phc.split('$')
        return parts.size == 5 && parts[0] == "pbkdf2" && parts[1] == "sha256" && parts[2].toIntOrNull() != null && parts[3].isNotEmpty() && parts[4].isNotEmpty()
    }

    private suspend fun product(item: ChangeItemDto) {
        val data = item.data
        if (item.deleted || data == null || data["archived"]?.let { (it as? JsonPrimitive)?.booleanOrNull } == true) {
            db.palletProductDao().delete(item.id)
            return
        }
        val gtin = data.text("gtin14") ?: return db.palletProductDao().delete(item.id)
        val name = data.text("name") ?: return db.palletProductDao().delete(item.id)
        fun int(key: String) = (data[key] as? JsonPrimitive)?.intOrNull
        db.palletProductDao().upsert(
            PalletProductEntity(item.id, gtin, name, data.text("printName"), int("shelfLifeDays"), int("palletBoxCapacity"), int("chzProductGroupCode")),
        )
    }

    private suspend fun line(item: ChangeItemDto) {
        val name = if (item.deleted) null else item.data?.text("name")
        if (name == null) meta.remove(lineKey(item.id)) else meta.put(lineKey(item.id), name)
    }

    private suspend fun template(item: ChangeItemDto) {
        val key = "host_template:${item.id}"
        val data = item.data
        if (item.deleted || data == null || data.text("purpose") != "pallet" || data["enabled"]?.let { (it as? JsonPrimitive)?.booleanOrNull } == false) {
            meta.remove(key)
            return
        }
        val spec = data["spec"]?.toString() ?: return meta.remove(key)
        meta.put(key, spec)
    }

    private suspend fun categoryDefault(item: ChangeItemDto) {
        val data = item.data
        val code = data?.let { (it["chzProductGroupCode"] as? JsonPrimitive)?.intOrNull }
        val purpose = data?.text("purpose")
        // The feed id is `<code>:<purpose>`; a tombstone has no data, so the key is read from the id.
        val (idCode, idPurpose) = item.id.split(':', limit = 2).let { (it.getOrNull(0) ?: "") to (it.getOrNull(1) ?: "") }
        val key = "host_cat_default:${code?.toString() ?: idCode}:${purpose ?: idPurpose}"
        val template = data?.text("templateId")
        if (item.deleted || template == null) meta.remove(key) else meta.put(key, template)
    }

    private suspend fun organization(item: ChangeItemDto) {
        val data = item.data ?: return
        config.get()?.let { config.upsert(it.copy(organizationName = data.text("name") ?: it.organizationName)) }
        val pallet = data.text("defaultPalletTemplateId")
        if (pallet == null) meta.remove(ORG_PALLET_TEMPLATE) else meta.put(ORG_PALLET_TEMPLATE, pallet)
    }

    /** The organization's pallet template and each category's, as the cloud's bootstrap delivered them (`org` and `category:<code>`). */
    private suspend fun rebuildPalletTemplates() {
        val rows = mutableListOf<PalletLabelTemplateEntity>()
        meta.get(ORG_PALLET_TEMPLATE)?.let { id -> meta.get("host_template:$id")?.let { rows += PalletLabelTemplateEntity(PalletLabelTemplateEntity.ORG, it) } }
        for (entry in db.metaDao().withPrefix("host_cat_default:")) {
            val (code, purpose) = entry.key.removePrefix("host_cat_default:").split(':').let { it[0] to it.getOrElse(1) { "" } }
            if (purpose != "pallet") continue
            val spec = meta.get("host_template:${entry.value}") ?: continue
            code.toIntOrNull()?.let { rows += PalletLabelTemplateEntity(PalletLabelTemplateEntity.category(it), spec) }
        }
        db.palletLabelTemplateDao().replaceAll(rows)
    }

    /** No flag «может строить паллеты» on the host's operators (decision В-5): every operator may. */
    private suspend fun rebuildPalletPermissions() {
        val operators = db.operatorDao().all().map { it.operatorId }.toSet()
        for (id in operators) db.palletPermissionDao().upsert(PalletPermissionEntity(id, true))
        for (stale in db.palletPermissionDao().all().map { it.employeeId } - operators) db.palletPermissionDao().delete(stale)
    }

    private companion object {
        const val ORG_PALLET_TEMPLATE = "host_org_pallet_template"

        fun lineKey(id: String) = "host_line:$id"
    }
}
