import { Command } from "commander"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import YAML from "yaml"
import { buildContext } from "../context.mjs"
import {
  getAuthProfile,
  listAuthProfiles,
  removeAuthProfile,
  resolveAuthProfileCredential,
  resolveAuthProfileStatus,
  setDefaultAuthProfile,
  upsertAuthProfile
} from "../provider/auth-profiles.mjs"
import { requestGitHubDeviceCode, pollGitHubAccessToken } from "../provider/github-copilot-auth.mjs"
import { buildProviderEntryFromCatalog, getProviderSpec, listCatalogProviders } from "../provider/catalog.mjs"
import {
  pollMiniMaxPortalAccessToken,
  refreshMiniMaxPortalToken,
  requestMiniMaxPortalCode
} from "../provider/minimax-portal-auth.mjs"
import {
  beginProviderOAuth,
  clearPendingOAuthSession,
  importProviderOAuthCallback,
  loadPendingOAuthSession
} from "../provider/oauth-manager.mjs"
import { buildProviderProbeReport } from "../provider/probe.mjs"
import { pollQwenPortalAccessToken, refreshQwenPortalToken, requestQwenPortalDeviceCode } from "../provider/qwen-portal-auth.mjs"
import { validateConfig } from "../config/schema.mjs"
import { projectConfigCandidates } from "../storage/paths.mjs"

function parseHeaderEntries(values = []) {
  const headers = {}
  for (const raw of values) {
    const value = String(raw || "")
    const idx = value.indexOf("=")
    if (idx <= 0) {
      throw new Error(`invalid header "${value}" (expected name=value)`)
    }
    const name = value.slice(0, idx).trim()
    const headerValue = value.slice(idx + 1).trim()
    if (!name) throw new Error(`invalid header "${value}" (missing name)`)
    headers[name] = headerValue
  }
  return headers
}

