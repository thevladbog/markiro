package app.markiro.handheld.core.print

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.os.Build
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import javax.inject.Inject

/** A printer offered by the platform, either already paired or newly found. */
data class DiscoveredPrinter(val address: String, val name: String, val bonded: Boolean)

/**
 * The permissions Bluetooth needs on this platform version. Asking for the wrong set does not fail
 * loudly: the device list simply comes back empty.
 */
fun bluetoothPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

/**
 * A printer worn on the belt, reached over the serial port profile.
 *
 * No emulator has a Bluetooth radio, so this class is verified on hardware only. Everything that
 * decides what an outcome means lives in `StreamPrinterTransport` instead, where it is tested.
 */
class BluetoothPrinterConnector @Inject constructor(
    @ApplicationContext private val context: Context,
) : PrinterConnector {

    private val adapter: BluetoothAdapter?
        get() = context.getSystemService(BluetoothManager::class.java)?.adapter

    /** Devices the platform already knows. Pairing itself happens in the system dialog. */
    @SuppressLint("MissingPermission")
    fun pairedPrinters(): List<DiscoveredPrinter> =
        adapter?.bondedDevices.orEmpty().map { device ->
            DiscoveredPrinter(device.address, device.name ?: device.address, bonded = true)
        }

    @SuppressLint("MissingPermission")
    override suspend fun open(printer: PrinterEntity): PrinterConnection {
        val adapter = adapter ?: throw IOException("bluetooth unavailable")
        val socket = try {
            val socket = adapter.getRemoteDevice(printer.address).createRfcommSocketToServiceRecord(SPP)
            // Discovery keeps the radio busy and makes a connection attempt fail slowly.
            adapter.cancelDiscovery()
            socket.connect()
            socket
        } catch (e: SecurityException) {
            // The connect permission can be withdrawn between adding this printer and using it. The
            // connector contract is `IOException`; anything else escapes the transport's catch and
            // reaches the operator as a crash rather than as a printer that refused.
            throw IOException("bluetooth permission missing", e)
        } catch (e: IllegalArgumentException) {
            // A stored row can outlive the device it names, and a malformed address throws here.
            throw IOException("not a bluetooth address: ${printer.address}", e)
        }
        return object : PrinterConnection {
            override val input: InputStream = socket.inputStream
            override val output: OutputStream = socket.outputStream
            override fun close() = socket.close()
        }
    }

    private companion object {
        /** The serial port profile, which is what label printers expose. */
        val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    }
}
