package cn.kkcode.remote

import org.json.JSONObject

/** Missing metadata from older hosts is unknown, never proof of empty history. */
internal fun sessionHasVisibleContent(session: JSONObject): Boolean =
    session.optString("status").startsWith("running") || session.opt("hasContent") != false
