package app.markiro.handheld.core.grants

import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Test

class GrantEventCostsTest {
    @Test fun producerBudgetDimensionsMatchOwnerCostsForEveryProtocolEvent() {
        val fixture = Json.parseToJsonElement(checkNotNull(javaClass.classLoader?.getResourceAsStream("offline-grant-budgets-v1.json")).bufferedReader().use { it.readText() }).jsonObject
        val events=fixture.getValue("events").jsonArray
        assertEquals(GrantEventType.entries.size,events.size)
        events.forEach { item ->
            val row=item.jsonObject; val event=GrantEventType.entries.single { it.wire == row.getValue("event").jsonPrimitive.content }
            val expected=row.getValue("cost").jsonObject.mapValues { it.value.jsonPrimitive.long }
            val actual=grantEventCosts(event,units=2,containers=1)
            assertEquals(event.wire,expected,actual)
            assertEquals(actual.keys,row.getValue("budget").jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.content }.toSet())
        }
    }
}
