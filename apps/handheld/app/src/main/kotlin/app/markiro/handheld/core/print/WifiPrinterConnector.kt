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

        /**
         * The raw printing port stands in for anything that is not a usable one. A port outside the
         * range reaches the socket as an `IllegalArgumentException`, which is not the `IOException`
         * the transport catches, so it would reach the operator as a crash instead of a refusal.
         */
        fun normalizePort(raw: String?): Int = raw?.toIntOrNull()?.takeIf { it in 1..65535 } ?: DEFAULT_PORT

        /** `host:port`, with the raw printing port assumed when none is given. */
        fun parseAddress(address: String): Pair<String, Int> {
            val separator = address.lastIndexOf(':')
            if (separator <= 0) return address to DEFAULT_PORT
            return address.substring(0, separator) to normalizePort(address.substring(separator + 1))
        }
    }
}
