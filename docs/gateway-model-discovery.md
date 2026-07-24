# Gateway and model discovery

KK Code 0.3.3 can read a model catalog from the Base URL configured by the
user. It does not silently replace a failed catalog request with a built-in
model list.

## Configuration

Use `type: gateway` when one service exposes an OpenAI-compatible or
Anthropic-compatible API:

```yaml
provider:
  default: company-gateway
  company-gateway:
    type: gateway
    protocol: openai # or anthropic
    base_url: https://gateway.example.com
    endpoints:
      openai: /v1
      anthropic: /anthropic/v1
      models: /v1/models
    api_key_env: KK_GATEWAY_API_KEY
    default_model: model-id-from-the-catalog
    discovery:
      enabled: true
      cache_ttl_ms: 900000
```

`endpoints.openai` and `endpoints.anthropic` may be absolute URLs or paths
relative to `base_url`. `endpoints.models` may be absolute or relative to the
selected protocol endpoint (a leading `/` still resolves from the origin
root). KK Code sends credentials only to the configured origin and rejects
cross-origin redirects and pagination links during model discovery.

Provider URLs or credential selectors supplied by a project configuration or
project `.env` are not used until that workspace is trusted. User-level
configuration and explicit CLI overrides remain available. Any connection that
carries credentials must use HTTPS; an authentication-free HTTP endpoint is
allowed for local development services.

If the service has one conventional API root, omit `endpoints`; KK Code reads
`<base_url>/models`.

## Commands

```bash
kkcode model list --provider company-gateway --refresh
kkcode model test --provider company-gateway --model model-id
kkcode model test --provider company-gateway --model model-id --probe
```

`model test` validates the live catalog. It performs inference only when
`--probe` is present; the probe requests at most one output token and may be
billable.

Catalog results are cached for 15 minutes by default. If a refresh fails, an
existing cache is marked stale and reported explicitly. For a deliberately
offline configuration, set `discovery.enabled: false` and provide your own
`models` array.

## Request identity and audit

Provider and catalog requests use the `KK-Code/<version>` user agent, a KK Code
request ID, provider/protocol identity, and—for OpenAI-compatible requests—an
`X-Client-Request-Id`. Audit entries contain correlation metadata, timing,
status, and usage; prompts and model output are represented only by length and
SHA-256 metadata.

Branch review creates one umbrella trace. Its model requests, permission
decision, optional GitHub publication, waiver, and final gate result can be
queried together with `--trace` or `--review`. Candidate credentials are
redacted from review diffs before model inference.

```bash
kkcode audit list --provider company-gateway --since 2h
kkcode audit verify
kkcode audit export --format jsonl --provider company-gateway
```
