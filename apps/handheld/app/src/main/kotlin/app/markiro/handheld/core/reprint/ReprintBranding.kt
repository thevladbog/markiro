package app.markiro.handheld.core.reprint

import app.markiro.handheld.core.label.LabelRenderException
import app.markiro.handheld.core.label.RasterResult
import kotlinx.serialization.json.*
import java.util.Base64

/** Port of validatePalletBranding and sheetLogoFingerprint; reads only the frozen V3 source. */
fun historicalReprintLogo(source: SiteReprintSource, expectedTenantId: String): RasterResult? {
    fun invalid(): Nothing = throw LabelRenderException("Invalid historical reprint branding")
    try {
        if (source.kind != "pallet") invalid()
        val savedSource = reprintObject(source.sourceJson).getValue("data").jsonObject
        val brandingValue = savedSource["brandingJson"] ?: invalid()
        if (brandingValue is JsonNull) return null
        val text = (brandingValue as? JsonPrimitive)?.takeIf { it.isString }?.content ?: invalid()
        if (text.toByteArray(Charsets.UTF_8).size > 131_072) invalid()
        val saved = reprintObject(text)
        val required = setOf("schemaVersion", "producerVersion", "tenantId", "ownerDigest", "organizationName", "logoRevision", "sourceChecksum", "digest", "logo")
        if (!saved.keys.containsAll(required) || (saved.keys - required - "organizationInn").isNotEmpty()) invalid()
        fun integer(value: JsonObject, key: String): Int = (value[key] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull ?: invalid()
        fun hash(value: JsonObject, key: String): String = value.string(key).takeIf { it.matches(Regex("[a-f0-9]{64}")) } ?: invalid()
        if (integer(saved,"schemaVersion") != 1 || saved.string("producerVersion") != "logo-raster-v1" || saved.string("tenantId") != expectedTenantId || expectedTenantId.isBlank()) invalid()
        hash(saved,"ownerDigest")
        val name = saved.string("organizationName").trim()
        if (name.isEmpty() || name.length > 255) invalid()
        val inn = saved.optionalString("organizationInn")
        if (inn != null && !inn.matches(Regex("(?:[0-9]{10}|[0-9]{12})"))) invalid()
        if (hash(saved,"digest") != reprintDigest(JsonObject(saved.filterKeys { it != "digest" }))) invalid()
        val logo = saved.getValue("logo").jsonObject
        if (logo.keys != setOf("width","height","stride","pixelsBase64","digest","source")) invalid()
        val width=integer(logo,"width")
        val height=integer(logo,"height")
        val stride=integer(logo,"stride")
        if (width !in 1..1024 || height !in 1..512 || stride !in 1..128 || stride != (width+7)/8) invalid()
        val encoded=logo.string("pixelsBase64")
        if (encoded.length>90_000) invalid()
        val bytes=Base64.getDecoder().decode(encoded)
        if (Base64.getEncoder().encodeToString(bytes)!=encoded || bytes.size!=stride*height) invalid()
        val unused=(1 shl ((8-width%8)%8))-1
        if ((0 until height).any { (bytes[(it+1)*stride-1].toInt() and unused)!=0 }) invalid()
        val hex=bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
        val fingerprint=reprintDigest(buildJsonObject {put("width",width);put("height",height);put("stride",stride);put("pixelsHex",hex)})
        if (hash(logo,"digest")!=fingerprint) invalid()
        val revision=saved.optionalString("logoRevision")
        val checksum=saved.optionalString("sourceChecksum")
        when(logo.string("source")) {
            "organization" -> {
                if (revision==null || !Regex("(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)").matches(revision)) invalid()
                if (checksum==null || !checksum.matches(Regex("[a-f0-9]{64}"))) invalid()
            }
            "markiro" -> if(revision!=null || checksum!=null) invalid()
            else -> invalid()
        }
        return RasterResult(hex.uppercase(java.util.Locale.ROOT),bytes.size,stride,width,height)
    } catch (error: LabelRenderException) { throw error }
      catch (_: Exception) { invalid() }
}
