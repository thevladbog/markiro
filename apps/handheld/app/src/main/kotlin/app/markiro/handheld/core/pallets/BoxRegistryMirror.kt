package app.markiro.handheld.core.pallets

import app.markiro.handheld.core.network.BoxRegistryItemDto
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.BoxRegistryEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.writeoff.KEYS
import app.markiro.handheld.core.writeoff.MirrorOutcome
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import java.io.IOException

/**
 * The closed-box registry, shared by the write-off mode (contents as `01…21…`
 * keys) and the pallet mode (pallet membership). Both bootstraps end in this
 * walk, so it lives on its own rather than inside either of them.
 *
 * The registry is a delta, not a snapshot: it is unbounded, so the device keeps
 * the revision it has fully applied and asks for changes since then.
 * `BOX_REGISTRY_UNTIL` is stored only after the final page. A crash mid-walk
 * therefore re-reads pages the device already has (upserts are idempotent)
 * rather than skipping the tail forever.
 */
class BoxRegistryMirror(
    private val api: StationApi,
    private val db: HandheldDatabase,
    private val meta: MetaStore,
) {
    /**
     * Reentrant on purpose: the two bootstrap mirrors already hold a recovery
     * lease when they call this, and a direct caller still gets the same
     * outcome mapping instead of a raw transport exception.
     */
    suspend fun walk(): MirrorOutcome = try {
        db.recovery.work { walkOwned() }
    } catch (_: IOException) {
        MirrorOutcome.Offline
    } catch (_: retrofit2.HttpException) {
        MirrorOutcome.Failed("http")
    } catch (_: SerializationException) {
        MirrorOutcome.Failed("shape")
    }

    private sealed interface Change {
        data class Put(val row: BoxRegistryEntity) : Change
        data class Drop(val sscc: String) : Change
    }

    private suspend fun walkOwned(): MirrorOutcome {
        val since = meta.get(MetaStore.BOX_REGISTRY_UNTIL)
        // Without a revision the device knows nothing: the answer is the whole
        // registry, so anything it still holds was removed while it was away.
        // The device's OWN claims are not the server's to remove, though: an
        // open local pallet would lose its boxes, so they are carried across
        // the clear and re-applied to whatever the snapshot still leaves
        // unassigned.
        val claims = if (since == null) {
            db.boxRegistryDao().claimed().mapNotNull { row -> row.localPalletId?.let { row.sscc to it } }
        } else {
            emptyList()
        }
        if (since == null) db.recovery.commit { db.boxRegistryDao().clear() }
        var cursor: String? = null
        var until: String? = null
        while (true) {
            val page = api.boxRegistry(since = since, until = until, cursor = cursor, limit = PAGE_SIZE)
            if (until == null) until = page.until else if (page.until != until) return MirrorOutcome.Failed("registry window")
            val changes = ArrayList<Change>(page.items.size)
            for (item in page.items) changes += change(item) ?: return MirrorOutcome.Failed("registry shape")
            db.recovery.commit {
                // Applied in the server's order: within one page the last word on an SSCC wins.
                for (c in changes) when (c) {
                    is Change.Put -> db.boxRegistryDao().upsert(c.row)
                    is Change.Drop -> db.boxRegistryDao().remove(c.sscc)
                }
            }
            cursor = page.nextCursor ?: break
        }
        val applied = until ?: return MirrorOutcome.Failed("registry window")
        db.recovery.commit {
            for ((sscc, localPalletId) in claims) {
                val row = db.boxRegistryDao().bySscc(sscc) ?: continue
                if (row.palletId == null) db.boxRegistryDao().claim(sscc, localPalletId)
            }
            meta.put(MetaStore.BOX_REGISTRY_UNTIL, applied)
        }
        return MirrorOutcome.Ok
    }

    private suspend fun change(item: BoxRegistryItemDto): Change? = when (item.kind) {
        "remove" -> Change.Drop(item.sscc)
        "upsert" -> row(item)?.let { Change.Put(it) }
        else -> null
    }

    private suspend fun row(item: BoxRegistryItemDto): BoxRegistryEntity? {
        val boxId = item.boxId ?: return null
        val productId = item.productId ?: return null
        val bottleCount = item.bottleCount ?: return null
        val contentKeys = item.contentKeys ?: return null
        val existing = db.boxRegistryDao().bySscc(item.sscc)
        // The device's own claim survives a refresh until the server has an answer
        // of its own (any palletId), at which point the claim is settled either way.
        val localPalletId = if (item.palletId != null) null else existing?.localPalletId
        return BoxRegistryEntity(
            sscc = item.sscc, boxId = boxId, productId = productId, bottleCount = bottleCount,
            contentKeysJson = Json.encodeToString(KEYS, contentKeys), updatedAt = item.updatedAt,
            palletId = item.palletId, palletSscc = item.palletSscc, palletActive = item.palletActive ?: false,
            closedAt = item.closedAt, productionDate = item.productionDate, localPalletId = localPalletId,
        )
    }

    private companion object {
        /** The server's own default; its ceiling is 500. */
        const val PAGE_SIZE = 250
    }
}
