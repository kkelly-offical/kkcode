package cn.kkcode.remote

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class SshStartupTest {
    @Test fun rememberedCredentialsAreBoundToTheExactConfirmedSshIdentity() {
        val profile = JSONObject().put("host", "one.example").put("port", 22).put("username", "alice").put("hostKey", "SHA256:confirmed")
        assertTrue(sshCredentialMatches(profile, JSONObject(profile.toString())))
        for((key, value) in listOf("host" to "other.example", "port" to 2222, "username" to "bob", "hostKey" to "SHA256:changed")) {
            assertFalse(sshCredentialMatches(profile, JSONObject(profile.toString()).put(key, value)))
        }
        assertFalse(sshCredentialMatches(JSONObject().put("password", "legacy-fixture"), profile))
    }
    @Test fun startupErrorsExplainScopeAndPortWithoutEchoingRemoteSecrets() {
        assertTrue(sshStartupError("SSH folder scope must match").contains("目录范围"))
        assertTrue(sshStartupError("SSH port must match").contains("服务端口"))
        assertFalse(sshStartupError("unexpected private diagnostic payload").contains("private diagnostic"))
    }
}
