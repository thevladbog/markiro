package app.markiro.handheld.core.print

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.SocketTimeoutException

class PrinterTransportTest {
    private fun printer(address: String, language: String = "zpl") = PrinterEntity(
        id = "p1", name = "Test", transport = "wifi", address = address,
        language = language, dpi = 203, selected = true, lastStatus = null, lastSeenAt = null,
    )

    private class FakeConnection(reply: ByteArray, private val failAfter: Int?) : PrinterConnection {
        val written = ByteArrayOutputStream()
        override val input: InputStream = ByteArrayInputStream(reply)
        override val output: OutputStream = object : OutputStream() {
            private var count = 0
            override fun write(b: Int) {
                if (failAfter != null && count >= failAfter) throw IOException("link dropped")
                count++
                written.write(b)
            }
        }
        override fun close() = Unit
    }

    private fun transport(connector: PrinterConnector) = StreamPrinterTransport { connector }

    @Test
    fun aReadyPrinterAcceptsTheDocument() = runTest {
        val connection = FakeConnection(byteArrayOf(), null)
        val outcome = transport { connection }.send(printer("host:9100"), "^XA^XZ".toByteArray())
        assertEquals(SendOutcome.Delivered, outcome)
        assertEquals("^XA^XZ", connection.written.toString("US-ASCII"))
    }

    @Test
    fun aLinkThatBreaksPartwayThroughIsUnknownNotRefused() = runTest {
        val connection = FakeConnection(byteArrayOf(), failAfter = 3)
        val outcome = transport { connection }.send(printer("host:9100"), "^XA^XZ".toByteArray())
        assertTrue(outcome is SendOutcome.Unknown)
    }

    @Test
    fun aLongDocumentIsWrittenInChunksSoABrokenLinkIsNoticed() = runTest {
        // One large write is copied into the kernel's send buffer and succeeds even when the peer has
        // gone, so the document is written a piece at a time and each piece is flushed.
        val document = ByteArray(4096) { '^'.code.toByte() }
        val connection = FakeConnection(byteArrayOf(), failAfter = 600)
        val outcome = transport { connection }.send(printer("host:9100"), document)
        assertTrue(outcome is SendOutcome.Unknown)
        assertTrue(connection.written.size() in 1 until document.size)
    }

    @Test
    fun aConnectionThatNeverOpensIsRefused() = runTest {
        val outcome = transport { throw IOException("no route to host") }
            .send(printer("host:9100"), "^XA^XZ".toByteArray())
        assertTrue(outcome is SendOutcome.Refused)
        assertEquals(NotReadyReason.UNREACHABLE, (outcome as SendOutcome.Refused).reason)
    }

    @Test
    fun theZplStatusReplyIsDecoded() = runTest {
        val ready = "PRINTER STATUS\r\n ERRORS: 0 00000000 00000000\r\n".toByteArray()
        assertEquals(PrinterStatus.Ready, transport { FakeConnection(ready, null) }.status(printer("host:9100")))
        val noPaper = "PRINTER STATUS\r\n ERRORS: 1 00000000 00000001\r\n".toByteArray()
        assertEquals(
            PrinterStatus.NotReady(NotReadyReason.NO_PAPER),
            transport { FakeConnection(noPaper, null) }.status(printer("host:9100")),
        )
        val headOpen = "PRINTER STATUS\r\n ERRORS: 1 00000000 00000004\r\n".toByteArray()
        assertEquals(
            PrinterStatus.NotReady(NotReadyReason.HEAD_OPEN),
            transport { FakeConnection(headOpen, null) }.status(printer("host:9100")),
        )
        val other = "PRINTER STATUS\r\n ERRORS: 1 00000000 00000040\r\n".toByteArray()
        assertEquals(
            PrinterStatus.NotReady(NotReadyReason.OTHER),
            transport { FakeConnection(other, null) }.status(printer("host:9100")),
        )
    }

    @Test
    fun theTsplStatusReplyIsDecoded() = runTest {
        val cases = mapOf(
            0x00 to PrinterStatus.Ready,
            0x01 to PrinterStatus.NotReady(NotReadyReason.HEAD_OPEN),
            0x04 to PrinterStatus.NotReady(NotReadyReason.NO_PAPER),
            0x05 to PrinterStatus.NotReady(NotReadyReason.NO_PAPER),
            0x80 to PrinterStatus.NotReady(NotReadyReason.OTHER),
        )
        for ((byte, expected) in cases) {
            val connection = FakeConnection(byteArrayOf(byte.toByte()), null)
            assertEquals(byte.toString(), expected, transport { connection }.status(printer("host:9100", "tspl")))
        }
    }

    @Test
    fun aSilentPrinterIsNotReady() = runTest {
        val outcome = transport { FakeConnection(byteArrayOf(), null) }.status(printer("host:9100"))
        assertEquals(PrinterStatus.NotReady(NotReadyReason.UNREACHABLE), outcome)
    }

