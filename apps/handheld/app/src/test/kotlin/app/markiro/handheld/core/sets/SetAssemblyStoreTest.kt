package app.markiro.handheld.core.sets

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.host.HostAckMapper
import app.markiro.handheld.core.host.HostFactsFixtures
import app.markiro.handheld.core.network.SetItemDto
import app.markiro.handheld.core.network.host.FactReceiptDto
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class SetAssemblyStoreTest {
    @Test
    fun draftSurvivesRestartAndClosureQueuesOneExactHostRecord() = runBlocking {
        val fixture = HostFactsFixtures.fixture("fact-set-assembled.json")
        val id = fixture.getValue("id").jsonPrimitive.content
        val shiftId = fixture.getValue("shiftId").jsonPrimitive.content
        val data = fixture.getValue("data").jsonObject
        val setCode = data.getValue("setCode").jsonObject
        val rawSet = setCode.getValue("canonical").jsonPrimitive.content
        val rawItems = (data.getValue("items") as JsonArray).map { it.jsonObject.getValue("canonical").jsonPrimitive.content }
        val operator = HostFactsFixtures.OPERATOR
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val filename = "assembly-${UUID.randomUUID()}.db"
        fun open() = Room.databaseBuilder(context, HandheldDatabase::class.java, filename).allowMainThreadQueries().build()
        suspend fun withDb(block: suspend (HandheldDatabase) -> Unit) {
            val db = open()
            try {
                block(db)
            } finally {
                db.close()
            }
        }
        fun store(db: HandheldDatabase) =
            SetAssemblyStore(db, { data.getValue("assembledAt").jsonPrimitive.content }, { id })

        try {
            withDb { db ->
                db.deviceConfigDao().upsert(HostFactsFixtures.config(db).copy(activeShiftId = shiftId))
                db.initializeRecoveryForTest()
                db.shiftDao().upsert(HostFactsFixtures.shift(shiftId).copy(
                    mode = "validation",
                    palletsEnabled = false,
                    productGtin14 = setCode.getValue("gtin14").jsonPrimitive.content,
                    setItemsJson = Json.encodeToString(listOf(SetItemDto("04607123456804", "Cream", 2))),
                ))
                assertEquals(SetScanStatus.ITEM_ADDED, store(db).scan(shiftId, rawItems.first(), operator)?.status)
                assertEquals(SetScanStatus.INCOMPLETE, store(db).scan(shiftId, rawSet, operator)?.status)
                assertEquals(0, db.hostOutboxDao().queuedCount())
            }
            withDb { db ->
                db.initializeRecoveryForTest()
                val store = store(db)
                assertEquals(listOf(rawItems.first()), store.observeDraft(shiftId).first())
                assertEquals(SetScanStatus.ITEM_ADDED, store.scan(shiftId, rawItems.last(), operator)?.status)
                assertEquals(SetScanStatus.CLOSED, store.scan(shiftId, rawSet, operator)?.status)
                assertEquals(emptyList<String>(), store.observeDraft(shiftId).first())
                val row = db.hostOutboxDao().queued(2).single()
                val expected = JsonObject(fixture + ("operatorId" to JsonPrimitive(operator)))
                assertEquals(expected, Json.parseToJsonElement(row.body))
                assertEquals(1, db.setAssemblyDao().observeCounts(shiftId).first().queued)
                assertEquals(SetScanStatus.DUPLICATE, store.scan(shiftId, rawItems.first(), operator)?.status)

                HostAckMapper(db).apply(listOf(row), listOf(FactReceiptDto(id, "conflict", "device_duplicate")))
                assertEquals(0, db.setAssemblyDao().countFinished(shiftId))
                assertEquals(1, db.setAssemblyDao().observeCounts(shiftId).first().conflicts)
                assertEquals("device_duplicate", db.hostOutboxDao().quarantined().single().reason)
                assertNull(db.metaDao().get(SetAssemblyStore.draftKey(shiftId)))
            }
        } finally {
            context.deleteDatabase(filename)
        }
    }
}
