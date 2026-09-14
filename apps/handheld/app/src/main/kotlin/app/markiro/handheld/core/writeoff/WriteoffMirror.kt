package app.markiro.handheld.core.writeoff

import app.markiro.handheld.core.network.BoxRegistryItemDto
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.WriteoffBoxEntity
import app.markiro.handheld.core.storage.WriteoffPermissionEntity
import app.markiro.handheld.core.storage.WriteoffProductEntity
import app.markiro.handheld.core.storage.WriteoffReasonEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.io.IOException

sealed interface MirrorOutcome {
    data object Ok : MirrorOutcome
    /** The server was unreachable. Every cache keeps the values it already held. */
    data object Offline : MirrorOutcome
    data class Failed(val reason: String) : MirrorOutcome
}

/** The box contents the registry listed, as `01…21…` keys. */
fun WriteoffBoxEntity.contentKeys(): List<String> =
    runCatching { Json.decodeFromString(KEYS, contentKeysJson) }.getOrDefault(emptyList())

private val KEYS = ListSerializer(String.serializer())

/**
 * Fills the write-off mode's offline caches: the shared reason dictionary, the
 * tenant catalogue, per-operator permission, and the closed-box registry.
 *
 * The three bootstrap caches are replaced wholesale, because the server's answer
 * IS the current dictionary — an archived reason must disappear from the device,
 * not linger. The box registry is a delta instead: it is unbounded, so the device
 * keeps the revision it has fully applied and asks for changes since then.
 *
 * `WRITEOFF_REGISTRY_UNTIL` is stored only after the final page. A crash mid-walk
 * therefore re-reads pages the device already has (upserts are idempotent) rather
 * than skipping the tail forever.
 */
class WriteoffMirror(
    private val api: StationApi,
    private val db: HandheldDatabase,
    private val meta: MetaStore,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** When the bootstrap last landed, feeding the mode's «данные на 10:42» stamp. */
    val stampAt: Flow<Long?> = db.metaDao().observe(MetaStore.WRITEOFF_BOOTSTRAP_AT).map { it?.toLongOrNull() }

    suspend fun refresh(): MirrorOutcome = try {
        db.recovery.work { refreshOwned() }
    } catch (_: IOException) {
        MirrorOutcome.Offline
    } catch (_: retrofit2.HttpException) {
        MirrorOutcome.Failed("http")
    } catch (_: SerializationException) {
        MirrorOutcome.Failed("shape")
    }

    private suspend fun refreshOwned(): MirrorOutcome {
        val bootstrap = api.writeoffBootstrap()
        db.recovery.commit {
            db.writeoffReasonDao().replaceAll(bootstrap.reasons.map { WriteoffReasonEntity(it.id, it.name, it.sortOrder) })
            db.writeoffProductDao().replaceAll(bootstrap.products.map { WriteoffProductEntity(it.gtin14, it.id, it.name) })
            db.writeoffPermissionDao().replaceAll(bootstrap.operators.map { WriteoffPermissionEntity(it.employeeId, it.canWriteoff) })
            meta.put(MetaStore.WRITEOFF_BOOTSTRAP_AT, clock().toString())
        }
        return walkRegistry()
    }

    private sealed interface Change {
        data class Put(val row: WriteoffBoxEntity) : Change
        data class Drop(val sscc: String) : Change
    }

    private suspend fun walkRegistry(): MirrorOutcome {
        val since = meta.get(MetaStore.WRITEOFF_REGISTRY_UNTIL)
        // Without a revision the device knows nothing: the answer is the whole
        // registry, so anything it still holds was removed while it was away.
        if (since == null) db.recovery.commit { db.writeoffBoxDao().clear() }
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
                    is Change.Put -> db.writeoffBoxDao().upsert(c.row)
                    is Change.Drop -> db.writeoffBoxDao().remove(c.sscc)
                }
            }
            cursor = page.nextCursor ?: break
        }
        val applied = until ?: return MirrorOutcome.Failed("registry window")
        db.recovery.commit { meta.put(MetaStore.WRITEOFF_REGISTRY_UNTIL, applied) }
        return MirrorOutcome.Ok
    }

    private fun change(item: BoxRegistryItemDto): Change? = when (item.kind) {
        "remove" -> Change.Drop(item.sscc)
        "upsert" -> {
            val boxId = item.boxId
            val productId = item.productId
            val bottleCount = item.bottleCount
            val contentKeys = item.contentKeys
            if (boxId == null || productId == null || bottleCount == null || contentKeys == null) {
                null
            } else {
                Change.Put(
                    WriteoffBoxEntity(
                        sscc = item.sscc, boxId = boxId, productId = productId, bottleCount = bottleCount,
                        contentKeysJson = Json.encodeToString(KEYS, contentKeys), updatedAt = item.updatedAt,
                    ),
                )
            }
        }
        else -> null
    }

    private companion object {
        /** The server's own default; its ceiling is 500. */
        const val PAGE_SIZE = 250
    }
}
