package cn.kkcode.remote

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ConfigurationDiagnosticsTest {
    @Test fun olderDevicesAndValidConfigDoNotShowEmptyWarnings() {
        assertTrue(configurationDiagnosticLines(JSONObject()).isEmpty())
        assertTrue(configurationDiagnosticLines(JSONObject().put("_diagnostics", JSONObject().put("errorCount", 0).put("warningCount", 0))).isEmpty())
    }
    @Test fun permissionErrorExplainsTheFieldAndExecutionBlock() {
        val error = JSONObject().put("source", "用户配置").put("field", "permission.default_policy").put("message", "请手动迁移；原文件未修改")
        val settings = JSONObject().put("_diagnostics", JSONObject().put("errorCount", 1).put("toolsBlocked", true).put("errors", JSONArray().put(error)))
        val lines = configurationDiagnosticLines(settings)
        assertTrue(lines.first().contains("工具执行已暂停"))
        assertTrue(lines.last().contains("permission.default_policy"))
        assertTrue(lines.last().contains("原文件未修改"))
    }
    @Test fun warningsAreBoundedAndMalformedEntriesDoNotCrashTheSheet() {
        val settings = JSONObject().put("_diagnostics", JSONObject().put("errorCount", 1).put("errors", JSONArray().put("bad").put(JSONObject().put("message", "x".repeat(10000)))).put("warningCount", 1).put("warning", "api_key=fixture-private-value"))
        val lines = configurationDiagnosticLines(settings)
        assertTrue(lines.all { it.length < 1000 })
        assertFalse(lines.joinToString().contains("fixture-private-value"))
    }
}
