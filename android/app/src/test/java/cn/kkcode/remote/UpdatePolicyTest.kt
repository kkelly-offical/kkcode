package cn.kkcode.remote

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

internal val updateTestHash = "a".repeat(64)
internal val updateTestCert = "b".repeat(64)
internal fun updateTestPolicy() = UpdatePolicy("owner/repo", updateTestCert, "cn.kkcode.remote")
internal fun updateTestRelease(version: String = "1.0.2", size: Long = 3) = GitHubRelease("v$version", version.contains('-'), "Release notes", mapOf("android-update.json" to 512, "kkcode-android-$version.apk" to size))
internal fun updateTestManifest(version: String = "1.0.2", code: Long = 10005, size: Long = 3, hash: String = updateTestHash): JSONObject = JSONObject()
    .put("schemaVersion", 1).put("applicationId", "cn.kkcode.remote").put("versionName", version).put("versionCode", code).put("minSdk", 29)
    .put("channel", if(version.contains('-')) "preview" else "stable").put("protocolVersion", "1")
    .put("apk", JSONObject().put("name", "kkcode-android-$version.apk").put("size", size).put("sha256", hash).put("certificateSha256", updateTestCert))
internal fun updateTestReleaseJson(version: String = "1.0.2", size: Long = 3): JSONObject = JSONObject().put("tag_name", "v$version").put("draft", false).put("prerelease", version.contains('-')).put("body", "Notes")
    .put("assets", org.json.JSONArray().put(JSONObject().put("name", "android-update.json").put("size", 512).put("browser_download_url", "https://github.com/owner/repo/releases/download/v$version/android-update.json"))
        .put(JSONObject().put("name", "kkcode-android-$version.apk").put("size", size).put("browser_download_url", "https://github.com/owner/repo/releases/download/v$version/kkcode-android-$version.apk")))

class UpdatePolicyTest {
    @Test fun stableAndPreviewChannelsNeverTrustDraftsOrUnrelatedAssets() {
        val stable = updateTestReleaseJson(); val preview = updateTestReleaseJson("1.0.2-preview.0"); val draft = updateTestReleaseJson("1.0.3").put("draft", true)
        val data = org.json.JSONArray().put(stable).put(preview).put(draft).toString()
        assertEquals(listOf("v1.0.2"), updateTestPolicy().releases(data, UpdateChannel.STABLE).map { it.tag })
        assertEquals(2, updateTestPolicy().releases(data, UpdateChannel.PREVIEW).size)
        assertTrue(updateTestPolicy().releases("[{\"tag_name\":\"v1.0.4\"}]", UpdateChannel.PREVIEW).isEmpty())
    }
    @Test fun validManifestBindsTheTagPackageHashCertificateAndAssetSize() {
        val value = updateTestPolicy().manifest(updateTestManifest().toString(), updateTestRelease())
        assertEquals(10005, value.versionCode.toInt())
        assertEquals("https://github.com/owner/repo/releases/download/v1.0.2/kkcode-android-1.0.2.apk", value.downloadUrl)
        assertEquals(updateTestCert, value.certificateSha256)
    }
    @Test fun invalidMetadataIsRejectedWithoutCoercingStringsOrBooleansToVersions() {
        val mutations: List<(JSONObject) -> Unit> = listOf(
            { it.put("versionCode", "10005") }, { it.put("versionCode", true) }, { it.put("versionCode", 2100000001L) }, { it.put("versionCode", 10005.1) },
            { it.put("versionName", "1.0.3") }, { it.put("channel", "preview") }, { it.put("applicationId", "evil.app") }, { it.put("protocolVersion", "2") },
            { it.put("minSdk", 0) }, { it.put("schemaVersion", 2) },
            { it.getJSONObject("apk").put("name", "../evil.apk") }, { it.getJSONObject("apk").put("sha256", "not-a-hash") },
            { it.getJSONObject("apk").put("certificateSha256", "c".repeat(64)) }, { it.getJSONObject("apk").put("size", 4) }, { it.getJSONObject("apk").put("size", MAX_UPDATE_BYTES + 1) }
        )
        for(mutate in mutations) { val manifest = updateTestManifest(); mutate(manifest); assertThrows(IllegalArgumentException::class.java) { updateTestPolicy().manifest(manifest.toString(), updateTestRelease()) } }
    }
    @Test fun releaseAssetsCannotRedirectTheInitialRequestOutsideTheFixedRepository() {
        val row = updateTestReleaseJson(); row.getJSONArray("assets").getJSONObject(0).put("browser_download_url", "https://evil.invalid/android-update.json")
        assertThrows(IllegalArgumentException::class.java) { updateTestPolicy().releases(org.json.JSONArray().put(row).toString(), UpdateChannel.STABLE) }
        val duplicate = updateTestReleaseJson(); duplicate.getJSONArray("assets").put(duplicate.getJSONArray("assets").getJSONObject(0))
        assertThrows(IllegalArgumentException::class.java) { updateTestPolicy().releases(org.json.JSONArray().put(duplicate).toString(), UpdateChannel.STABLE) }
    }
    @Test fun redirectsAreHttpsOnlyAndLimitedToGitHubAssetHosts() {
        for(url in listOf("https://api.github.com/repos/owner/repo/releases", "https://release-assets.githubusercontent.com/a?sig=public-download", "https://objects.githubusercontent.com/a")) assertTrue(trustedUpdateTransportUrl(url))
        for(url in listOf("http://github.com/a", "https://github.com.evil.invalid/a", "https://user:pass@github.com/a", "https://github.com:8443/a", "file:///tmp/a", "https://127.0.0.1/a", "https://github.com/a#fragment")) assertFalse(trustedUpdateTransportUrl(url))
    }
    @Test fun metadataByteAndDepthLimitsApplyBeforeParsing() {
        assertThrows(IllegalArgumentException::class.java) { checkUpdateJson("x".repeat(1025), 1024) }
        assertThrows(IllegalArgumentException::class.java) { checkUpdateJson("[".repeat(33) + "]".repeat(33), 1024) }
        assertEquals("{\"text\":\"[[[[\"}", checkUpdateJson("{\"text\":\"[[[[\"}", 1024))
    }
    @Test fun archiveChecksRejectDowngradeDebugWrongPackageOrWrongSigningIdentity() {
        val update = updateTestPolicy().manifest(updateTestManifest().toString(), updateTestRelease())
        val installed = UpdateArchive("cn.kkcode.remote", "1.0.1", 10004, setOf(updateTestCert), false)
        val valid = UpdateArchive(installed.packageName, update.versionName, update.versionCode, installed.signers, false)
        assertUpdateArchive(update, valid, installed)
        for(archive in listOf(valid.copy(packageName = "evil.app"), valid.copy(versionCode = 10004), valid.copy(versionName = "1.0.3"), valid.copy(debuggable = true), valid.copy(signers = setOf("c".repeat(64))), valid.copy(signers = emptySet()))) assertThrows(IllegalArgumentException::class.java) { assertUpdateArchive(update, archive, installed) }
        assertThrows(IllegalArgumentException::class.java) { assertUpdateArchive(update, valid, installed.copy(signers = setOf("d".repeat(64)))) }
    }
}
