// TradeLock native Android app (Kotlin + Jetpack Compose). Talks to the same server as the web app
// (https://tradelock.in/api, session cookie, Server-Sent Events for live updates).
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.nexlogic.tradelock"
    compileSdk = 36

    defaultConfig {
        // Same app ID as the current (web view) app, so a release build installs as its upgrade.
        applicationId = "in.tradelock.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 100
        versionName = "2.0.0"
        buildConfigField("String", "BASE_URL", "\"https://tradelock.in\"")
        buildConfigField("String", "HOST", "\"tradelock.in\"")
    }
    buildFeatures { compose = true; buildConfig = true }

    signingConfigs {
        create("release") {
            // The same upload key as the current app (android/keystore.properties).
            val f = rootProject.file("../android/keystore.properties")
            if (f.exists()) {
                val p = Properties().apply { f.inputStream().use { load(it) } }
                storeFile = rootProject.file("../android/" + p.getProperty("storeFile"))
                storePassword = p.getProperty("storePassword")
                keyAlias = p.getProperty("keyAlias")
                keyPassword = p.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        debug {
            // Installs beside the current app while the native app is being built.
            applicationIdSuffix = ".dev"
            resValue("string", "app_name", "TradeLock β")
            // Google sign-in: the Android client for in.tradelock.app.dev + the debug key lives in the TradeLock (tradelock-prod) project.
            buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"748088450158-f08e7r694fnko24c4mt8anvi53luor44.apps.googleusercontent.com\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
            resValue("string", "app_name", "TradeLock")
            // in.tradelock.app + the release key are registered in the original sign-in project (as the current app); the server accepts both.
            buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"577485329686-agp3sata8iome8susa3vdpt5dgpeu9db.apps.googleusercontent.com\"")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    val bom = platform("androidx.compose:compose-bom:2025.08.00")
    implementation(bom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.animation:animation")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.compose.ui:ui-tooling-preview")

    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.2")
    implementation("androidx.navigation:navigation-compose:2.9.3")
    implementation("androidx.datastore:datastore-preferences:1.1.7")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    implementation("io.coil-kt:coil-compose:2.7.0")

    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    // QR sign-in on the web: Google's scanner screen (runs in Play services, so no camera permission here).
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
