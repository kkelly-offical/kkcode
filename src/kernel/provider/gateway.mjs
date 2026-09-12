import { requestAnthropic, requestAnthropicStream, countTokensAnthropic } from "./anthropic.mjs"
import { requestOpenAI, requestOpenAIStream, countTokensOpenAI } from "./openai.mjs"
import { ProviderError } from "../core/errors.mjs"

function implementationFor(protocol) {
  if (protocol === "openai") {
    return {
      request: requestOpenAI,
      requestStream: requestOpenAIStream,
      countTokens: countTokensOpenAI
    }
  }
  if (protocol === "anthropic") {
    return {
      request: requestAnthropic,
      requestStream: requestAnthropicStream,
      countTokens: countTokensAnthropic
    }
  }
  throw new ProviderError(`gateway protocol must be "openai" or "anthropic", received: ${protocol || "(missing)"}`, {
    provider: "gateway",
    reason: "protocol_error"
  })
}

export async function requestGateway(input) {
  return implementationFor(input.protocol).request(input)
}

export async function* requestGatewayStream(input) {
  yield* implementationFor(input.protocol).requestStream(input)
}

export async function countTokensGateway(input) {
  return implementationFor(input.protocol).countTokens(input)
}
