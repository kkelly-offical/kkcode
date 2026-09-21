import java.util.Properties
import java.nio.file.FileSystems
import java.nio.file.Files

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}
// Release identity is provisioned outside the checkout. Never fall back to debug signing.
val releaseProperties = Properties()
val releasePropertiesPath = System.getenv("KKCODE_ANDROID_SIGNING_PROPERTIES")
if (!releasePropertiesPath.isNullOrBlank()) {
    val source = file(releasePropertiesPath)
    require(source.isFile) { "Android signing properties file is missing" }
    source.inputStream().use { releaseProperties.load(it) }
}
fun signingValue(name: String, environment: String): String? = System.getenv(environment)?.takeIf { it.isNotBlank() } ?: releaseProperties.getProperty(name)?.takeIf { it.isNotBlank() }
fun signingPassword(name: String, environment: String): String? = signingValue(name, environment)?.let { path ->
    val source = file(path)
    require(source.isFile) { "Android signing password file is missing" }
    if (FileSystems.getDefault().supportedFileAttributeViews().contains("posix")) {
        require(Files.getPosixFilePermissions(source.toPath()).none { it.name.startsWith("GROUP_") || it.name.startsWith("OTHERS_") }) { "Android signing password files must be private (0600)" }
    }
    source.readText().trimEnd('\r', '\n')
}
val releaseStore = signingValue("storeFile", "KKCODE_ANDROID_KEYSTORE")
val releaseAlias = signingValue("keyAlias", "KKCODE_ANDROID_KEY_ALIAS")
val releaseStorePassword = signingPassword("storePasswordFile", "KKCODE_ANDROID_STORE_PASSWORD_FILE")
val releaseKeyPassword = signingPassword("keyPasswordFile", "KKCODE_ANDROID_KEY_PASSWORD_FILE")
val releaseSigningReady = listOf(releaseStore, releaseAlias, releaseStorePassword, releaseKeyPassword).all { !it.isNullOrBlank() }
android {
    namespace = "cn.kkcode.remote"
    compileSdk = 35
    defaultConfig {
        applicationId = "cn.kkcode.remote"
        minSdk = 29
        targetSdk = 35
        versionCode = 10001
        versionName = "1.0.1-preview.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildFeatures { compose = true; buildConfig = true }
    signingConfigs {
        if (releaseSigningReady) create("projectRelease") {
            storeFile = file(releaseStore!!)
            keyAlias = releaseAlias
            storePassword = releaseStorePassword
            keyPassword = releaseKeyPassword
            enableV1Signing = false
            enableV2Signing = true
            enableV3Signing = true
        }
    }
    buildTypes {
        getByName("release") {
            isDebuggable = false
            if (releaseSigningReady) signingConfig = signingConfigs.getByName("projectRelease")
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    packaging { resources.excludes += setOf("META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*", "META-INF/versions/**/OSGI-INF/MANIFEST.MF") }
}
tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    doFirst { check(releaseSigningReady) { "Release signing is required. Set KKCODE_ANDROID_SIGNING_PROPERTIES to an external private configuration; debug signing is never used for release." } }
}
dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.06.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.hierynomus:sshj:0.40.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.80.2")
    implementation("org.bouncycastle:bcpkix-jdk18on:1.80.2")
    implementation("io.noties.markwon:core:4.6.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.06.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
