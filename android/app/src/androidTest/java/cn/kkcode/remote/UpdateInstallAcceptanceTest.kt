package cn.kkcode.remote

import android.app.Application
import android.content.Context
import android.os.Bundle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File

/** Opt-in on a disposable, explicitly provisioned signed-release AVD. Neither
 * the APK fixture nor a signing key is bundled with the application/tests. */
class UpdateInstallAcceptanceTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun fixture(): JSONObject {
        assumeTrue(InstrumentationRegistry.getArguments().getString("updaterAcceptance") == "true")
        return JSONObject(File(instrumentation.targetContext.filesDir, "updater-fixture.json").readText())
    }
    private fun stage(name: String) { instrumentation.sendStatus(2, Bundle().apply { putString("updateStage", name) }) }
    @Test fun installSignedUpdateThroughTheRealSystemConfirmation() = runBlocking<Unit> {
        val data = fixture()
        val app = ApplicationProvider.getApplicationContext<Application>()
        val apk = File(app.filesDir, "updater-target.apk")
        require(apk.isFile)
        app.getSharedPreferences("kkcode.ui", Context.MODE_PRIVATE).edit().putBoolean("autoConnect", false).putString("appearance", "light").commit()
        app.getSharedPreferences("kkcode.updates", Context.MODE_PRIVATE).edit().clear().commit()
        CredentialVault(app).put("updater-acceptance-sentinel", "preserve-across-signed-update")
        val manifest = data.getJSONObject("manifest")
        val version = manifest.getString("versionName")
        val tag = "v$version"
        val fileName = manifest.getJSONObject("apk").getString("name")
        val policy = UpdatePolicy()
        val release = JSONObject().put("tag_name", tag).put("draft", false).put("prerelease", version.contains('-')).put("body", "Private updater acceptance artifact; never published.")
            .put("assets", JSONArray().put(JSONObject().put("name", "android-update.json").put("size", manifest.toString().toByteArray().size).put("browser_download_url", policy.assetUrl(tag, "android-update.json")))
                .put(JSONObject().put("name", fileName).put("size", apk.length()).put("browser_download_url", policy.assetUrl(tag, fileName))))
        val source = GitHubUpdateSource(transport = UpdateTransport { url ->
            if(url.endsWith(".apk")) object : UpdateBody { override val stream = apk.inputStream(); override val length = apk.length(); override fun close() { stream.close() } }
            else { val bytes = (if(url.contains("api.github.com")) JSONArray().put(release).toString() else manifest.toString()).toByteArray(); object : UpdateBody { override val stream = ByteArrayInputStream(bytes); override val length = bytes.size.toLong(); override fun close() { stream.close() } } }
        })
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val updater = AppUpdater(app, scope, source)
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            withContext(Dispatchers.Main) { updater.check(true) }
            withTimeout(15000) { while(updater.phase == UpdatePhase.CHECKING) delay(50) }
            assertEquals(UpdatePhase.AVAILABLE, updater.phase)
            withContext(Dispatchers.Main) { updater.download() }
            withTimeout(120000) { while(updater.phase == UpdatePhase.DOWNLOADING) delay(50) }
            assertEquals(updater.message, UpdatePhase.READY, updater.phase)
            stage("verified")
            scenario.onActivity { updater.install(it) }
            if(!app.packageManager.canRequestPackageInstalls()) {
                stage("permission")
                withTimeout(120000) { while(!app.packageManager.canRequestPackageInstalls()) delay(100) }
                scenario.onActivity { updater.install(it) }
            }
            stage("confirmation")
            // Installing this app intentionally terminates its instrumentation
            // process. The host harness verifies the new installed code/data.
            withTimeout(120000) { while(true) { if(updater.phase == UpdatePhase.ERROR) error(updater.message); delay(250) } }
        } finally { scope.cancel(); scenario.close() }
    }
    @Test fun updatedApplicationRetainsPrivateSettingsAndKeystoreData() {
        val data = fixture()
        val context = instrumentation.targetContext
        val installed = context.packageManager.getPackageInfo(context.packageName, 0)
        assertEquals(data.getJSONObject("manifest").getLong("versionCode"), installed.longVersionCode)
        assertEquals("light", context.getSharedPreferences("kkcode.ui", Context.MODE_PRIVATE).getString("appearance", null))
        assertEquals("preserve-across-signed-update", CredentialVault(context).get("updater-acceptance-sentinel"))
        stage("retained")
    }
}
