package app.markiro.handheld.core.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DtosTest {
    private val lenient = NetworkModule.json()
    private val strict = NetworkModule.strictJson()

    @Test
    fun shiftDtoDecodesTheCabinetPayloadAndIgnoresUnknownFields() {
        val json = """
            {"id":"6d8a1186-37ba-4f17-ad31-fa4582df28d5","number":"SEP26-003","status":"active","mode":"validation",
             "validationPrint":{"mode":"none","verification":"none","templateId":null,"snapshot":null,"policyRevision":null},
             "productId":"p1","productName":"Вода 0,5","productPrintName":null,"image":null,"lineId":"l2","lineName":"Линия 2",
             "counterpartyId":null,"counterpartyName":"Завод X","ssccIssuerCounterpartyId":null,"boxLabelTemplateId":null,
             "plannedQty":3000,"plannedDate":"2026-09-10","productionDate":null,"boxCapacity":20,"palletBoxCapacity":null,
             "palletsEnabled":false,"createdFrom":"admin","openedAt":"2026-09-10T07:00:00.000Z","closedAt":null,"closeReason":null,
             "lateDataAt":null,"createdAt":"2026-09-10T06:00:00.000Z","stationCloseAccess":{"kind":"single_device","ownerDeviceId":"dev-1"}}
        """.trimIndent()
        val shift = lenient.decodeFromString(ShiftDto.serializer(), json)
        assertEquals("SEP26-003", shift.number)
        assertEquals("none", shift.validationPrint?.mode)
        assertEquals(3000, shift.plannedQty)
        assertEquals("single_device", shift.stationCloseAccess?.kind)
        assertEquals("dev-1", shift.stationCloseAccess?.ownerDeviceId)
    }

    @Test
    fun scanItemsEncodeExplicitNullsSoTheServerSchemaAccepts() {
        val item = ScanItemDto(
            shiftId = "s1", terminalId = "dev-1", raw = "hello", verdict = "invalid",
            scannedAt = "2026-09-10T10:00:00.000Z", code = null, operatorId = null,
        )
        val encoded = strict.encodeToString(ScanItemDto.serializer(), item)
        assertTrue(encoded, encoded.contains("\"code\":null"))
        assertTrue(encoded, encoded.contains("\"boxId\":null"))
        assertTrue(encoded, encoded.contains("\"operatorId\":null"))
        assertTrue(encoded, encoded.contains("\"terminalId\":\"dev-1\""))
    }

    @Test
    fun batchEncodingIsStableAcrossCalls() {
        val batch = SyncBatchRequest("dev:inst:3", listOf(ScanItemDto("s1", "dev-1", "r", "invalid", "t", null, null)))
        assertEquals(
            strict.encodeToString(SyncBatchRequest.serializer(), batch),
            strict.encodeToString(SyncBatchRequest.serializer(), batch),
        )
    }

    @Test
    fun summaryOutputDecodesBothModes() {
        val validation = lenient.decodeFromString(
            ShiftSummaryDto.serializer(),
            """{"generatedAt":"t","output":{"mode":"validation","acceptedUnits":12},"participants":[],"unattributed":{"eventCount":0,"acceptedScans":0,"closedBoxes":0}}""",
        )
        assertEquals(12, validation.output.acceptedUnits)
        assertNull(validation.output.closedBoxes)
        val aggregation = lenient.decodeFromString(
            ShiftSummaryDto.serializer(),
            """{"generatedAt":"t","output":{"mode":"aggregation","closedBoxes":3,"containedUnits":60},"participants":[]}""",
        )
        assertEquals(3, aggregation.output.closedBoxes)
    }
}
