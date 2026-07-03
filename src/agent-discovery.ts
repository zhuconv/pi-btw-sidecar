import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isNodeError } from "./config";

export type BtwAgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type BtwAgentDefinition = {
  name: string;
  description: string;
  systemPrompt: string;
  path: string;
  model?: string;
  thinkingLevel?: BtwAgentThinkingLevel;
  temperature?: number;
  color?: string;
};

const AGENT_DISCOVERY_CACHE_MAX_ENTRIES = 32;

const agentDirectoryCache = new Map<string, BtwAgentDefinition[]>();
const agentDirectoryInflightLoads = new Map<string, Promise<BtwAgentDefinition[]>>();

export function getDefaultBtwAgentsDir(): string {
  return join(getAgentDir(), "agents");
}

function getWorkspaceFallbackAgentsDir(): string {
  const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  return resolve(extensionRoot, "..", "..", "agents");
}

function cloneAgent(agent: BtwAgentDefinition): BtwAgentDefinition {
  return { ...agent };
}

function cloneAgents(agents: readonly BtwAgentDefinition[]): BtwAgentDefinition[] {
  return agents.map((agent) => cloneAgent(agent));
}

function rememberAgents(cacheKey: string, agents: BtwAgentDefinition[]): void {
  if (agentDirectoryCache.size >= AGENT_DISCOVERY_CACHE_MAX_ENTRIES) {
    const oldestKey = agentDirectoryCache.keys().next().value as string | undefined;
    if (oldestKey) {
      agentDirectoryCache.delete(oldestKey);
    }
  }

  agentDirectoryCache.set(cacheKey, cloneAgents(agents));
}

function extractBtwFrontmatter(rawContent: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const normalized = rawContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return null;
  }

  const frontmatterEnd = normalized.indexOf("\n---", 4);
  if (frontmatterEnd === -1) {
    return null;
  }

  const frontmatter: Record<string, unknown> = {};
  for (const line of normalized.slice(4, frontmatterEnd).split("\n")) {
    if (!line.trim() || /^\s/.test(line)) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key) {
      frontmatter[key] = value;
    }
  }

  return {
    frontmatter,
    body: normalized.slice(frontmatterEnd + 4).trim(),
  };
}

const VALID_BTW_THINKING_LEVELS = new Set<BtwAgentThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function getStringField(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeThinkingLevel(value: unknown): BtwAgentThinkingLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return VALID_BTW_THINKING_LEVELS.has(normalized as BtwAgentThinkingLevel)
    ? (normalized as BtwAgentThinkingLevel)
    : undefined;
}

function parseTemperature(value: unknown): number | undefined {
  const numericValue = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(numericValue)) {
    return undefined;
  }

  return numericValue;
}

export function parseBtwAgentMarkdown(rawContent: string, path = "<memory>"): BtwAgentDefinition | null {
  const parsed = extractBtwFrontmatter(rawContent);
  if (!parsed) {
    return null;
  }

  const name = getStringField(parsed.frontmatter, "name");
  const systemPrompt = parsed.body.trim();
  if (!name || !systemPrompt) {
    return null;
  }

  const result: BtwAgentDefinition = {
    name,
    description: getStringField(parsed.frontmatter, "description") || `Agent ${name}`,
    systemPrompt,
    path,
    model: getStringField(parsed.frontmatter, "model"),
    thinkingLevel: normalizeThinkingLevel(
      getStringField(parsed.frontmatter, "thinkingLevel") ||
        getStringField(parsed.frontmatter, "thinking") ||
        getStringField(parsed.frontmatter, "reasoningLevel") ||
        getStringField(parsed.frontmatter, "reasoningEffort") ||
        getStringField(parsed.frontmatter, "reasoningeffort") ||
        getStringField(parsed.frontmatter, "reasoning"),
    ),
    temperature: parseTemperature(parsed.frontmatter.temperature),
  };

  const color = getStringField(parsed.frontmatter, "color");
  if (color) {
    result.color = color;
  }

  return result;
}

async function readAgentFile(path: string): Promise<BtwAgentDefinition | null> {
  const raw = await readFile(path, "utf8");
  return parseBtwAgentMarkdown(raw, path);
}

async function loadAgentsFromDirectory(agentsDir: string): Promise<BtwAgentDefinition[]> {
  let entries;
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => join(agentsDir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  const loadedAgents = await Promise.all(
    markdownFiles.map(async (path) => {
      try {
        return await readAgentFile(path);
      } catch {
        return null;
      }
    }),
  );

  return loadedAgents
    .filter((agent): agent is BtwAgentDefinition => agent !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function discoverBtwAgentsInDirectory(agentsDir: string): Promise<BtwAgentDefinition[]> {
  const cacheKey = resolve(agentsDir);
  const cached = agentDirectoryCache.get(cacheKey);
  if (cached) {
    return cloneAgents(cached);
  }

  const existingLoad = agentDirectoryInflightLoads.get(cacheKey);
  if (existingLoad) {
    return cloneAgents(await existingLoad);
  }

  const load = loadAgentsFromDirectory(cacheKey).finally(() => {
    agentDirectoryInflightLoads.delete(cacheKey);
  });
  agentDirectoryInflightLoads.set(cacheKey, load);

  const agents = await load;
  rememberAgents(cacheKey, agents);
  return cloneAgents(agents);
}

export async function discoverBtwAgents(agentsDir = getDefaultBtwAgentsDir()): Promise<BtwAgentDefinition[]> {
  const agents = await discoverBtwAgentsInDirectory(agentsDir);
  if (agents.length > 0 || resolve(agentsDir) !== resolve(getDefaultBtwAgentsDir())) {
    return agents;
  }

  const fallbackAgentsDir = getWorkspaceFallbackAgentsDir();
  if (resolve(fallbackAgentsDir) === resolve(agentsDir)) {
    return agents;
  }

  return discoverBtwAgentsInDirectory(fallbackAgentsDir);
}

export async function findBtwAgentByName(name: string, agentsDir = getDefaultBtwAgentsDir()): Promise<BtwAgentDefinition | null> {
  const normalizedName = name.trim();
  if (!normalizedName) {
    return null;
  }

  const agents = await discoverBtwAgents(agentsDir);
  return agents.find((agent) => agent.name === normalizedName) ?? null;
}

export function resetBtwAgentDiscoveryCache(): void {
  agentDirectoryCache.clear();
  agentDirectoryInflightLoads.clear();
}
