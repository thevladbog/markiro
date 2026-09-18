package app.markiro.handheld.core.network

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PalletDtosTest {
    private val strict = NetworkModule.strictJson()

    @Test
    fun aWarehouseClosureSpellsOutItsNullShiftAndItsKind() {
        val body = strict.encodeToString(
            SyncBatchRequest.serializer(),
            SyncBatchRequest(
                "b", emptyList(),
                pallets = listOf(PalletClosureDto("w1", null, "dev-1", "134600682000000017", "t", "op-1", kind = "warehouse", productId = "prod-1")),
                palletMemberships = listOf(PalletMembershipDto("w1", "034600682000000018", "t", null)),
            ),
        )
        val obj = strict.parseToJsonElement(body).jsonObject
        val pallet = obj.getValue("pallets").jsonArrayFirst()
        assertEquals("warehouse", pallet.getValue("kind").jsonPrimitive.content)
        assertEquals("null", pallet.getValue("shiftId").toString())
        assertEquals("prod-1", pallet.getValue("productId").jsonPrimitive.content)
        val membership = obj.getValue("palletMemberships").jsonArrayFirst()
        assertEquals("034600682000000018", membership.getValue("boxSscc").jsonPrimitive.content)
        assertEquals("null", membership.getValue("operatorId").toString())
    }

    @Test
    fun aProductionClosureStillCarriesItsShiftAndDefaultsItsKind() {
        val body = strict.encodeToString(PalletClosureDto.serializer(), PalletClosureDto("p1", "s1", "dev-1", "134600682000000017", "t", null))
        val obj = strict.parseToJsonElement(body).jsonObject
        assertEquals("production", obj.getValue("kind").jsonPrimitive.content)
        assertEquals("s1", obj.getValue("shiftId").jsonPrimitive.content)
    }

    @Test
    fun theBootstrapAndRegistryDtosReadTheServerShapes() {
        val bootstrap = NetworkModule.json().decodeFromString(
            PalletBootstrapDto.serializer(),
            """{"generatedAt":"t","products":[{"id":"p-1","gtin14":"04600682000013","name":"Cola","printName":null,"shelfLifeDays":180,"palletBoxCapacity":12,"chzProductGroupCode":8}],
               "operators":[{"employeeId":"op-1","canBuildPallets":true}],
               "palletSscc":{"issuerPrefix":"046006820","extensionDigit":1,"fromSerial":0,"toSerial":199,"consumedThroughSerial":null},
               "palletSsccRevokedFrom":[],"palletLabelTemplates":{"organisation":{"widthMm":100},"byCategory":[{"chzProductGroupCode":8,"template":{"widthMm":150}}]}}""",
        )
        assertEquals(12, bootstrap.products.single().palletBoxCapacity)
        assertEquals(1, bootstrap.palletSscc?.extensionDigit)
        assertEquals(8, bootstrap.palletLabelTemplates.byCategory.single().chzProductGroupCode)
        val item = NetworkModule.json().decodeFromString(
            BoxRegistryItemDto.serializer(),
            """{"kind":"upsert","boxId":"b","sscc":"034600682000000018","productId":"p-1","bottleCount":6,"contentKeys":[],"updatedAt":"t",
               "palletId":"pl","palletSscc":"134600682000000017","palletActive":true,"closedAt":"c","productionDate":"2026-09-10"}""",
        )
        assertEquals(true, item.palletActive)
        assertEquals("2026-09-10", item.productionDate)
        val legacy = NetworkModule.json().decodeFromString(BoxRegistryItemDto.serializer(), """{"kind":"remove","sscc":"034600682000000018","updatedAt":"t"}""")
        assertNull(legacy.palletActive)
    }

    private fun kotlinx.serialization.json.JsonElement.jsonArrayFirst() = (this as kotlinx.serialization.json.JsonArray).first().jsonObject
}
