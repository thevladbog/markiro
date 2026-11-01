package app.markiro.handheld.core.reprint

import app.markiro.handheld.core.label.LabelRenderException
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ReprintBrandingTest {
    private fun branding(pixels: String = "gA==", tenant: String = "tenant"): JsonObject {
        val logo = buildJsonObject {
            put("width",4);put("height",1);put("stride",1);put("pixelsBase64",pixels);put("source","markiro")
            put("digest",reprintDigest(buildJsonObject {put("width",4);put("height",1);put("stride",1);put("pixelsHex","80")}))
        }
        val body = buildJsonObject {put("schemaVersion",1);put("producerVersion","logo-raster-v1");put("tenantId",tenant);put("ownerDigest","a".repeat(64));put("organizationName","Historical plant");put("organizationInn",JsonNull);put("logoRevision",JsonNull);put("sourceChecksum",JsonNull);put("logo",logo)}
        return JsonObject(body+("digest" to JsonPrimitive(reprintDigest(body))))
    }
    private fun source(value: JsonElement?): SiteReprintSource {
        val data=buildJsonObject { if(value!=null) put("brandingJson",value) }
        return SiteReprintSource("pallet","id","identity","Milk",emptyMap(),buildJsonObject {put("data",data)}.toString())
    }
    @Test fun historicalPixelsAreReplayedAndOnlyExplicitAbsenceReturnsNull() {
        val raster=checkNotNull(historicalReprintLogo(source(JsonPrimitive(branding().toString())),"tenant"))
        assertEquals("80",raster.hex);assertEquals(4,raster.width);assertEquals(1,raster.height);assertEquals(1,raster.bytesPerRow)
        assertNull(historicalReprintLogo(source(JsonNull),"tenant"))
    }
    @Test fun rejectsForeignTenantCorruptDigestPaddingAndMissingEvidence() {
        val changed=JsonObject(branding()+("organizationName" to JsonPrimitive("Changed plant")))
        for(value in listOf<JsonElement?>(null,JsonPrimitive(branding(tenant="foreign").toString()),JsonPrimitive(changed.toString()),JsonPrimitive(branding("gQ==").toString()),JsonPrimitive(branding("gA").toString()))) {
            try {historicalReprintLogo(source(value),"tenant");fail("invalid historical branding accepted")}catch(_:LabelRenderException){}
        }
    }
}
