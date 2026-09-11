package app.markiro.handheld

import android.content.ComponentName
import android.content.Context
import android.util.TypedValue
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The launch theme has to carry the brand on every release the fleet runs.
 *
 * Android's own `windowSplashScreen*` attributes exist only from API 31;
 * `core-splashscreen` declares its own under the app's package so the same
 * theme works further back. Spelling them in the `android:` namespace is the
 * easy mistake, and it fails silently -- older handhelds would show a blank
 * dark window and nothing would flag it. Resolving them under API 28 is what
 * catches that.
 *
 * This checks the resources, not the pixels: a real Android 9 device is still
 * the only thing that proves the splash actually appears.
 */
@RunWith(AndroidJUnit4::class)
class SplashThemeTest {
    @Test
    @Config(sdk = [28])
    fun theLaunchThemeCarriesTheBrandOnAndroid9() = assertBrandedLaunchTheme()

    @Test
    @Config(sdk = [33])
    fun theLaunchThemeCarriesTheBrandOnAndroid13() = assertBrandedLaunchTheme()

    private fun assertBrandedLaunchTheme() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val theme = context.resources.newTheme()
        theme.applyStyle(R.style.Theme_Markiro_Splash, true)

        assertEquals(
            "splash background",
            context.getColor(R.color.markiro_splash_background),
            theme.resolve(context, "windowSplashScreenBackground").data,
        )
        assertEquals(
            "splash icon",
            R.drawable.ic_splash_logo,
            theme.resolve(context, "windowSplashScreenAnimatedIcon").resourceId,
        )
        // Without this the activity would keep the splash theme after launch.
        assertEquals(
            "post-splash theme",
            R.style.Theme_Markiro,
            theme.resolve(context, "postSplashScreenTheme").resourceId,
        )
    }

    /** The manifest has to name the launch theme, or none of the above is reached. */
    @Test
    @Config(sdk = [28])
    fun theActivityLaunchesWithTheSplashTheme() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val activity = context.packageManager.getActivityInfo(
            ComponentName(context, MainActivity::class.java),
            0,
        )
        assertEquals(R.style.Theme_Markiro_Splash, activity.themeResource)
    }

    /**
     * By name rather than through the library's `R`: the attribute is merged
     * into this package at build time, which is exactly the thing under test.
     */
    private fun android.content.res.Resources.Theme.resolve(context: Context, attribute: String): TypedValue {
        val id = context.resources.getIdentifier(attribute, "attr", context.packageName)
        assertEquals("attribute $attribute is missing", true, id != 0)
        val value = TypedValue()
        assertEquals("attribute $attribute is unset", true, resolveAttribute(id, value, true))
        return value
    }
}
