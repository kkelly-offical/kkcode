import test, { afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  assertCredentialTransport,
  assertProviderOutboundAllowed,
  projectProviderControlReasons
} from "../src/provider/security.mjs"
import {
  clearModelCatalogMemoryCache,
  discoverModelsForProvider
} from "../src/provider/model-catalog.mjs"
import { requestProvider } from "../src/provider/router.mjs"
import { persistTrust, revokeTrust } from "../src/permission/workspace-trust.mjs"
import { trustFilePath } from "../src/storage/paths.mjs"

let workspace
let userHome

function projectState(provider) {
  return {
    config: {
      provider: {
        default: "custom",
        custom: provider
      }
    },
    source: {
      cwd: workspace,
      userRaw: {
        provider: {
          custom: {
            type: "openai-compatible",
            default_model: "test-model"
          }
        }
      },
      projectRaw: {
        provider: {
          custom: {
            base_url: provider.base_url,
            api_key_env: provider.api_key_env
          }
        }
      },
      envOverlay: {},
      envScope: null
    }
  }
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "kkcode-provider-project-"))
  userHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-provider-home-"))
  process.env.KKCODE_HOME = userHome
  clearModelCatalogMemoryCache()
})

afterEach(async () => {
  delete process.env.PROJECT_PROVIDER_KEY
  delete process.env.USER_PROVIDER_KEY
  delete process.env.KKCODE_HOME
  clearModelCatalogMemoryCache()
  await rm(workspace, { recursive: true, force: true })
  await rm(userHome, { recursive: true, force: true })
})

test("plain HTTP rejects credentials but permits an authless local endpoint", () => {
  assert.doesNotThrow(() => assertCredentialTransport({
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "",
    providerName: "local"
  }))
  assert.throws(
    () => assertCredentialTransport({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "test-credential",
      providerName: "local"
    }),
    (error) => error?.details?.reason === "insecure_transport"
  )
})

test("project-controlled provider routing is blocked until trust is stored outside the repository", async () => {
  const state = projectState({
    type: "openai-compatible",
    base_url: "https://project.example.test/v1",
    api_key_env: "PROJECT_PROVIDER_KEY",
    default_model: "test-model"
  })
  const reasons = projectProviderControlReasons(state, {
    providerName: "custom",
    protocol: "openai"
  })
  assert.ok(reasons.some((item) => item.endsWith(".base_url")))
  assert.ok(reasons.some((item) => item.endsWith(".api_key_env")))
  await assert.rejects(
    assertProviderOutboundAllowed(state, {
      providerName: "custom",
      protocol: "openai",
      operation: "provider inference"
    }),
    (error) => error?.details?.reason === "workspace_untrusted"
  )

  assert.equal(path.dirname(trustFilePath(workspace)).startsWith(workspace), false)
  await persistTrust(workspace)
  await assert.doesNotReject(assertProviderOutboundAllowed(state, {
    providerName: "custom",
    protocol: "openai",
    operation: "provider inference"
  }))
})

test("explicit runtime endpoint and credential overrides do not inherit project routing", async () => {
  const originalFetch = global.fetch
  let request = null
  global.fetch = async (url, options) => {
    request = { url: String(url), headers: options.headers }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }), { headers: { "content-type": "application/json" } })
  }
  process.env.PROJECT_PROVIDER_KEY = "project-key"
  process.env.USER_PROVIDER_KEY = "user-key"
  const state = projectState({
    type: "openai-compatible",
    base_url: "https://project.example.test/v1",
    api_key_env: "PROJECT_PROVIDER_KEY",
    default_model: "test-model",
    retry_attempts: 1
  })
  try {
    await assert.rejects(
      requestProvider({
        configState: state,
        providerType: "custom",
        system: "",
        messages: [{ role: "user", content: "hello" }],
        tools: []
      }),
      (error) => error?.details?.reason === "workspace_untrusted"
    )
    assert.equal(request, null)

    const result = await requestProvider({
      configState: state,
      providerType: "custom",
      baseUrl: "https://user.example.test/v1",
      apiKeyEnv: "USER_PROVIDER_KEY",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(result.text, "ok")
    assert.equal(request.url, "https://user.example.test/v1/chat/completions")
    assert.equal(request.headers.Authorization, "Bearer user-key")
  } finally {
    global.fetch = originalFetch
  }
})

test("model discovery rechecks trust before returning a previously populated cache", async () => {
  const originalFetch = global.fetch
  let requestCount = 0
  global.fetch = async () => {
    requestCount += 1
    return new Response(JSON.stringify({ data: [{ id: "cached-model" }] }), {
      headers: { "content-type": "application/json" }
    })
  }
  process.env.PROJECT_PROVIDER_KEY = "cache-key"
  const state = projectState({
    type: "openai-compatible",
    base_url: "https://cache.example.test/v1",
    api_key_env: "PROJECT_PROVIDER_KEY",
    default_model: "test-model"
  })
  try {
    await persistTrust(workspace)
    const populated = await discoverModelsForProvider(state, { now: 1000 })
    assert.equal(populated.source, "network")
    await revokeTrust(workspace)
    await assert.rejects(
      discoverModelsForProvider(state, { now: 2000 }),
      (error) => error?.details?.reason === "workspace_untrusted"
    )
    assert.equal(requestCount, 1)
  } finally {
    global.fetch = originalFetch
  }
})

test("a user-level env overlay is not treated as project-controlled", async () => {
  const state = {
    config: {
      provider: {
        default: "custom",
        custom: {
          type: "openai-compatible",
          base_url: "https://user.example.test/v1",
          api_key_env: "USER_PROVIDER_KEY"
        }
      }
    },
    source: {
      cwd: workspace,
      projectRaw: {},
      envScope: "user",
      envOverlay: {
        provider: {
          custom: {
            base_url: "https://user.example.test/v1",
            api_key_env: "USER_PROVIDER_KEY"
          }
        }
      }
    }
  }
  assert.deepEqual(projectProviderControlReasons(state, {
    providerName: "custom",
    protocol: "openai"
  }), [])
})
