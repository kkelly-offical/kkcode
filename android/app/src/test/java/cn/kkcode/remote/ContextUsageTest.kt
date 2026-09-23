package cn.kkcode.remote

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ContextUsageTest {
    @Test fun contextUsesCurrentWindowAndDistinguishesEstimatedData() {
        val context = JSONObject().put("tokens", 32000).put("limit", 64000).put("source", "estimated")
        assertTrue(contextSummary(context)!!.contains("50%"))
        assertTrue(contextSummary(context)!!.contains("估算"))
        context.put("source", "provider-usage")
        assertFalse(contextSummary(context)!!.contains("估算"))
        context.put("limit", 0)
        assertNull(contextSummary(context))
        assertNull(contextSummary(JSONObject()))
    }
}