function maskSecret(value) {
  const raw = String(value || "")
  if (!raw) return ""
  if (raw.length <= 8) return "*".repeat(raw.length)
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`
}

export function redactAuthProfile(profile, { reveal = false } = {}) {
  if (reveal) return profile
  return {
    ...profile,
    credential: maskSecret(profile.credential),
    accessToken: maskSecret(profile.accessToken),
    refreshToken: maskSecret(profile.refreshToken)
  }
}

function printProfiles(profiles) {
  if (!profiles.length) {
    console.log("no auth profiles configured")
    return
  }
  for (const profile of profiles) {
    const status = resolveAuthProfileStatus(profile)
    const source = profile.credentialEnv
      ? `env:${profile.credentialEnv}`
      : resolveAuthProfileCredential(profile)
        ? "stored"
        : "missing"
    console.log(
      [
        profile.id,
        profile.providerId,
        profile.authMode,
        status,
        profile.isDefault ? "default" : "secondary",
        source,
        profile.displayName
      ].join("\t")
    )
  }
}

export function redactAuthProfiles(profiles, options = {}) {
  return Array.isArray(profiles)
    ? profiles.map((profile) => redactAuthProfile(profile, options))
    : []
}

function printProbeReport(report) {
  console.log(`provider: ${report.providerId} (${report.label})`)
  console.log(`configured: ${report.configured ? "yes" : "no"}`)
  console.log(`runtime: ${report.runtimeType}`)
  console.log(`model: ${report.model || "(unset)"}`)
  console.log(`base_url: ${report.baseUrl || "(unset)"}`)
  console.log(`auth modes: ${(report.authModes || []).join("/")}`)
  console.log(`oauth: ${report.supportsOAuth ? "yes" : "no"}`)
  console.log(
    `active auth: ${report.auth.profileId || "(none)"} mode=${report.auth.mode || "-"} state=${report.auth.readyState} source=${report.auth.credentialSource}`
  )
  if (report.auth.expiresAt) {
    console.log(`auth expires_at: ${new Date(report.auth.expiresAt).toISOString()}`)
  }
  console.log(
    `interactive_login: ${report.auth.interactiveLoginSupported ? "yes" : "no"} refresh: ${report.auth.refreshSupported ? "yes" : "no"}`
  )
  console.log("attempt chain:")
  for (const attempt of report.attempts) {
    console.log(
      `  - ${attempt.source} ${attempt.providerId}::${attempt.model} runtime=${attempt.runtimeType} auth=${attempt.authReadyState} source=${attempt.credentialSource} base_url=${attempt.baseUrl || "(unset)"}`
    )
  }
  if (report.warnings.length) {
    console.log("warnings:")
    for (const warning of report.warnings) console.log(`  - ${warning}`)
  }
}

function parseConfigInput(file, raw) {
  if (file.endsWith(".json")) return JSON.parse(raw)
  return YAML.parse(raw)
}

function stringifyConfigOutput(file, data) {
  if (file.endsWith(".json")) return JSON.stringify(data, null, 2) + "\n"
  return YAML.stringify(data)
}

async function ensureProjectDefaultProvider(providerId, cwd = process.cwd()) {
  const candidates = projectConfigCandidates(cwd)
  let configPath = null
  for (const candidate of candidates) {
    try {
      await readFile(candidate, "utf8")
      configPath = candidate
      break
    } catch {
      // keep scanning
    }
  }
  if (!configPath) {
    configPath = candidates[0]
    await mkdir(path.dirname(configPath), { recursive: true })
  }

  let existing = {}
  try {
    const raw = await readFile(configPath, "utf8")
    existing = parseConfigInput(configPath, raw) || {}
  } catch {
    existing = {}
  }

  if (!existing.provider) existing.provider = {}
  if (!existing.provider[providerId]) {
    existing.provider[providerId] = buildProviderEntryFromCatalog(providerId) || {}
  }
  existing.provider.default = providerId

  const check = validateConfig(existing)
  if (!check.valid) {
    throw new Error(`unable to set default provider: ${check.errors.join("; ")}`)
  }

  await writeFile(configPath, stringifyConfigOutput(configPath, existing), "utf8")
  return configPath
}

async function loginProviderInteractive(provider, options = {}) {
  if (provider === "github-copilot") {
    const device = await requestGitHubDeviceCode({ scope: "read:user" })
    const accessToken = await pollGitHubAccessToken({
      deviceCode: device.device_code,
      intervalMs: Math.max(1000, Number(device.interval || 5) * 1000),
      expiresAt: Date.now() + Number(device.expires_in || 900) * 1000
    })
    const id = await upsertAuthProfile({
      providerId: provider,
      displayName: options.name || "GitHub Copilot",
      authMode: "token",
      credential: accessToken,
      isDefault: true
    })
    return {
      kind: "profile",
      providerId: provider,
      profileId: id,
      openUrl: device.verification_uri,
      userCode: device.user_code
    }
  }

  if (provider === "qwen-portal") {
    const device = await requestQwenPortalDeviceCode()
    const tokenSet = await pollQwenPortalAccessToken(device)
    const id = await upsertAuthProfile({
      providerId: provider,
      displayName: options.name || "Qwen Portal",
      authMode: "oauth",
      credential: tokenSet.accessToken,
      accessToken: tokenSet.accessToken,
      refreshToken: tokenSet.refreshToken,
      expiresAt: tokenSet.expiresAt,
      isDefault: true
    })
    return {
      kind: "profile",
      providerId: provider,
      profileId: id,
      openUrl: device.verificationUri,
      userCode: device.userCode || ""
    }
  }

  if (provider === "minimax-portal") {
    const device = await requestMiniMaxPortalCode({ region: options.region || "global" })
    const tokenSet = await pollMiniMaxPortalAccessToken(device)
    const id = await upsertAuthProfile({
      providerId: provider,
      displayName: options.name || `MiniMax Portal${options.region === "cn" ? " CN" : ""}`,
      authMode: "oauth",
      credential: tokenSet.accessToken,
      accessToken: tokenSet.accessToken,
      refreshToken: tokenSet.refreshToken,
      baseUrlOverride: tokenSet.baseUrl || "",
      expiresAt: tokenSet.expiresAt,
      isDefault: true
    })
    return {
      kind: "profile",
      providerId: provider,
      profileId: id,
      openUrl: device.verificationUri,
      userCode: device.userCode
    }
  }

  const spec = getProviderSpec(provider)
  if (spec?.supports_oauth) {
    const pending = await beginProviderOAuth({
      providerId: provider,
      authUrl: options.authUrl || "",
      clientId: options.clientId || "",
      tokenUrl: options.tokenUrl || "",
      scopes: Array.isArray(options.scope) ? options.scope : []
    })
    return {
      kind: "pending_oauth",
      providerId: provider,
      authUrl: pending.authUrl,
      state: pending.state,
      redirectUri: pending.redirectUri,
      importCommand: `kkcode auth import-callback ${provider} --url '<callback-url>'${options.name ? ` --name '${options.name}'` : ""}`
    }
  }

  throw new Error(`interactive login is not implemented for provider: ${provider}`)
}

export async function verifyProviderAuth({ providerId, cwd = process.cwd() } = {}) {
  const ctx = await buildContext({ cwd })
  const report = await buildProviderProbeReport({
    configState: ctx.configState,
    providerId,
    model: null
  })
  const primaryAttempt = Array.isArray(report.attempts) && report.attempts.length ? report.attempts[0] : null
  const ready = (
    (report.auth.readyState === "ready" && report.auth.credentialSource !== "missing")
    || (primaryAttempt && primaryAttempt.credentialSource !== "missing")
  )
  return { report, ready }
}

export async function runProviderOnboarding({
  providerId,
  cwd = process.cwd(),
  login = true,
  setDefault = true,
  loginOptions = {}
} = {}) {
  const before = await verifyProviderAuth({ providerId, cwd })
  const result = {
    providerId,
    before: before.report,
    after: before.report,
    ready: before.ready,
    defaultProviderPath: null,
    login: null,
    nextSteps: []
  }

  if (setDefault) {
    result.defaultProviderPath = await ensureProjectDefaultProvider(providerId, cwd)
  }

  if (!before.ready && login) {
    try {
      result.login = await loginProviderInteractive(providerId, loginOptions)
      if (result.login.kind === "profile") {
        const after = await verifyProviderAuth({ providerId, cwd })
        result.after = after.report
        result.ready = after.ready
      } else {
        result.after = (await verifyProviderAuth({ providerId, cwd })).report
        result.ready = false
        result.nextSteps.push(result.login.importCommand)
      }
    } catch (error) {
      result.login = {
        kind: "error",
        message: error.message
      }
      result.ready = false
    }
  } else {
    result.ready = before.ready
  }

  if (!result.ready && result.nextSteps.length === 0) {
    const spec = getProviderSpec(providerId)
    if (spec?.supports_oauth) {
      result.nextSteps.push(`kkcode auth login ${providerId}`)
    } else {
      const envName = result.after?.attempts?.[0]?.credentialSource?.startsWith("env:")
        ? result.after.attempts[0].credentialSource.slice(4)
        : (buildProviderEntryFromCatalog(providerId)?.api_key_env || "")
      if (envName) result.nextSteps.push(`export ${envName}=...`)
    }
  }

  return result
}

export function createAuthCommand() {
  const cmd = new Command("auth").description("manage provider auth profiles")

  cmd
    .command("providers")
    .description("list provider auth capabilities from the catalog")
    .option("--json", "print structured json", false)
    .action(async (options) => {
      const providers = listCatalogProviders()
        .map((spec) => ({
          id: spec.id,
          label: spec.label,
          type: spec.type,
          model: spec.default_model,
          authModes: spec.auth_modes || ["api_key"],
          supportsOAuth: spec.supports_oauth === true,
          oauthFlow: spec.oauth_flow || "browser",
          authDocsUrl: spec.auth_docs_url || ""
        }))
        .sort((a, b) => a.id.localeCompare(b.id, "en"))
      if (options.json) {
        console.log(JSON.stringify(providers, null, 2))
        return
      }
      for (const provider of providers) {
        console.log(
          [
            provider.id,
            provider.label,
            provider.type,
            provider.model,
            provider.authModes.join("/"),
            provider.supportsOAuth ? provider.oauthFlow : "no-oauth",
            provider.authDocsUrl || "-"
          ].join("\t")
        )
      }
    })

  cmd
    .command("list")
    .description("list configured auth profiles")
    .argument("[provider]", "optional provider id filter")
    .option("--json", "print structured json", false)
    .action(async (provider, options) => {
      const profiles = await listAuthProfiles({ providerId: provider || null })
      if (options.json) {
        console.log(JSON.stringify(redactAuthProfiles(profiles), null, 2))
        return
      }
      printProfiles(profiles)
    })

  cmd
    .command("add")
    .description("add or update an auth profile")
    .argument("<provider>", "provider id, e.g. openai or deepseek")
    .requiredOption("--name <name>", "display name")
    .option("--id <id>", "update an existing profile id")
    .option("--mode <mode>", "api_key|token|oauth", "api_key")
    .option("--credential <value>", "credential value to store")
    .option("--credential-env <env>", "read credential from this environment variable at runtime")
    .option("--access-token <value>", "oauth access token")
    .option("--refresh-token <value>", "oauth refresh token")
    .option("--base-url <url>", "override base url when this profile is active")
    .option("--header <name=value>", "extra request header", [])
    .option("--default", "mark as default for this provider", false)
    .option("--expires-at <timestamp>", "unix timestamp in milliseconds")
    .action(async (provider, options) => {
      if (options.credential && options.credentialEnv) {
        throw new Error("use either --credential or --credential-env, not both")
      }
      const headers = parseHeaderEntries(options.header)
      const id = await upsertAuthProfile({
        id: options.id || undefined,
        providerId: provider,
        displayName: options.name,
        authMode: options.mode,
        credential: options.credential || "",
        credentialEnv: options.credentialEnv || "",
        accessToken: options.accessToken || "",
        refreshToken: options.refreshToken || "",
        baseUrlOverride: options.baseUrl || "",
        headers,
        expiresAt: options.expiresAt ? Number(options.expiresAt) : null,
        isDefault: options.default === true
      })
      console.log(id)
    })

  cmd
    .command("login")
    .description("interactive oauth/device login for supported providers")
    .argument("<provider>", "provider id")
    .option("--name <name>", "display name override")
    .option("--auth-url <url>", "browser OAuth authorize URL override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--token-url <url>", "OAuth token endpoint override")
    .option("--scope <scope>", "OAuth scope (repeatable)", [])
    .option("--region <region>", "oauth region for provider-specific flows", "global")
    .action(async (provider, options) => {
      const result = await loginProviderInteractive(provider, options)
      if (result.openUrl) console.log(`open: ${result.openUrl}`)
      if (result.userCode) console.log(`code: ${result.userCode}`)
      if (result.kind === "pending_oauth") {
        console.log(`open: ${result.authUrl}`)
        console.log(`state: ${result.state}`)
        console.log(`redirect_uri: ${result.redirectUri}`)
        console.log("then import callback with:")
        console.log(result.importCommand)
        return
      }
      console.log(result.profileId)
    })

  cmd
    .command("verify")
    .description("verify whether a provider currently has a ready auth path")
    .argument("<provider>", "provider id")
    .option("--json", "print structured json", false)
    .action(async (provider, options) => {
      const result = await verifyProviderAuth({ providerId: provider })
      if (options.json) {
        console.log(JSON.stringify({ ready: result.ready, report: result.report }, null, 2))
        if (!result.ready) process.exitCode = 1
        return
      }
      printProbeReport(result.report)
      console.log(`verified: ${result.ready ? "ready" : "not-ready"}`)
      if (!result.ready) process.exitCode = 1
    })

  cmd
    .command("onboard")
    .description("continuous provider onboarding: detect auth, login, verify, set default")
    .argument("<provider>", "provider id")
    .option("--name <name>", "display name override")
    .option("--auth-url <url>", "browser OAuth authorize URL override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--token-url <url>", "OAuth token endpoint override")
    .option("--scope <scope>", "OAuth scope (repeatable)", [])
    .option("--region <region>", "oauth region for provider-specific flows", "global")
    .option("--no-login", "do not start login automatically when auth is missing")
    .option("--no-set-default", "do not set this provider as the project default")
    .option("--json", "print structured json", false)
    .action(async (provider, options) => {
      const result = await runProviderOnboarding({
        providerId: provider,
        cwd: process.cwd(),
        login: options.login !== false,
        setDefault: options.setDefault !== false,
        loginOptions: {
          name: options.name || "",
          authUrl: options.authUrl || "",
          clientId: options.clientId || "",
          tokenUrl: options.tokenUrl || "",
          scope: Array.isArray(options.scope) ? options.scope : [],
          region: options.region || "global"
        }
      })
      if (options.json) {
        console.log(JSON.stringify(result, null, 2))
        if (!result.ready) process.exitCode = 1
        return
      }
      console.log(`provider: ${provider}`)
      console.log(`before: ${result.before.auth.readyState} source=${result.before.auth.credentialSource}`)
      if (result.defaultProviderPath) {
        console.log(`set_default: ${result.defaultProviderPath}`)
      }
      if (result.login?.kind === "profile") {
        if (result.login.openUrl) console.log(`open: ${result.login.openUrl}`)
        if (result.login.userCode) console.log(`code: ${result.login.userCode}`)
        console.log(`profile: ${result.login.profileId}`)
      }
      if (result.login?.kind === "error") {
        console.log(`login_error: ${result.login.message}`)
      }
      if (result.login?.kind === "pending_oauth") {
        console.log(`open: ${result.login.authUrl}`)
        console.log(`state: ${result.login.state}`)
        console.log(`redirect_uri: ${result.login.redirectUri}`)
      }
      console.log(`after: ${result.after.auth.readyState} source=${result.after.auth.credentialSource}`)
      console.log(`verified: ${result.ready ? "ready" : "not-ready"}`)
      for (const step of result.nextSteps) {
        console.log(`next: ${step}`)
      }
      if (!result.ready) process.exitCode = 1
    })

  cmd
    .command("import-callback")
    .description("import a browser OAuth callback URL into an auth profile")
    .argument("<provider>", "provider id")
    .requiredOption("--url <callbackUrl>", "callback URL containing token/code")
    .option("--name <name>", "display name override")
    .action(async (provider, options) => {
      const existing = (await listAuthProfiles({ providerId: provider }))[0] || null
      const imported = await importProviderOAuthCallback({
        providerId: provider,
        callbackUrl: options.url
      })
      const id = await upsertAuthProfile({
        id: existing?.id || undefined,
        providerId: provider,
        displayName: options.name || existing?.displayName || `${getProviderSpec(provider)?.label || provider} OAuth`,
        authMode: "oauth",
        credential: imported.accessToken,
        accessToken: imported.accessToken,
        refreshToken: imported.refreshToken,
        expiresAt: imported.expiresAt,
        isDefault: true
      })
      await clearPendingOAuthSession()
      console.log(id)
    })

  cmd
    .command("pending-oauth")
    .description("show the currently pending browser OAuth session")
    .option("--clear", "clear the pending session", false)
    .action(async (options) => {
      if (options.clear) {
        await clearPendingOAuthSession()
        console.log("pending oauth cleared")
        return
      }
      const pending = await loadPendingOAuthSession()
      if (!pending) {
        console.log("no pending oauth session")
        return
      }
      console.log(JSON.stringify(pending, null, 2))
    })

  cmd
    .command("probe")
    .description("inspect effective provider/auth/fallback runtime state")
    .argument("<provider>", "provider id")
    .option("--model <model>", "override primary model for probe")
    .option("--json", "print structured json", false)
    .action(async (provider, options) => {
      const ctx = await buildContext()
      const report = await buildProviderProbeReport({
        configState: ctx.configState,
        providerId: provider,
        model: options.model || null
      })
      if (options.json) {
        console.log(JSON.stringify(report, null, 2))
        return
      }
      const spec = getProviderSpec(provider)
      if (!report.configured && !spec) {
        throw new Error(`unknown provider: ${provider}`)
      }
      printProbeReport(report)
    })

  cmd
    .command("refresh")
    .description("refresh an oauth auth profile when the provider supports it")
    .argument("<profileId>", "profile id")
    .action(async (profileId) => {
      const profile = await getAuthProfile(profileId)
      if (!profile) {
        throw new Error(`auth profile not found: ${profileId}`)
      }
      if (profile.providerId === "qwen-portal") {
        const tokenSet = await refreshQwenPortalToken({ refreshToken: profile.refreshToken })
        await upsertAuthProfile({
          ...profile,
          authMode: "oauth",
          credential: tokenSet.accessToken,
          accessToken: tokenSet.accessToken,
          refreshToken: tokenSet.refreshToken,
          expiresAt: tokenSet.expiresAt,
          isDefault: profile.isDefault
        })
        console.log(profileId)
        return
      }
      if (profile.providerId === "minimax-portal") {
        const region = profile.baseUrlOverride?.includes("minimaxi.com") ? "cn" : "global"
        const tokenSet = await refreshMiniMaxPortalToken({
          refreshToken: profile.refreshToken,
          region
        })
        await upsertAuthProfile({
          ...profile,
          authMode: "oauth",
          credential: tokenSet.accessToken,
          accessToken: tokenSet.accessToken,
          refreshToken: tokenSet.refreshToken,
          baseUrlOverride: tokenSet.baseUrl || profile.baseUrlOverride || "",
          expiresAt: tokenSet.expiresAt,
          isDefault: profile.isDefault
        })
        console.log(profileId)
        return
      }
      throw new Error(`oauth refresh is not implemented for provider: ${profile.providerId}`)
    })

  cmd
    .command("remove")
    .description("remove an auth profile")
    .argument("<profileId>", "profile id")
    .action(async (profileId) => {
      const removed = await removeAuthProfile(profileId)
      if (!removed) {
        throw new Error(`auth profile not found: ${profileId}`)
      }
      console.log(profileId)
    })

  cmd
    .command("default")
    .description("set the default auth profile for a provider")
    .argument("<provider>", "provider id")
    .argument("<profileId>", "profile id")
    .action(async (provider, profileId) => {
      const ok = await setDefaultAuthProfile(provider, profileId)
      if (!ok) {
        throw new Error(`auth profile ${profileId} is not configured for provider ${provider}`)
      }
      console.log(profileId)
    })

  cmd
    .command("show")
    .description("show one auth profile")
    .argument("<profileId>", "profile id")
    .option("--reveal", "print stored credentials without masking", false)
    .action(async (profileId, options) => {
      const profile = await getAuthProfile(profileId)
      if (!profile) {
        throw new Error(`auth profile not found: ${profileId}`)
      }
      console.log(JSON.stringify(redactAuthProfile(profile, { reveal: options.reveal === true }), null, 2))
    })

  return cmd
}
