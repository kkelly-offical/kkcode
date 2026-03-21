import test from "node:test"
import assert from "node:assert/strict"
import { buildProviderProbeReport } from "../src/provider/probe.mjs"

test("provider probe reports primary and fallback attempts with missing credentials", async () => {
  const report = await buildProviderProbeReport({
    configState: {
      config: {
        provider: {
          default: "openai",
          openai: {
            default_model: "gpt-5.3-codex",
            fallback_models: ["openrouter::openai/gpt-4.1-mini"]
          },
          openrouter: {
            type: "openai-compatible",
            default_model: "openai/gpt-4.1-mini"
          }
        }
      }
    },
    providerId: "openai",
    env: {}
  })

  assert.equal(report.providerId, "openai")
  assert.equal(report.attempts.length, 2)
  assert.equal(report.attempts[0].providerId, "openai")
  assert.equal(report.attempts[1].providerId, "openrouter")
  assert.equal(report.auth.interactiveLoginSupported, true)
  assert.match(report.warnings.join("\n"), /no ready credential source/)
})

test("provider probe reports env credential source when configured", async () => {
  const report = await buildProviderProbeReport({
    configState: {
      config: {
        provider: {
          default: "deepseek",
          deepseek: {
            default_model: "deepseek-chat",
            api_key_env: "DEEPSEEK_API_KEY"
          }
        }
      }
    },
    providerId: "deepseek",
    env: {
      DEEPSEEK_API_KEY: "secret"
    }
  })

  assert.equal(report.auth.credentialSource, "env:DEEPSEEK_API_KEY")
  assert.equal(report.warnings.length, 0)
})

test("provider probe warns when fallback target is not configured locally", async () => {
  const report = await buildProviderProbeReport({
    configState: {
      config: {
        provider: {
          default: "deepseek",
          deepseek: {
            default_model: "deepseek-chat",
            fallback_models: ["unknown-provider::model-x"]
          }
        }
      }
    },
    providerId: "deepseek",
    env: {}
  })

  assert.match(report.warnings.join("\n"), /fallback target "unknown-provider::model-x" is not configured locally/)
})

test("provider probe marks anthropic as oauth-compatible but not built-in interactive login", async () => {
  const report = await buildProviderProbeReport({
    configState: {
      config: {
        provider: {
          default: "anthropic",
          anthropic: {
            default_model: "claude-sonnet-4-5"
          }
        }
      }
    },
    providerId: "anthropic",
    env: {}
  })

  assert.equal(report.auth.interactiveLoginSupported, false)
  assert.match(report.warnings.join("\n"), /built-in interactive login is not implemented/)
})

test("provider probe reports chutes oauth refresh support", async () => {
  const report = await buildProviderProbeReport({
    configState: {
      config: {
        provider: {
          default: "chutes",
          chutes: {
            default_model: "zai-org/GLM-4.7-TEE"
          }
        }
      }
    },
    providerId: "chutes",
    env: {}
  })

  assert.equal(report.auth.interactiveLoginSupported, true)
  assert.equal(report.auth.refreshSupported, true)
})

test("provider probe marks amazon-bedrock runtime as unavailable", async () => {
  const report = await buildProviderProbeReport({
    configState: {
      config: {
        provider: {
          default: "amazon-bedrock",
          "amazon-bedrock": {
            default_model: "anthropic.claude-sonnet-4-5"
          }
        }
      }
    },
    providerId: "amazon-bedrock",
    env: {
      AWS_PROFILE: "default"
    }
  })

  assert.equal(report.runtimeAvailable, false)
  assert.match(report.warnings.join("\n"), /runtime "amazon-bedrock", but that runtime is not implemented/)
})
