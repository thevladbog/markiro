package app.markiro.handheld.core.sync

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Parity check for the batch-size literals `SyncEngine` hand-copies from
 * `@markiro/domain`'s `packages/domain/src/sync/limits.ts`, because Kotlin
 * cannot import a TypeScript constant. Reads the JSON
 * `pnpm --filter @markiro/domain fixtures:sync-limits` generates from those
 * constants and fails loudly the moment either side drifts: a regenerated but
 * uncommitted fixture (caught by the domain package's own
 * `test/sync-limits-fixtures.test.ts`) or a hand-edited Kotlin literal here.
 */
class SyncLimitsFixturesTest {
    private val fixtures: JsonObject = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource("sync-limits-fixtures.json")) {
            "run pnpm --filter @markiro/domain fixtures:sync-limits"
        }.readText(),
    ).jsonObject

    @Test
    fun kotlinLiteralsMatchTheDomainPackage() {
        assertEquals(
            fixtures.getValue("maxBoxClosuresPerSyncBatch").jsonPrimitive.int,
            SyncEngine.MAX_BOX_CLOSURES,
        )
        assertEquals(
            fixtures.getValue("maxPalletClosuresPerSyncBatch").jsonPrimitive.int,
            SyncEngine.MAX_PALLET_CLOSURES,
        )
        assertEquals(
            fixtures.getValue("maxSyncBatchIdChars").jsonPrimitive.int,
            SyncEngine.MAX_SYNC_BATCH_ID_CHARS,
        )
        // `syncBatchSchema.palletExceptions` is bounded by the PALLET CLOSURE
        // constant, not one of its own -- "a batch cannot carry exceptions
        // against more pallets than it could close" -- so the fixture needs no
        // new key and this asserts the Kotlin literal against the same number.
        assertEquals(
            fixtures.getValue("maxPalletClosuresPerSyncBatch").jsonPrimitive.int,
            SyncEngine.MAX_PALLET_EXCEPTIONS,
        )
    }
}
