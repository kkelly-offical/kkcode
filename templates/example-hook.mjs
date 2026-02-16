export default {
  name: "example-log-hook",
  chat: {
    params(payload) {
      return payload
    },
    message(payload) {
      return payload
    },
    messagesTransform(payload) {
      return payload
    }
  },
  tool: {
    before(payload) {
      return payload
    },
    after(payload) {
      return payload
    }
  },
  async event(evt) {
    if (evt.type === "session.error") {
      console.error("[hook] session error:", evt.payload)
    }
  },
  session: {
    compacting(payload) {
      return payload
    }
  }
}
