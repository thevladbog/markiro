package app.markiro.handheld.core.label

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.ceil

/**
 * Pins both emitters to `packages/domain`. Text inside printable ASCII must match character for
 * character. Text outside it cannot: the image payload comes from Android's font engine, which is a
 * third implementation next to the browser canvas the station and the cabinet preview share, and
 * those two are deliberately pixel-identical to each other. Those cases assert the command framing
 * and the bitmap's dimensions and placement instead. A difference in glyph pixels is not a
 * regression here.
 */
class LabelFixturesTest {
    private val fixtures: JsonObject = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource("label-fixtures.json")) {
            "run pnpm --filter @markiro/domain fixtures:labels"
        }.readText(),
    ).jsonObject

    private fun JsonObject.str(key: String) = getValue(key).jsonPrimitive.content

    private fun data(o: JsonObject): Map<LabelField, String> =
        o.entries.associate { (key, value) -> LabelField.fromWire(key) to value.jsonPrimitive.content }

    /** Mirrors the stub in `packages/domain/src/labels/label-fixtures.ts` exactly. */
    private val stub = RasterizeText { text, options ->
        val natural = maxOf(1, text.codePointCount(0, text.length)) * ceil(options.fontSizePx * 0.5).toInt()
        val width = options.maxWidthPx?.let { minOf(natural, it) } ?: natural
        val height = ceil(options.fontSizePx * 1.5).toInt()
        val bytesPerRow = (width + 7) / 8
        val totalBytes = bytesPerRow * height
        RasterResult("A5".repeat(totalBytes), totalBytes, bytesPerRow, width, height)
    }

    @Test
    fun asciiSpecsRenderCharacterForCharacterInBothLanguages() = runTest {
        val cases = fixtures.getValue("byteIdentical").jsonArray
        assertTrue(cases.size >= 9)
        for (element in cases) {
            val case = element.jsonObject
            val name = case.str("name")
            val spec = LabelSpecCodec.spec(case.getValue("spec").jsonObject)
            val values = data(case.getValue("data").jsonObject)
            assertEquals(name, case.str("zpl"), generateZpl(spec, values, null))
            assertEquals(name, case.str("tspl"), String(generateTspl(spec, values, null), Charsets.ISO_8859_1))
        }
    }

    @Test
    fun cyrillicSpecsAskTheRasterizerForTheSameRunsAndFrameTheImageTheSameWay() = runTest {
        val cases = fixtures.getValue("structural").jsonArray
        assertTrue(cases.size >= 4)
        for (element in cases) {
            val case = element.jsonObject
            val name = case.str("name")
            val spec = LabelSpecCodec.spec(case.getValue("spec").jsonObject)
            val values = data(case.getValue("data").jsonObject)

            val calls = ArrayList<String>()
            val recording = RasterizeText { text, options ->
                calls += listOf(
                    text,
                    options.fontSizePx.toString(),
                    options.bold.toString(),
                    (options.maxWidthPx?.toString() ?: "null"),
                    options.maxLines.toString(),
                ).joinToString("|")
                stub.rasterize(text, options)
            }
            val zpl = generateZpl(spec, values, recording)

            val expectedCalls = case.getValue("rasterCalls").jsonArray.map { call ->
                val o = call.jsonObject
                listOf(
                    o.str("text"),
                    o.getValue("fontSizePx").jsonPrimitive.intOrNull.toString(),
                    (o.getValue("bold").jsonPrimitive.booleanOrNull == true).toString(),
                    (o.getValue("maxWidthPx").takeIf { it !is JsonNull }?.jsonPrimitive?.intOrNull?.toString() ?: "null"),
                    o.getValue("maxLines").jsonPrimitive.intOrNull.toString(),
                ).joinToString("|")
            }
            assertEquals(name, expectedCalls, calls)
            assertEquals(name, case.str("zplShape"), reduceZpl(zpl))

            val tspl = String(generateTspl(spec, values, stub), Charsets.ISO_8859_1)
            assertEquals(name, case.getValue("tsplShape").jsonArray.map { it.jsonPrimitive.content }, reduceTspl(tspl))
        }
    }

    private fun reduceZpl(document: String): String =
        Regex("\\^GFA,(\\d+),(\\d+),(\\d+),([0-9A-F]*)").replace(document) { m ->
            "^GFA,${m.groupValues[1]},${m.groupValues[2]},${m.groupValues[3]},<hex:${m.groupValues[4].length}>"
        }

    /** Mirrors `reduceTspl` in the fixture builder: the payload is skipped by length, never by newline. */
    private fun reduceTspl(document: String): List<String> {
        val out = ArrayList<String>()
        var index = 0
        while (index < document.length) {
            if (document.startsWith("BITMAP ", index)) {
                var commas = 0
                var cursor = index
                while (cursor < document.length && commas < 5) {
                    if (document[cursor] == ',') commas++
                    cursor++
                }
                val header = document.substring(index, cursor)
                val params = header.removePrefix("BITMAP ").split(",")
                val payloadLength = params[2].toInt() * params[3].toInt()
                out += "$header<payload:$payloadLength>"
                index = cursor + payloadLength + 1
                continue
            }
            val end = document.indexOf('\n', index)
            val line = if (end == -1) document.substring(index) else document.substring(index, end)
            if (line.isNotEmpty()) out += line
            index = if (end == -1) document.length else end + 1
        }
        return out
    }
}
