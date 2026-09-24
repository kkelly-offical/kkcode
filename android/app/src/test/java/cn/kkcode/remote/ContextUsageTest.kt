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

    @Test fun strictAdmissionBoundIsNotPresentedAsMeasuredUsage() {
        val context = JSONObject().put("tokens", 360000).put("limit", 262144).put("source", "strict-upper-bound").put("estimated", true)
        assertTrue(contextSummary(context)!!.contains("100%"))
        assertTrue(contextSummary(context)!!.contains("保守上界"))
        assertTrue(contextExplanation(context).contains("不是模型实际 token 计数或计费值"))
        assertTrue(contextExplanation(context).contains("分项仍是估算"))
        context.put("source", "provider-usage")
        assertFalse(contextSummary(context)!!.contains("保守上界"))
        assertTrue(contextExplanation(context).contains("最近一次响应"))
        context.put("source", "count-api")
        assertTrue(contextExplanation(context).contains("当前请求的计数"))
    }
}
