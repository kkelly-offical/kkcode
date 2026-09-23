package cn.kkcode.remote

import org.junit.Assert.*
import org.junit.Test

class SshStartupTest {
    @Test fun startupErrorsExplainScopeAndPortWithoutEchoingRemoteSecrets() {
        assertTrue(sshStartupError("SSH folder scope must match").contains("目录范围"))
        assertTrue(sshStartupError("SSH port must match").contains("服务端口"))
        assertFalse(sshStartupError("unexpected private diagnostic payload").contains("private diagnostic"))
    }
}
