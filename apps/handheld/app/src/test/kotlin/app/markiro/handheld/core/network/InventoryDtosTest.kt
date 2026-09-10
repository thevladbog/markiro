package app.markiro.handheld.core.network

import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

class InventoryDtosTest {
    private val id = "11111111-1111-4111-8111-111111111111"
    private val manifestJson = """{"inventoryId":"$id","inventoryNumber":"INV-1",
        "snapshotId":"22222222-2222-4222-8222-222222222222","snapshotRevision":1,"snapshotFixedAt":"2026-08-25T01:02:03.000Z",
        "combinedDigest":"${"a".repeat(64)}","contentDigest":"${"b".repeat(64)}","codeCount":1,
        "productId":"33333333-3333-4333-8333-333333333333","productName":"Сидр","productPrintName":"Сидр сухой","egaisCode":null,
        "shelfLifeDays":184,"gtin14":"04600000000015","boxCapacity":12,"mode":"check","lineId":"44444444-4444-4444-8444-444444444444",
        "lineName":"Линия 1","productionDateFrom":"2026-08-01","productionDateTo":"2026-08-31","boxLabelTemplate":null,
        "limits":{"codePageSize":200,"eventBatchSize":100,"progressPageSize":200},"sscc":null,"ssccRevokedFrom":[],"ssccRevokedBlocks":[]}"""

    @Test
    fun manifestAndPageDecodeWithRepackFieldsIgnored() = runTest {
        val server = MockWebServer().also { it.start() }
        val api = Retrofit.Builder().baseUrl(server.url("/")).client(OkHttpClient())
            .addConverterFactory(NetworkModule.json().asConverterFactory("application/json".toMediaType()))
            .build().create(StationApi::class.java)
        server.enqueue(MockResponse().setBody(manifestJson))
        val manifest = api.inventoryManifest(id)
        assertEquals("check", manifest.mode)
        assertEquals(200, manifest.limits.codePageSize)
        assertEquals("2026-08-01", manifest.productionDateFrom)
        assertEquals("/station/inventories/$id/bundle/manifest", server.takeRequest().path)
        server.enqueue(
            MockResponse().setBody(
                """{"snapshotId":"22222222-2222-4222-8222-222222222222","snapshotRevision":1,"snapshotFixedAt":"2026-08-25T01:02:03.000Z",
                "combinedDigest":"${"a".repeat(64)}","contentDigest":"${"b".repeat(64)}","cursor":null,"items":[{"codeHash":"${"c".repeat(64)}",
                "canonicalRaw":"010460000000001521S","gtin14":"04600000000015","serial":"S","sourceStatus":"INTRODUCED","sourceState":null,
                "sourceProductionDate":"2026-08-01","parentSscc":null,"expected":true,"protected":false}],"nextCursor":null,"pageDigest":"${"d".repeat(64)}"}""",
            ),
        )
        val page = api.inventoryCodes(id, null, 200)
        assertEquals(1, page.items.size)
        assertNull(page.nextCursor)
        assertEquals("/station/inventories/$id/bundle/codes?limit=200", server.takeRequest().path)
        server.shutdown()
    }

    @Test
    fun joinRequestOmitsAbsentOptionalFields() {
        val json = NetworkModule.json()
        assertEquals("""{"operatorId":"op"}""", json.encodeToString(JoinInventoryRequest.serializer(), JoinInventoryRequest("op")))
        assertEquals(
            """{"operatorId":"op","confirmDifferentLine":true}""",
            json.encodeToString(JoinInventoryRequest.serializer(), JoinInventoryRequest("op", confirmDifferentLine = true)),
        )
    }

    @Test
    fun taskListRequiresTheLineFields() {
        val json = NetworkModule.json()
        val ok = json.decodeFromString(
            InventoryTaskListResponse.serializer(),
            """{"items":[{"inventoryId":"i","inventoryNumber":"INV-1","productName":"P","productPrintName":null,"mode":"check",
               "lineId":"l","lineName":"L","productionDateFrom":"2026-08-01","productionDateTo":"2026-08-31"}]}""",
        )
        assertEquals("L", ok.items.single().lineName)
        val failed = runCatching {
            json.decodeFromString(InventoryTaskListResponse.serializer(), """{"items":[{"inventoryId":"i","inventoryNumber":"INV-1","productName":"P"}]}""")
        }
        assertTrue(failed.isFailure)
    }
}
