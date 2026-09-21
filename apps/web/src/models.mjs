/** Provider/model catalog projection for the composer model selector. Pure; no I/O. */

// settings.provider carries a few scalar siblings that are not concrete connections.
const RESERVED = new Set(["default", "model_context", "model_thinking"]);

export function configuredProviders(settings = {}) {
  const table =
    settings?.provider && typeof settings.provider === "object"
      ? settings.provider
      : {};
  return Object.entries(table)
    .filter(
      ([name, value]) =>
        !RESERVED.has(name) && value !== null && typeof value === "object",
    )
    .map(([name, value]) => ({
      name,
      defaultModel:
        typeof value.default_model === "string" ? value.default_model : "",
    }));
}

export function defaultProviderName(settings = {}) {
  const providers = configuredProviders(settings);
  const named = String(settings?.provider?.default || "");
  if (named && providers.some((provider) => provider.name === named))
    return named;
  return providers[0]?.name || "";
}

/** What the composer chip should show: session state wins, config defaults fill the gaps. */
export function effectiveSelection(
  settings = {},
  { provider = "", model = "" } = {},
) {
  const providers = configuredProviders(settings);
  const named = providers.find((entry) => entry.name === provider);
  const fallback = defaultProviderName(settings);
  const chosen = named || providers.find((entry) => entry.name === fallback);
  return {
    provider: chosen?.name || "",
    model: model || chosen?.defaultModel || "",
  };
}

/** Ordered unique model ids for one provider: the configured default first, then discovered ids. */
export function mergeModelIds(...lists) {
  const seen = new Set(),
    ids = [];
  for (const list of lists)
    for (const value of list || []) {
      const id = String(value || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  return ids;
}

/** Short label for a model id: strip common vendor prefixes so the chip stays compact. */
export function modelLabel(id = "") {
  const text = String(id || "").trim();
  if (!text) return "";
  const tail = text.split("/").at(-1);
  return tail || text;
}
