package app.markiro.handheld.core.print

import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import javax.inject.Inject

/** A printer standing at the line, reached over the network on its raw printing port. */
class WifiPrinterConnector @Inject constructor() : PrinterConnector {
    override suspend fun open(printer: PrinterEntity): PrinterConnection {
        val (host, port) = parseAddress(printer.address)
        val socket = Socket()
        socket.soTimeout = PRINTER_TIMEOUT_MS
        socket.connect(InetSocketAddress(host, port), PRINTER_TIMEOUT_MS)
        return object : PrinterConnection {
            override val input: InputStream = socket.getInputStream()
            override val output: OutputStream = socket.getOutputStream()
            override fun close() = socket.close()
        }
    }

    companion object {
        const val DEFAULT_PORT = 9100

        /** `host:port`, with the raw printing port assumed when none is given. */
        fun parseAddress(address: String): Pair<String, Int> {
            val separator = address.lastIndexOf(':')
            if (separator <= 0) return address to DEFAULT_PORT
            val port = address.substring(separator + 1).toIntOrNull() ?: return address to DEFAULT_PORT
            return address.substring(0, separator) to port
        }
    }
}
