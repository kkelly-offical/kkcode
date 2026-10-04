package cn.kkcode.remote

internal fun companionMood(connected: Boolean, stopping: Boolean, approval: Boolean, busy: Boolean, phase: String, activity: String, readOnly: Boolean, outcome: String, celebrate: Boolean): String = when {
    !connected -> "offline"
    stopping -> "stopping"
    approval -> "approval"
    busy && phase == "waiting_children" -> "waiting"
    busy && activity == "thinking" -> "thinking"
    busy && activity == "assistant" -> "writing"
    busy -> "working"
    outcome == "error" -> "error"
    outcome == "cancelled" -> "stopped"
    celebrate -> "complete"
    readOnly -> "readonly"
    else -> "idle"
}

internal fun companionLabel(mood: String): String = when(mood) {
    "offline" -> "等待连接"; "stopping" -> "正在停止"; "approval" -> "等你确认一下"
    "waiting" -> "等待伙伴的汇报"; "thinking" -> "正在认真思考"; "writing" -> "正在整理回答"
    "working" -> "正在动手做事"; "error" -> "遇到问题，看看提示"; "stopped" -> "已停下，陪你待命"
    "complete" -> "本轮已结束"; "readonly" -> "只读陪伴"; else -> "准备好，一起开工"
}
