# R8 keep rules.
#
# Everything here exists because the thing it protects fails at RUNTIME, not at
# build time: a green `assembleRelease` and a green unit suite say nothing about
# whether these survived. Removing a rule is a change that has to be walked
# through on a terminal.

# kotlinx.serialization resolves serializers reflectively by companion.
-if @kotlinx.serialization.Serializable class **
-keepclassmembers class <1> {
    static <1>$Companion Companion;
}
-keepclasseswithmembers class **$$serializer { *; }
-keepclassmembers @kotlinx.serialization.Serializable class * {
    *** Companion;
    *** serializer(...);
}

# Room generates implementations it then loads by name.
-keep class * extends androidx.room.RoomDatabase { <init>(); }
-keep @androidx.room.Entity class * { *; }
-dontwarn androidx.room.paging.**

# OkHttp/Okio ship platform shims for JVMs this app never runs on.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# The wire shapes: renamed fields would silently change the JSON the server
# parses, and the server's schema is strict.
-keepclassmembers class app.markiro.handheld.core.network.** { *; }
-keepclassmembers class app.markiro.handheld.core.sync.** { *; }
-keepclassmembers class app.markiro.handheld.core.update.UpdateManifest { *; }

# Tink (androidx.security.crypto, which holds the device credential) references
# Error Prone annotations that are compile-time only.
-dontwarn com.google.errorprone.annotations.**
