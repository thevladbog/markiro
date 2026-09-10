package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.storage.InventoryEventEntity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InventoryBatchCodecTest {
    private val fixtures = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource("inventory-fixtures.json")).readText(),
    ).jsonObject

    @Test
    fun batchDigestsMatchTheDomainPackage() {
        val cases = fixtures.getValue("batchDigest").jsonArray
        assertTrue(cases.size >= 3)
        for (case in cases) {
            val o = case.jsonObject
            val payload = o.getValue("payload").jsonObject
            val snapshotId = payload.getValue("snapshotId").jsonPrimitive.content
            val events = payload.getValue("events").jsonArray.map { e ->
                val ev = e.jsonObject
                fun s(k: String) = ev.getValue(k).jsonPrimitive.content
                fun n(k: String) = ev[k]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
                InventoryBatchCodec.eventJson(
                    InventoryEventEntity(
                        eventId = s("eventId"), inventoryId = "i", snapshotId = snapshotId,
                        deviceSequence = ev.getValue("deviceSequence").jsonPrimitive.long, operatorId = s("operatorId"), scannedAt = s("scannedAt"),
                        kind = s("kind"), normalizedIdentity = s("normalizedIdentity"), codeHash = n("codeHash"), canonicalRaw = n("canonicalRaw"),
                        activeProductionDate = s("activeProductionDate"), localVerdict = s("localVerdict"), claimedCount = 0,
                        winnerEventId = null, winnerDeviceId = null, winnerScannedAt = null, serverStatus = null,
                    ),
                )
            }
            val json = InventoryBatchCodec.payloadJson(
                snapshotId = snapshotId,
                sequenceCeiling = payload.getValue("sequenceCeiling").jsonPrimitive.long,
                pendingEventCount = payload.getValue("pendingEventCount").jsonPrimitive.content.toInt(),
                events = events,
            )
            assertEquals(o.getValue("name").jsonPrimitive.content, o.getValue("digest").jsonPrimitive.content, InventoryBatchCodec.digest(json))
        }
    }

    @Test
    fun requestWrapsThePayloadWithBatchIdAndDigest() {
        val payload = InventoryBatchCodec.payloadJson("s", 1, 0, listOf("""{"eventId":"e"}"""))
        assertEquals(
            """{"batchId":"b","payloadDigest":"d","snapshotId":"s","snapshotRevision":1,"sequenceCeiling":1,"pendingEventCount":0,"openBoxCount":0,"events":[{"eventId":"e"}]}""",
            InventoryBatchCodec.requestJson("b", "d", payload),
        )
    }
}
