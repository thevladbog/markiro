import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

/**
 * Release signing, from the environment or a gitignored `keystore.properties`.
 *
 * Absent on purpose in a normal checkout: `assembleDebug` and every CI gate run
 * without it, and `assembleRelease` then produces an unsigned APK rather than
 * failing. Only the release workflow supplies the material, so the key never
 * has to exist on a developer machine.
 */
val signingProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun signingValue(property: String, variable: String): String? =
    signingProperties.getProperty(property) ?: System.getenv(variable)

val releaseStoreFile = signingValue("storeFile", "MARKIRO_HANDHELD_STORE_FILE")

android {
    namespace = "app.markiro.handheld"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.markiro.handheld"
        minSdk = 28
        targetSdk = 35
        // Overridable by the release workflow: a store needs a monotonic code,
        // and the name is the tag it publishes under. The defaults keep every
        // local build and CI gate working without arguments.
        versionCode = (findProperty("markiro.versionCode") as String?)?.toInt() ?: 1
        versionName = (findProperty("markiro.versionName") as String?) ?: "0.1.0"
        // The edge proxies /station/*, /shifts and /products on the admin host to the API.
        buildConfigField("String", "SAAS_SERVER_URL", "\"https://admin.markiro.app\"")
        buildConfigField("boolean", "SERVER_URL_EDITABLE", "false")
        buildConfigField("boolean", "DEBUG_SCAN_SOURCE", "false")
    }

    signingConfigs {
        create("release") {
            if (releaseStoreFile != null) {
                storeFile = file(releaseStoreFile)
                storePassword = signingValue("storePassword", "MARKIRO_HANDHELD_STORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "MARKIRO_HANDHELD_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "MARKIRO_HANDHELD_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            buildConfigField("boolean", "SERVER_URL_EDITABLE", "true")
            buildConfigField("boolean", "DEBUG_SCAN_SOURCE", "true")
        }
        release {
            // Unsigned when the material is absent, which is what a checkout
            // without the key should produce -- not a build that fails.
            signingConfig = if (releaseStoreFile != null) signingConfigs.getByName("release") else null
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
    lint {
        // Both languages ship with every screen; a missing key in either file fails the gate.
        error += listOf("MissingTranslation", "ExtraTranslation")
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.hilt.android)
    implementation(libs.hilt.navigation.compose)
    ksp(libs.hilt.compiler)
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.retrofit)
    implementation(libs.retrofit.serialization)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.security.crypto)
    // Data Matrix symbol sizing, Reed-Solomon and module placement. The GS1
    // codeword framing around it is ours: no library provides it.
    implementation(libs.zxing.core)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.bouncycastle.bcprov) // overrides the vulnerable bcprov Robolectric pins, see the catalog
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.turbine)
}
