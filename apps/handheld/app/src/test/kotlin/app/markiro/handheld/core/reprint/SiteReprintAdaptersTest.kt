package app.markiro.handheld.core.reprint

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SiteReprintAdaptersTest {
    private fun fixture(name: String): JsonObject = Json.parseToJsonElement(checkNotNull(javaClass.classLoader?.getResourceAsStream(name)).bufferedReader().use { it.readText() }).jsonObject
    @Test fun hostUsesHistoricalNativeAndImportedFieldsAndPreservesCanonicalTail() {
        for (file in listOf("warehouse-lookup-found-unit.json", "warehouse-lookup-found-imported-unit.json")) {
            val response = fixture(file)
            val canonical = response.getValue("source").jsonObject.getValue("canonical").jsonPrimitive.content
            val source = HostSiteReprintBackend.decodeLookup(canonical, response) as SiteReprintLookup.Found
            assertEquals(canonical, source.source.fields["km.code"])
            assertEquals("08.10.2026", source.source.fields["date"])
            assertEquals("17.10.2026", source.source.fields["expiry"])
            assertEquals("1", source.source.fields["qty"])
            assertEquals(response.getValue("source").toString(), source.source.sourceJson)
        }
    }
    @Test fun hostRefusesFullCodeWithDifferentCryptoOrMismatchedIdentity() {
        val response = fixture("warehouse-lookup-found-unit.json")
        val canonical = response.getValue("source").jsonObject.getValue("canonical").jsonPrimitive.content
        assertTrue(HostSiteReprintBackend.decodeLookup(canonical+"OTHER", response) is SiteReprintLookup.Unavailable)
        assertTrue(HostSiteReprintBackend.decodeLookup("046006820000015000", response) is SiteReprintLookup.Unavailable)
    }
    private val id = "11111111-1111-4111-8111-111111111111"
    private fun input(outcome:String="prepared", sequence:Long=1, attempt:Int=1) = SiteReprintAuditInput(id,id,id,id,attempt,"damaged",outcome,null,SiteReprintTemplate(id,"Template","box","{}","{}","a".repeat(64),"b".repeat(64)),"printer","zpl",203,"Ynl0ZXM=",id,"2026-11-01T12:00:00Z",sequence)
    private fun cloudSource():SiteReprintSource {
        val original=buildJsonObject { put("kind","box");put("sourceId",id);put("identity","046006820000015000");put("revision","c".repeat(64));put("payloadDigest","d".repeat(64));put("sourceShiftId",JsonNull) }
        return SiteReprintSource("box",id,"046006820000015000","Milk",mapOf("sscc" to "046006820000015000"),buildJsonObject { put("source",original);put("repair",JsonNull) }.toString(),revision="c".repeat(64))
    }
    @Test fun hostPreparationIsLocalAndTerminalEnvelopeIsFrozenAndExact() = kotlinx.coroutines.test.runTest {
        val requests=mutableListOf<String>()
        val host=HostSiteReprintBackend({ _, body -> requests+=body; buildJsonObject { put("receipts",JsonArray(listOf(buildJsonObject { put("id",id);put("outcome","accepted") }))) } }, {emptyList()})
        assertEquals(SiteReprintReceipt.Accepted,host.report(host.auditPayload(cloudSource(),input())))
        assertTrue(requests.isEmpty())
        val payload=host.auditPayload(cloudSource(),input("sent",3))
        host.report(payload);host.report(payload)
        assertEquals(requests[0],requests[1])
        val record=Json.parseToJsonElement(requests[0]).jsonObject.getValue("records").jsonArray.single().jsonObject
        assertEquals(id,record.getValue("operatorId").jsonPrimitive.content)
        assertEquals(id,record.getValue("id").jsonPrimitive.content)
        assertEquals("sent",record.getValue("outcome").jsonPrimitive.content)
    }
    @Test fun cloudPreservesEventIdentityTransitionsAndRetriesExactEnvelope() = kotlinx.coroutines.test.runTest {
        val requests=mutableListOf<String>()
        val cloud=CloudSiteReprintBackend({error("unused")},{_,body -> requests+=body;buildJsonObject {put("protocol",CloudSiteReprintBackend.V1);put("acceptedEventIds",JsonArray(listOf(JsonPrimitive(id))));put("quarantined",JsonArray(emptyList()))}})
        val first=cloud.auditPayload(cloudSource(),input())
        cloud.report(first);cloud.report(first)
        assertEquals(requests[0],requests[1])
        fun event(outcome:String,seq:Long,attempt:Int=1)=Json.parseToJsonElement(Json.parseToJsonElement(cloud.auditPayload(cloudSource(),input(outcome,seq,attempt))).jsonObject.getValue("body").jsonPrimitive.content).jsonObject.getValue("events").jsonArray.single().jsonObject
        assertEquals("prepared",event("prepared",1).getValue("kind").jsonPrimitive.content)
        assertEquals("sending",event("sending",2).getValue("kind").jsonPrimitive.content)
        assertEquals("sent",event("sent",3).getValue("kind").jsonPrimitive.content)
        assertEquals("reprint_prepared",event("prepared",4,2).getValue("kind").jsonPrimitive.content)
        assertEquals(4,event("prepared",4,2).getValue("sequence").jsonPrimitive.int)
        assertEquals(id,event("sent",3).getValue("attemptId").jsonPrimitive.content)
    }
    @Test fun receiptsForOtherRecordsNeverAcknowledgeSavedEnvelopes() = kotlinx.coroutines.test.runTest {
        val host=HostSiteReprintBackend({_,_->buildJsonObject {put("receipts",JsonArray(listOf(buildJsonObject {put("id","other");put("outcome","accepted")}))) }},{emptyList()})
        try {host.report(host.auditPayload(cloudSource(),input("sent",3)));fail("mismatch accepted")}catch(_:java.io.IOException){}
    }
    @Test fun onlyKnownLegacySsccRepairIsAcceptedAtLookup() {
        assertEquals("046006820000015000",siteReprintSscc("!100046006820000015000"))
        assertEquals("046006820000015000",siteReprintSscc("]C0!100046006820000015000"))
        assertNull(siteReprintSscc("!100046006820000015001"))
        assertNull(siteReprintSscc("!1046006820000015000"))
    }
    @Test fun cloudLookupKeepsMetadataOutsideImmutableSnapshotAndHashesOriginalLegacyScan() = kotlinx.coroutines.test.runTest {
        val sscc="046006820000015000"
        val body=buildJsonObject {
            put("kind","box");put("sourceId",id);put("identity",sscc);put("productName","Milk");put("chzProductGroupCode",JsonNull)
            put("fields",buildJsonObject { for(field in app.markiro.handheld.core.label.LabelField.entries) put(field.wire,if(field.wire=="sscc") sscc else "") })
            put("sourceShiftId",JsonNull);put("payloadDigest","a".repeat(64));put("unavailableFields",JsonArray(listOf(JsonPrimitive("expiry"))))
        }
        val source=JsonObject(body+("revision" to JsonPrimitive(reprintDigest(body))))
        val response=buildJsonObject {put("status","found");put("kind","box");put("source",source);put("repair","legacy_tspl_fnc1_literal")}
        val cloud=CloudSiteReprintBackend({error("unused")},{path,_-> assertEquals("handheld-lookup-v3",path);buildJsonObject {put("result",response);put("productId",id);put("groupCode",8)}})
        val found=(cloud.lookup("!100$sscc",id) as SiteReprintLookup.Found).source
        assertEquals(listOf("expiry"),found.unavailableFields)
        assertEquals(id,found.productId);assertEquals(8,found.groupCode);assertEquals(response.toString(),found.sourceJson)
        assertEquals(app.markiro.handheld.core.duplicate.productLabelBytesDigest("!100$sscc".toByteArray()),found.scanDigest)
        val saved=Json.parseToJsonElement(cloud.auditPayload(found,input())).jsonObject
        val event=Json.parseToJsonElement(saved.getValue("body").jsonPrimitive.content).jsonObject.getValue("events").jsonArray.single().jsonObject
        assertEquals(found.scanDigest,event.getValue("scanDigest").jsonPrimitive.content)
    }
    @Test fun cloudCatalogRetainsGroupScopesAndOriginalChoices() = kotlinx.coroutines.test.runTest {
        val unitBody=buildJsonObject {put("id",id);put("revision","a".repeat(64));put("name","Unit");put("purpose","product_duplicate");put("enabled",true);put("chzProductGroupCodes",JsonArray(listOf(JsonPrimitive(8))));put("spec",JsonObject(emptyMap()))}
        val unit=JsonObject(unitBody+("digest" to JsonPrimitive(reprintDigest(unitBody))))
        val choice=buildJsonObject {put("id",id);put("kind","thermal");put("name","Pallet");put("snapshot",JsonObject(emptyMap()));put("snapshotDigest",reprintDigest(JsonObject(emptyMap())))}
        val cloud=CloudSiteReprintBackend({path->if(path=="templates") buildJsonObject {put("protocol",CloudSiteReprintBackend.V1);put("templates",JsonArray(listOf(unit)))} else buildJsonObject {put("protocol",CloudSiteReprintBackend.V3);put("templates",JsonArray(listOf(buildJsonObject {put("template",choice);put("groupCodes",JsonArray(listOf(JsonPrimitive(8))))}))) }},{_,_->error("unused")})
        val catalog=cloud.refreshTemplates()
        assertEquals(listOf("unit","pallet"),catalog.map{it.kind})
        assertTrue(catalog.all{it.groupCodes==listOf(8)})
        assertEquals(choice.toString(),catalog.last().sourceJson)
    }
    @Test fun stableDigestMatchesDomainCanonicalJson() {
        assertEquals("43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777", reprintDigest(Json.parseToJsonElement("{\"b\":2,\"a\":1}")))
    }
}