    @Test
    fun theWifiConnectorReachesARealSocket() = runTest {
        val server = withContext(Dispatchers.IO) { ServerSocket(0) }
        val received = ByteArrayOutputStream()
        val accepting = launch(Dispatchers.IO) {
            server.accept().use { socket -> socket.getInputStream().copyTo(received) }
        }
        val transport = StreamPrinterTransport { WifiPrinterConnector() }
        val outcome = transport.send(printer("127.0.0.1:${server.localPort}"), "^XA^XZ".toByteArray())
        accepting.join()
        withContext(Dispatchers.IO) { server.close() }
        assertEquals(SendOutcome.Delivered, outcome)
        assertEquals("^XA^XZ", received.toString("US-ASCII"))
    }

    @Test
    fun aClosedPortIsRefused() = runTest {
        val port = withContext(Dispatchers.IO) { ServerSocket(0).use { it.localPort } }
        val transport = StreamPrinterTransport { WifiPrinterConnector() }
        val outcome = transport.send(printer("127.0.0.1:$port"), "^XA^XZ".toByteArray())
        assertTrue(outcome is SendOutcome.Refused)
    }

    @Test
    fun anAddressWithoutAPortFallsBackToTheRawPrintingPort() {
        assertEquals("192.168.1.40" to 9100, WifiPrinterConnector.parseAddress("192.168.1.40"))
        assertEquals("192.168.1.40" to 6101, WifiPrinterConnector.parseAddress("192.168.1.40:6101"))
    }

    @Test
    fun aPortOutsideTheRangeFallsBackInsteadOfReachingTheSocket() {
        // A port the socket rejects throws IllegalArgumentException, which is not the IOException
        // the transport catches, so it would surface as a crash rather than as a printer refusing.
        assertEquals("192.168.1.40" to 9100, WifiPrinterConnector.parseAddress("192.168.1.40:99999"))
        assertEquals("192.168.1.40" to 9100, WifiPrinterConnector.parseAddress("192.168.1.40:0"))
        assertEquals("192.168.1.40" to 9100, WifiPrinterConnector.parseAddress("192.168.1.40:printer"))
        assertEquals(65535, WifiPrinterConnector.normalizePort("65535"))
        assertEquals(9100, WifiPrinterConnector.normalizePort("65536"))
        assertEquals(9100, WifiPrinterConnector.normalizePort(""))
    }

    /** Answers once, then holds the line open the way a printer on a raw printing port does. */
    private class HoldingConnection(private vararg val chunks: ByteArray) : PrinterConnection {
        private var next = 0
        override val input: InputStream = object : InputStream() {
            override fun read(): Int = throw UnsupportedOperationException("read into a buffer")
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (next >= chunks.size) throw SocketTimeoutException("read timed out")
                val chunk = chunks[next++]
                val length = minOf(len, chunk.size)
                chunk.copyInto(b, off, 0, length)
                return length
            }
        }
        override val output: OutputStream = ByteArrayOutputStream()
        override fun close() = Unit
    }

    @Test
    fun aPrinterThatAnswersAndThenHoldsTheLineOpenIsStillDecoded() = runTest {
        // Reading to end of stream would spend the whole five seconds waiting for a close that never
        // comes and then throw the reply away with the timeout, reporting a healthy printer as
        // unreachable. This is the case that only a real printer would have shown.
        val ready = "PRINTER STATUS\r\n ERRORS: 0 00000000 00000000\r\n".toByteArray(Charsets.US_ASCII)
        val outcome = transport { HoldingConnection(ready) }.status(printer("host:9100"))
        assertEquals(PrinterStatus.Ready, outcome)
    }

    @Test
    fun aReplySplitAcrossPacketsIsReadWholeBeforeItIsDecoded() = runTest {
        // Stopping at the first packet would read the mask as `000000`, which is neither the mask the
        // printer sent nor a refusal: it would decode as a printer with nothing wrong.
        val outcome = transport {
            HoldingConnection(
                "PRINTER STATUS\r\n ERRORS: 1 00000000 000000".toByteArray(Charsets.US_ASCII),
                "01\r\n".toByteArray(Charsets.US_ASCII),
            )
        }.status(printer("host:9100"))
        assertEquals(PrinterStatus.NotReady(NotReadyReason.NO_PAPER), outcome)
    }

    @Test
    fun aPrinterThatSaysNothingAtAllIsUnreachable() = runTest {
        val outcome = transport { HoldingConnection() }.status(printer("host:9100"))
        assertEquals(PrinterStatus.NotReady(NotReadyReason.UNREACHABLE), outcome)
    }

    @Test
    fun aPrinterThatNeverStopsTalkingIsNotReadWithoutLimit() {
        val endless = object : InputStream() {
            override fun read(): Int = 'x'.code
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                b.fill('x'.code.toByte(), off, off + len)
                return len
            }
        }
        assertEquals(4096, readStatusReply(endless) { false }.size)
    }
}
