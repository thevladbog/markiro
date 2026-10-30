package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HostPackApiTest {
    @Test fun readsSharedFixtureAndResendsTheFrozenApplyBytes() = runTest {
        val requests=mutableListOf<Pair<String,String>>()
        val transport=object:HostTransport {
            override suspend fun get(path:String):HostResult=error("unexpected GET")
            override suspend fun post(path:String,body:String):HostResult {
                requests+=path to body
                return HostResult.Ok(200,HostFactsFixtures.fixture(if(path.endsWith("lookup")) "device-pack-inspection.json" else "device-pack-disassembled.json").toString(),null)
            }
        }
        val api=HostApi(transport)
        val card=api.packInspection("146012345600000006","22222222-2222-4222-8222-222222222222").getOrThrow()
        assertEquals("pallet",card.kind);assertEquals(24L,card.units);assertEquals(2,card.boxes)
        val frozen=HostFactsFixtures.fixture("device-pack-disassemble.json").toString()
        assertEquals("DSG-26-0001",api.disassemblePack(frozen).getOrThrow().docNo)
        api.disassemblePack(frozen).getOrThrow()
        assertEquals(requests[1],requests[2]);assertEquals(frozen,requests[1].second)
        assertTrue(requests.first().second.contains("operatorId"))
    }
}
