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

/**
 * Parity with `apps/api/src/modules/station-writeoffs/dto.ts` and the box
 * registry's `KioskBoxRegistryChange`. A server field rename must break here,
 * in a test, rather than on a device that has already queued documents.
 */
class WriteoffDtosTest {
    private fun api(server: MockWebServer): StationApi = Retrofit.Builder().baseUrl(server.url("/")).client(OkHttpClient())
        .addConverterFactory(NetworkModule.json().asConverterFactory("application/json".toMediaType()))
        .build().create(StationApi::class.java)

    @Test
    fun bootstrapDecodesReasonsProductsWithIdAndOperators() = runTest {
        val server = MockWebServer().also { it.start() }
        server.enqueue(
            MockResponse().setBody(
                """{"generatedAt":"2026-09-14T10:42:00.000Z",
                "reasons":[{"id":"r-1","name":"Бой","sortOrder":0},{"id":"r-2","name":"Просрочка","sortOrder":1}],
                "products":[{"id":"p-1","gtin14":"04600682000013","name":"Вода 0,5 л"}],
                "operators":[{"employeeId":"op-1","canWriteoff":true},{"employeeId":"op-2","canWriteoff":false}]}""",
            ),
        )
        val bootstrap = api(server).writeoffBootstrap()
        assertEquals("2026-09-14T10:42:00.000Z", bootstrap.generatedAt)
        assertEquals(listOf("Бой", "Просрочка"), bootstrap.reasons.map { it.name })
        assertEquals("p-1", bootstrap.products.single().id)
        assertEquals("04600682000013", bootstrap.products.single().gtin14)
        assertTrue(bootstrap.operators.first { it.employeeId == "op-1" }.canWriteoff)
        assertEquals("/station/writeoff-bootstrap", server.takeRequest().path)
        server.shutdown()
    }

    @Test
    fun registryPageDecodesUpsertAndRemoveAndOmitsNullQueries() = runTest {
        val server = MockWebServer().also { it.start() }
        server.enqueue(
            MockResponse().setBody(
                """{"until":"9","items":[
                {"kind":"upsert","boxId":"b-1","sscc":"046000000000000025","productId":"p-1","bottleCount":12,"contentKeys":["01046000000000002521A"],"updatedAt":"t"},
                {"kind":"remove","sscc":"046000000000000018","updatedAt":"t"}]}""",
            ),
        )
        val page = api(server).boxRegistry(since = "7", until = null, cursor = null, limit = 250)
        assertEquals("9", page.until)
        assertNull(page.nextCursor)
        val upsert = page.items[0]
        assertEquals("upsert", upsert.kind)
        assertEquals(12, upsert.bottleCount)
        assertEquals(listOf("01046000000000002521A"), upsert.contentKeys)
        val remove = page.items[1]
        assertEquals("remove", remove.kind)
        assertNull(remove.boxId)
        assertNull(remove.contentKeys)
        // Null query parameters are omitted, not sent as "null": the server rejects an `until` on the first page.
        assertEquals("/station/box-registry?since=7&limit=250", server.takeRequest().path)
        server.shutdown()
    }

    @Test
    fun resultDecodesWithNullableBoxConflictCount() {
        val result = NetworkModule.json().decodeFromString(
            WriteoffResultDto.serializer(),
            """{"orderNo":"ORD-26-0417","status":"pending","itemCount":1,
            "conflicts":[{"rawKm":"dup","reason":"duplicate"}],
            "boxConflicts":[{"sscc":"046000000000000018","bottleCount":null,"reason":"unknown_box"}],
            "acceptedBoxes":[{"sscc":"046000000000000025","bottleCount":12}]}""",
        )
        assertEquals("ORD-26-0417", result.orderNo)
        assertEquals(1, result.itemCount)
        assertEquals("duplicate", result.conflicts.single().reason)
        assertNull(result.boxConflicts.single().bottleCount)
        assertEquals(12, result.acceptedBoxes.single().bottleCount)
    }
}
