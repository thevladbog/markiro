package app.markiro.handheld.core.inventory

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.BundleLimitsDto
import app.markiro.handheld.core.network.InventoryBundleCodeDto
import app.markiro.handheld.core.network.InventoryManifestDto
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

@RunWith(AndroidJUnit4::class)
class InventoryBundleMirrorTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private lateinit var api: StationApi
    private val snapshotId = "22222222-2222-4222-8222-222222222222"
    private val fixedAt = "2026-08-25T01:02:03.000Z"

    private fun code(n: Int, parent: String? = null, expected: Boolean = true, date: String? = "2026-08-10") = InventoryBundleCodeDto(
        codeHash = n.toString(16).padStart(64, '0'), canonicalRaw = "010460000000001521S$n", gtin14 = "04600000000015", serial = "S$n",
        sourceStatus = if (expected) "INTRODUCED" else "RETIRED", sourceState = null, sourceProductionDate = date, parentSscc = parent,
        expected = expected, protected = false,
    )

    private val items = listOf(code(1), code(2, parent = "346006820000000014"), code(3, expected = false))
    private val contentDigest = ContentDigest().also { d -> items.forEach { d.add(InventoryDigests.itemJson(it)) } }.finish()

    private fun manifest(mode: String = "check", digest: String = contentDigest) = InventoryManifestDto(
        inventoryId = "i1", inventoryNumber = "INV-1", snapshotId = snapshotId, snapshotRevision = 1, snapshotFixedAt = fixedAt,
        combinedDigest = "a".repeat(64), contentDigest = digest, codeCount = items.size, productId = "p1", productName = "Вода", productPrintName = null,
        gtin14 = "04600000000015", boxCapacity = 12, mode = mode, lineId = "l1", lineName = "Линия 2", productionDateFrom = "2026-08-01",
        productionDateTo = "2026-08-31", limits = BundleLimitsDto(200, 100, 200),
    )

    private fun pageJson(cursor: String?, page: List<InventoryBundleCodeDto>, next: String?, digest: String? = null, content: String = contentDigest): String {
        val pageDigest = digest ?: InventoryDigests.pageDigest(snapshotId, fixedAt, content, cursor, page, next)
        val itemsJson = page.joinToString(",") { InventoryDigests.itemJson(it) }
        return """{"snapshotId":"$snapshotId","snapshotRevision":1,"snapshotFixedAt":"$fixedAt","combinedDigest":"${"a".repeat(64)}",""" +
            """"contentDigest":"$content","cursor":${cursor?.let { "\"$it\"" } ?: "null"},"items":[$itemsJson],""" +
            """"nextCursor":${next?.let { "\"$it\"" } ?: "null"},"pageDigest":"$pageDigest"}"""
    }

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        server = MockWebServer().also { it.start() }
        api = Retrofit.Builder().baseUrl(server.url("/")).client(OkHttpClient())
            .addConverterFactory(NetworkModule.json().asConverterFactory("application/json".toMediaType())).build().create(StationApi::class.java)
    }

    @After
    fun tearDown() {
        server.shutdown()
        db.close()
    }

    private fun mirror(pageSize: Int = 2) = InventoryBundleMirror(db, api, pageSize) { 1L }

    @Test
    fun downloadsPagesVerifiesDigestsAndActivates() = runTest {
        server.enqueue(MockResponse().setBody(pageJson(null, items.take(2), items[1].codeHash)))
        server.enqueue(MockResponse().setBody(pageJson(items[1].codeHash, items.drop(2), null)))
        val progress = mutableListOf<Int>()
        assertEquals(MirrorResult.Active, mirror().mirror(manifest()) { staged, _ -> progress += staged })
        assertEquals(listOf(2, 3), progress)
        assertEquals("/station/inventories/i1/bundle/codes?limit=2", server.takeRequest().path)
        assertEquals("/station/inventories/i1/bundle/codes?cursor=${items[1].codeHash}&limit=2", server.takeRequest().path)
        val task = db.inventoryTaskDao().get("i1")
        assertEquals("active", task?.state)
        assertEquals(2, task?.expectedCount)
        assertEquals(3, db.inventorySnapshotCodeDao().count(snapshotId))
    }

    @Test
    fun resumesFromTheStagedCursorAndSkipsAnActiveSnapshot() = runTest {
        server.enqueue(MockResponse().setBody(pageJson(null, items.take(2), items[1].codeHash)))
        server.enqueue(MockResponse().setResponseCode(500))
        assertTrue(runCatching { mirror().mirror(manifest()) { _, _ -> } }.isFailure)
        assertEquals(items[1].codeHash, db.inventoryTaskDao().get("i1")?.stagingCursor)
        server.enqueue(MockResponse().setBody(pageJson(items[1].codeHash, items.drop(2), null)))
        assertEquals(MirrorResult.Active, mirror().mirror(manifest()) { _, _ -> })
        assertEquals(3, server.requestCount)
        assertEquals(MirrorResult.Active, mirror().mirror(manifest()) { _, _ -> })
        assertEquals(3, server.requestCount)
    }

    @Test
    fun aBadPageDigestOrContentDigestNeverActivates() = runTest {
        server.enqueue(MockResponse().setBody(pageJson(null, items, null, digest = "f".repeat(64))))
        assertEquals(MirrorResult.Invalid("page digest"), mirror(pageSize = 3).mirror(manifest()) { _, _ -> })
        val wrong = "e".repeat(64)
        server.enqueue(MockResponse().setBody(pageJson(null, items, null, content = wrong)))
        assertEquals(MirrorResult.Invalid("content digest"), mirror(pageSize = 3).mirror(manifest(digest = wrong)) { _, _ -> })
        assertEquals(0, db.inventorySnapshotCodeDao().count(snapshotId))
        assertEquals("staging", db.inventoryTaskDao().get("i1")?.state)
    }

    @Test
    fun repackIsRefusedBeforeAnyDownload() = runTest {
        assertEquals(MirrorResult.Repack, mirror().mirror(manifest(mode = "repack")) { _, _ -> })
        assertEquals(0, server.requestCount)
    }
}
