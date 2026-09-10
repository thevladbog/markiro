package app.markiro.handheld.core.print

import android.Manifest
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertArrayEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
class BluetoothPermissionsTest {
    @Test
    @Config(sdk = [28])
    fun olderPlatformsAskForLocationBecauseDiscoveryNeedsIt() {
        assertArrayEquals(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION), bluetoothPermissions())
    }

    @Test
    @Config(sdk = [33])
    fun currentPlatformsAskForTheBluetoothPair() {
        assertArrayEquals(
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT),
            bluetoothPermissions(),
        )
    }
}
