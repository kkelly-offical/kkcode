package cn.kkcode.remote

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TaskBudgetTest {
    private fun budget() = JSONObject().put("budgetUsd", 0).put("spentUsd", 0).put("reservedUsd", 0)
        .put("unknownUsd", 0).put("deadlineAt", 1900000000000L).put("hasUnknown", true)
    private fun quota() = JSONObject().put("maxRequests", 5).put("maxTokens", 10000000000L).put("usedRequests", 2).put("reservedTokens", 4000000000L)

    @Test fun ordinaryZeroBudgetDoesNotImplyFreeInference() {
        val parsed = TaskBudget.parse(budget())
        assertEquals(0.0, parsed.limit, 0.0); assertNull(parsed.localFree); assertTrue(parsed.hasUnknown)
    }

    @Test fun explicitLocalQuotaPreservesLongCumulativeTokenCountsAndZeroDollarUnknown() {
        val parsed = TaskBudget.parse(budget().put("localFree", quota()))
        assertEquals(TaskLocalFree(5, 10000000000L, 2, 4000000000L), parsed.localFree)
        assertEquals(0.0, parsed.unknown, 0.0); assertTrue(parsed.hasUnknown)
    }

    @Test fun localQuotaRejectsMalformedCountersOrPaidBudgetRatherThanSilentlyShowingUnlimitedFree() {
        for (invalid in listOf(quota().put("maxRequests", 0), quota().put("usedRequests", 6), quota().put("reservedTokens", 10000000001L),
            quota().put("maxTokens", "unlimited"), quota().put("reservedTokens", 0.5))) {
            assertTrue(runCatching { TaskBudget.parse(budget().put("localFree", invalid)) }.isFailure)
        }
        assertTrue(runCatching { TaskBudget.parse(budget().put("localFree", "free")) }.isFailure)
        assertTrue(runCatching { TaskBudget.parse(budget().put("budgetUsd", 1).put("localFree", quota())) }.isFailure)
    }
}
