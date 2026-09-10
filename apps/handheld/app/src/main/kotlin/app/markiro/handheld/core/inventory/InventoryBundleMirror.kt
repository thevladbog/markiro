package app.markiro.handheld.core.inventory

import androidx.room.withTransaction
import app.markiro.handheld.core.network.InventoryBundleCodeDto
import app.markiro.handheld.core.network.InventoryBundlePageDto
import app.markiro.handheld.core.network.InventoryManifestDto
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventorySnapshotCodeEntity
import app.markiro.handheld.core.storage.InventoryTaskEntity

sealed interface MirrorResult {
    data object Active : MirrorResult
    data object Repack : MirrorResult
    data class Invalid(val reason: String) : MirrorResult
}

/**
 * Port of apps/station/src/lib/inventory-bundle.ts without the lease layer: pages are verified by
 * digest and staged, the snapshot is published in one transaction after the content digest
 * recomputes, a restart resumes from the staged cursor. Network failures propagate (IOException /
 * HttpException) so the screen can retry.
 */
class InventoryBundleMirror(
    private val db: HandheldDatabase,
    private val api: StationApi,
    private val pageSize: Int = PAGE_SIZE,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    suspend fun mirror(manifest: InventoryManifestDto, onProgress: suspend (staged: Int, total: Int) -> Unit): MirrorResult {
        if (manifest.mode == "repack") return MirrorResult.Repack
        if (manifest.snapshotRevision != 1 || manifest.productionDateFrom > manifest.productionDateTo || manifest.mode != "check") {
            return MirrorResult.Invalid("manifest")
        }
        val id = manifest.inventoryId
        val existing = db.inventoryTaskDao().get(id)
        if (existing != null && existing.snapshotId == manifest.snapshotId && existing.state == "active" &&
            existing.contentDigest == manifest.contentDigest
        ) {
            db.inventoryTaskDao().setJoinedAt(id, clock())
            return MirrorResult.Active
        }
        var task = existing
        if (task == null || task.snapshotId != manifest.snapshotId || task.contentDigest != manifest.contentDigest || task.state != "staging") {
            task = db.withTransaction {
                existing?.let { old ->
                    db.inventorySnapshotCodeDao().deleteSnapshot(old.snapshotId)
                    if (old.snapshotId != manifest.snapshotId) {
                        // The cabinet re-snapshotted: everything scoped to the old snapshot is moot.
                        db.inventoryEventDao().deleteForInventory(id)
                        db.inventoryResultDao().deleteForInventory(id)
                        db.inventoryOutboxDao().deleteForInventory(id)
                        db.inventoryTerminalStateDao().delete(id)
                    }
                }
                val fresh = manifest.toEntity()
                db.inventoryTaskDao().upsert(fresh)
                fresh
            }
        }
        var cursor = task.stagingCursor
        var staged = task.stagedCount
        while (true) {
            val page = api.inventoryCodes(id, cursor, pageSize)
            val problem = verifyPage(manifest, cursor, page)
            if (problem != null) return discard(manifest, problem)
            val rows = page.items.map { it.toEntity(manifest.snapshotId) }
            staged += rows.size
            val next = page.nextCursor
            db.withTransaction {
                db.inventorySnapshotCodeDao().insertAll(rows)
                db.inventoryTaskDao().setStaging(id, next ?: cursor, staged)
            }
            onProgress(staged, manifest.codeCount)
            if (next == null) break
            cursor = next
        }
        return publish(manifest)
    }

    private fun verifyPage(manifest: InventoryManifestDto, cursor: String?, page: InventoryBundlePageDto): String? {
        if (page.snapshotId != manifest.snapshotId || page.snapshotRevision != 1 || page.snapshotFixedAt != manifest.snapshotFixedAt ||
            page.contentDigest != manifest.contentDigest || page.combinedDigest != manifest.combinedDigest || page.cursor != cursor ||
            page.items.size > pageSize
        ) {
            return "page shape"
        }
        var previous = cursor ?: ""
        for (item in page.items) {
            if (item.codeHash <= previous) return "page order"
            previous = item.codeHash
            if (!flagsMatch(item, manifest)) return "row flags"
        }
        if (page.nextCursor != null && page.nextCursor != previous) return "page cursor"
        val digest = InventoryDigests.pageDigest(manifest.snapshotId, manifest.snapshotFixedAt, manifest.contentDigest, cursor, page.items, page.nextCursor)
        if (digest != page.pageDigest) return "page digest"
        return null
    }

    /** Port of `classifyInventorySnapshotRow`: the flags the server sent must agree with its own rules. */
    private fun flagsMatch(item: InventoryBundleCodeDto, manifest: InventoryManifestDto): Boolean {
        if (item.gtin14 != manifest.gtin14) return false
        val date = item.sourceProductionDate
        val protected = item.sourceState == "MOVING_BY_UD"
        val expected = !protected && item.sourceStatus == "INTRODUCED" && date != null &&
            date >= manifest.productionDateFrom && date <= manifest.productionDateTo
        return item.protected == protected && item.expected == expected
    }

    private suspend fun discard(manifest: InventoryManifestDto, reason: String): MirrorResult {
        db.withTransaction {
            db.inventorySnapshotCodeDao().deleteSnapshot(manifest.snapshotId)
            db.inventoryTaskDao().setStaging(manifest.inventoryId, null, 0)
        }
        return MirrorResult.Invalid(reason)
    }

    private suspend fun publish(manifest: InventoryManifestDto): MirrorResult {
        val digest = ContentDigest()
        var after = ""
        var count = 0
        while (true) {
            val rows = db.inventorySnapshotCodeDao().pageAfter(manifest.snapshotId, after, DIGEST_PAGE)
            if (rows.isEmpty()) break
            rows.forEach { digest.add(InventoryDigests.itemJson(it)) }
            count += rows.size
            after = rows.last().codeHash
        }
        if (count != manifest.codeCount || digest.finish() != manifest.contentDigest) return discard(manifest, "content digest")
        val expectedCount = db.inventorySnapshotCodeDao().countExpected(manifest.snapshotId)
        db.inventoryTaskDao().activate(manifest.inventoryId, expectedCount, clock())
        return MirrorResult.Active
    }

    private fun InventoryManifestDto.toEntity() = InventoryTaskEntity(
        inventoryId = inventoryId, inventoryNumber = inventoryNumber, productId = productId, productName = productName,
        productPrintName = productPrintName, gtin14 = gtin14, mode = mode, lineId = lineId, lineName = lineName,
        productionDateFrom = productionDateFrom, productionDateTo = productionDateTo, boxCapacity = boxCapacity, snapshotId = snapshotId,
        snapshotFixedAt = snapshotFixedAt, contentDigest = contentDigest, combinedDigest = combinedDigest, codeCount = codeCount,
        expectedCount = 0, state = "staging", stagingCursor = null, stagedCount = 0, joinedAt = null, leftAt = null,
    )

    private fun InventoryBundleCodeDto.toEntity(snapshotId: String) = InventorySnapshotCodeEntity(
        snapshotId, codeHash, canonicalRaw, gtin14, serial, sourceStatus, sourceState, sourceProductionDate, parentSscc, expected, protected,
    )

    companion object {
        const val PAGE_SIZE = 200
        private const val DIGEST_PAGE = 500
    }
}
