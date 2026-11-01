package app.markiro.handheld.core.print

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PrinterOutputModeTest {
    @Test fun legacyAndNewReprintSnapshotsRoundTripTheirMode() {
        val legacy = """{"id":"p","name":"P","transport":"wifi","address":"p:9100","language":"zpl","dpi":203}"""
        val decoded = Json.decodeFromString<app.markiro.handheld.core.reprint.ReprintPrinter>(legacy)
        assertNull(decoded.entity().outputMode)
        val selected = decoded.copy(outputMode = "cutter")
        assertEquals("cutter", Json.decodeFromString<app.markiro.handheld.core.reprint.ReprintPrinter>(Json.encodeToString(selected)).entity().outputMode)
    }

    @Test fun matchesTheSharedDomainFixturesByteForByte() {
        val source = checkNotNull(javaClass.classLoader?.getResource("printer-output-modes.json")).readText()
        val cases = Json.parseToJsonElement(source).jsonArray
        assertEquals(8, cases.size)
        for (element in cases) {
            val case = element.jsonObject
            fun text(key: String) = case.getValue(key).jsonPrimitive.content
            fun bytes(key: String) = text(key).chunked(2).map { it.toInt(16).toByte() }.toByteArray()
            assertArrayEquals(bytes("outputHex"), applyPrinterOutputMode(bytes("inputHex"), text("language"), case.getValue("mode").jsonPrimitive.contentOrNull))
        }
    }

    @Test fun legacyBytesAreUntouched() {
        val bytes = byteArrayOf(0, -128, -1)
        assertSame(bytes, applyPrinterOutputMode(bytes, "tspl", null))
    }
    @Test fun allZplModesAreInsideTheFormat() {
        for ((mode, command) in listOf("normal" to "T", "peel" to "P", "cutter" to "C")) {
            val bytes = "^XA\n^GFA,1,1,1,FF^FS\n^XZ\n".toByteArray()
            assertEquals("^XA\n^MM$command\n\n^GFA,1,1,1,FF^FS\n^XZ\n", applyPrinterOutputMode(bytes, "zpl", mode).toString(Charsets.US_ASCII))
        }
    }
    @Test fun tsplSwitchesOffCompetingModeWithoutDecodingRasterBytes() {
        val body = byteArrayOf(0, -128, -1, 10)
        for ((mode, command) in listOf("normal" to "SET CUTTER OFF\nSET PEEL OFF\n", "peel" to "SET CUTTER OFF\nSET PEEL ON\n", "cutter" to "SET PEEL OFF\nSET CUTTER 1\n")) {
            assertArrayEquals(command.toByteArray() + body, applyPrinterOutputMode(body, "tspl", mode))
        }
    }
}
