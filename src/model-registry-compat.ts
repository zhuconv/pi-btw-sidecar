export type CompatibleModel = {
  provider: string;
  id: string;
  headers?: Record<string, string>;
};

export type ResolvedModelRequestAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
    }
  | { ok: false; error: string };

type UnknownMethod = (...args: unknown[]) => unknown;
type RegistryRecord = Record<PropertyKey, unknown>;

const registryAdapters = new WeakMap<object, object>();

function getMethod(registry: object, name: PropertyKey): UnknownMethod | undefined {
  const candidate = Reflect.get(registry, name, registry);
  return typeof candidate === "function" ? (candidate as UnknownMethod) : undefined;
}

function getStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeLegacyAuth(value: unknown): ResolvedModelRequestAuth {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "The model registry returned an invalid authentication result." };
  }

  const result = value as Record<string, unknown>;
  if (result.ok === false) {
    return { ok: false, error: typeof result.error === "string" ? result.error : "Model authentication failed." };
  }
  if (result.ok !== true) {
    return { ok: false, error: "The model registry returned an invalid authentication result." };
  }

  return {
    ok: true,
    apiKey: typeof result.apiKey === "string" ? result.apiKey : undefined,
    headers: getStringRecord(result.headers),
    env: getStringRecord(result.env),
  };
}

/**
 * Resolve credentials across the upstream Pi registry and OMP's newer registry.
 *
 * Pi 0.80 exposes getApiKeyAndHeaders(model). OMP 16.x exposes getApiKey(model)
 * and keeps static request headers on the model. A provider-only fallback covers
 * narrower registry facades without coupling this extension to either package.
 */
export async function resolveModelRequestAuth(
  registry: object,
  model: CompatibleModel,
): Promise<ResolvedModelRequestAuth> {
  const legacyResolver = getMethod(registry, "getApiKeyAndHeaders");
  if (legacyResolver) {
    try {
      return normalizeLegacyAuth(await legacyResolver.call(registry, model));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const modelResolver = getMethod(registry, "getApiKey");
  const providerResolver = getMethod(registry, "getApiKeyForProvider");
  const resolverFactory = getMethod(registry, "resolver");
  const resolver = modelResolver ?? providerResolver;
  if (!resolver && !resolverFactory) {
    return {
      ok: false,
      error:
        "This host does not expose a compatible model credential resolver. Expected getApiKeyAndHeaders(), getApiKey(), getApiKeyForProvider(), or resolver().",
    };
  }

  try {
    let value: unknown;
    if (modelResolver && resolver) {
      value = await resolver.call(registry, model);
    } else if (providerResolver && resolver) {
      value = await resolver.call(registry, model.provider);
    } else if (resolverFactory) {
      const apiKeyResolver = await resolverFactory.call(registry, model);
      value =
        typeof apiKeyResolver === "function"
          ? await (apiKeyResolver as UnknownMethod)({ lastChance: false, error: undefined })
          : apiKeyResolver;
    }

    return {
      ok: true,
      apiKey: typeof value === "string" ? value : undefined,
      headers: getStringRecord(model.headers),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Adapt OMP's registry to the older Pi AgentSession contract used by this package.
 * Existing Pi registries pass through unchanged. Proxy methods are bound to the
 * original target so registries implemented with private class fields keep working.
 */
export function adaptModelRegistryForAgentSession<TRegistry extends object>(registry: TRegistry): TRegistry {
  if (getMethod(registry, "getApiKeyAndHeaders")) {
    return registry;
  }

  const cached = registryAdapters.get(registry);
  if (cached) {
    return cached as TRegistry;
  }

  const adapter = new Proxy(registry as TRegistry & RegistryRecord, {
    get(target, property) {
      if (property === "getApiKeyAndHeaders") {
        return (model: CompatibleModel) => resolveModelRequestAuth(registry, model);
      }

      if (property === "isUsingOAuth" && !getMethod(registry, property)) {
        return () => false;
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  registryAdapters.set(registry, adapter);
  return adapter as TRegistry;
}
