package app.markiro.handheld.core.label

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.HandheldDatabase
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton

/** A complete logo cache belongs to a server/tenant/device AND credential owner.
 * No configured-logo failure is treated as permission to substitute Markiro. */
@Singleton
class OrganizationPrintBranding @Inject constructor(
    @ApplicationContext private val context: Context,
    private val db: HandheldDatabase,
    private val api: StationApi,
) {
    private val prefs = context.getSharedPreferences("print-branding-v1", Context.MODE_PRIVATE)
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun ownerKey(): String {
        val token = DeviceRecovery.generationContext.get() ?: throw LabelRenderException("Branding owner unavailable")
        return sha("${token.owner.serverOrigin}\n${token.owner.tenantId}\n${token.owner.deviceId}\n${db.recovery.key(token)}".toByteArray())
    }
    private fun cached(key: String): RasterResult? {
        val value = prefs.getString(key, null) ?: return null
        if (value.length > 200_000) throw LabelRenderException("Invalid branding cache")
        val saved = Json.parseToJsonElement(value).jsonObject
        val raster = RasterResult(saved.getValue("hex").jsonPrimitive.content, saved.getValue("totalBytes").jsonPrimitive.int, saved.getValue("bytesPerRow").jsonPrimitive.int, saved.getValue("width").jsonPrimitive.int, saved.getValue("height").jsonPrimitive.int)
        if (raster.width !in 1..1120 || raster.height !in 1..512 || raster.bytesPerRow != (raster.width + 7) / 8 || raster.totalBytes != raster.bytesPerRow * raster.height || raster.hex.length != raster.totalBytes * 2 || !raster.hex.matches(Regex("[a-fA-F0-9]+")) || sha(raster.hex.toByteArray()) != saved.getValue("digest").jsonPrimitive.content) throw LabelRenderException("Invalid branding cache")
        return raster
    }
    /** Cache only: label rendering cannot make a network request. */
    suspend fun loadCached(): RasterResult? = db.recovery.work {
        val key = ownerKey()
        try { cached(key) } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { null }
    }
    private fun cachedDescriptor(key: String): String? = prefs.getString(key, null)?.let {
        Json.parseToJsonElement(it).jsonObject["descriptor"]?.jsonPrimitive?.content
    }
    suspend fun load(): RasterResult = db.recovery.work {
        val key = ownerKey()
        cached(key) ?: refresh()
    }
    suspend fun refresh(): RasterResult = db.recovery.work {
        val token = checkNotNull(DeviceRecovery.generationContext.get())
        val key = ownerKey()
        val descriptor = api.printBranding()
        val revision = descriptor["logoRevision"].takeUnless { it == null || it is JsonNull }?.jsonPrimitive?.content
        val identity = if (revision == null) {
            if (descriptor["logo"] != JsonNull || descriptor["logoUrl"] != JsonNull) throw LabelRenderException("Incomplete absent branding")
            "absent"
        } else {
            val path = "/station/handheld-branding/logo/$revision"
            if (!revision.matches(Regex("[0-9a-fA-F-]{36}")) || descriptor["logoUrl"]?.jsonPrimitive?.content != path) throw LabelRenderException("Invalid logo route")
            val meta = descriptor.getValue("logo").jsonObject
            val size = meta.getValue("byteSize").jsonPrimitive.int
            val width = meta.getValue("width").jsonPrimitive.int
            val height = meta.getValue("height").jsonPrimitive.int
            val checksum = meta.getValue("checksum").jsonPrimitive.content
            if (size !in 1..5*1024*1024 || width !in 1..1024 || height !in 1..512 || !checksum.matches(Regex("[a-f0-9]{64}")) || meta.getValue("contentType").jsonPrimitive.content != "image/webp") throw LabelRenderException("Invalid logo metadata")
            sha("$revision\n$path\n$size\n$width\n$height\n$checksum\nimage/webp".toByteArray())
        }
        val existing = runCatching { cached(key) }.getOrNull()
        if (existing != null && cachedDescriptor(key) == identity) {
            db.recovery.guard(token) { }
            return@work existing
        }
        val bitmap = if (revision == null) {
            if (descriptor["logo"] != JsonNull || descriptor["logoUrl"] != JsonNull) throw LabelRenderException("Incomplete absent branding")
            withContext(Dispatchers.IO) { context.assets.open("markiro-print-logo.png").use { BitmapFactory.decodeStream(it) } }
        } else {
            val path = "/station/handheld-branding/logo/$revision"
            if (!revision.matches(Regex("[0-9a-fA-F-]{36}")) || descriptor["logoUrl"]?.jsonPrimitive?.content != path) throw LabelRenderException("Invalid logo route")
            val meta = descriptor.getValue("logo").jsonObject
            val size = meta.getValue("byteSize").jsonPrimitive.int
            if (size !in 1..5*1024*1024 || meta.getValue("contentType").jsonPrimitive.content != "image/webp") throw LabelRenderException("Invalid logo metadata")
            val bytes = api.printBrandingLogo(revision).use { body ->
                if (body.contentType()?.toString() != "image/webp") throw LabelRenderException("Invalid logo content type")
                val source = body.source()
                if (source.request(size + 1L)) throw LabelRenderException("Logo byte size mismatch")
                source.buffer.readByteArray()
            }
            if (bytes.size != size || sha(bytes) != meta.getValue("checksum").jsonPrimitive.content) throw LabelRenderException("Logo checksum mismatch")
            val width = meta.getValue("width").jsonPrimitive.int
            val height = meta.getValue("height").jsonPrimitive.int
            if (width !in 1..1024 || height !in 1..512) throw LabelRenderException("Logo dimensions exceed bounds")
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth != width || bounds.outHeight != height) throw LabelRenderException("Logo dimensions mismatch")
            val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw LabelRenderException("Logo decoding failed")
            if (decoded.width != meta.getValue("width").jsonPrimitive.int || decoded.height != meta.getValue("height").jsonPrimitive.int) { decoded.recycle(); throw LabelRenderException("Logo dimensions mismatch") }
            decoded
        } ?: throw LabelRenderException("Logo unavailable")
        val raster = withContext(Dispatchers.Default) {
            try {
                if (bitmap.width !in 1..1120 || bitmap.height !in 1..512) throw LabelRenderException("Logo exceeds bounds")
                val paper = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
                try {
                    val canvas = Canvas(paper); canvas.drawColor(Color.WHITE); canvas.drawBitmap(bitmap, 0f, 0f, null)
                    val pixels = IntArray(paper.width * paper.height)
                    paper.getPixels(pixels, 0, paper.width, 0, 0, paper.width, paper.height)
                    val packed = bitmapToZplHex(convertToMonochrome(pixels, paper.width, paper.height), paper.width, paper.height)
                    RasterResult(packed.hex, packed.totalBytes, packed.bytesPerRow, paper.width, paper.height)
                } finally { paper.recycle() }
            } finally { bitmap.recycle() }
        }
        val saved = buildJsonObject {
            put("descriptor", identity); put("width", raster.width); put("height", raster.height); put("bytesPerRow", raster.bytesPerRow); put("totalBytes", raster.totalBytes); put("hex", raster.hex); put("digest", sha(raster.hex.toByteArray()))
        }.toString()
        db.recovery.guard(token) {
            if (!prefs.edit().clear().putString(key, saved).commit()) throw LabelRenderException("Branding cache write failed")
        }
        raster
    }
}
