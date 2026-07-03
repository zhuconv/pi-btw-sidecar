import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./record-utils";

export type BtwModalSize = "small" | "medium" | "large";

export type BtwConfig = {
  enabled: boolean;
  debug: boolean;
  showReasoning: boolean;
  modalSize: BtwModalSize;
};

export type BtwConfigLoadResult = {
  config: BtwConfig;
  diagnostics: string[];
};

export const DEFAULT_CONFIG: BtwConfig = {
  enabled: true,
  debug: false,
  showReasoning: true,
  modalSize: "medium",
};

const MODAL_SIZES = new Set<BtwModalSize>(["small", "medium", "large"]);

export function getDefaultExtensionRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function loadBtwConfig(extensionRoot = getDefaultExtensionRoot()): Promise<BtwConfigLoadResult> {
  const configPath = join(extensionRoot, "config.json");

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const diagnostics: string[] = [];
    const config: BtwConfig = { ...DEFAULT_CONFIG };

    if (!isRecord(parsed)) {
      return {
        config,
        diagnostics: [`${configPath}: expected BTW config to be a JSON object.`],
      };
    }

    if (parsed.enabled !== undefined) {
      if (typeof parsed.enabled === "boolean") {
        config.enabled = parsed.enabled;
      } else {
        diagnostics.push(`${configPath}: expected optional "enabled" to be a boolean.`);
      }
    }

    if (parsed.debug !== undefined) {
      if (typeof parsed.debug === "boolean") {
        config.debug = parsed.debug;
      } else {
        diagnostics.push(`${configPath}: expected optional \"debug\" to be a boolean.`);
      }
    }

    if (parsed.showReasoning !== undefined) {
      if (typeof parsed.showReasoning === "boolean") {
        config.showReasoning = parsed.showReasoning;
      } else {
        diagnostics.push(`${configPath}: expected optional \"showReasoning\" to be a boolean.`);
      }
    }

    if (parsed.modalSize !== undefined) {
      if (typeof parsed.modalSize === "string" && MODAL_SIZES.has(parsed.modalSize as BtwModalSize)) {
        config.modalSize = parsed.modalSize as BtwModalSize;
      } else {
        diagnostics.push(`${configPath}: expected optional \"modalSize\" to be one of: small, medium, large.`);
      }
    }

    return { config, diagnostics };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { config: { ...DEFAULT_CONFIG }, diagnostics: [] };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      config: { ...DEFAULT_CONFIG },
      diagnostics: [`${configPath}: failed to read BTW config (${message}).`],
    };
  }
}

/**
 * Synchronously reads only the `enabled` flag from config.json.
 * Used at factory load time to skip all registration when the extension is disabled.
 */
export function isBtwConfigEnabledSync(extensionRoot = getDefaultExtensionRoot()): boolean {
  const configPath = join(extensionRoot, "config.json");
  if (!existsSync(configPath)) {
    return true;
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return true;
    }
    return parsed.enabled !== false;
  } catch {
    return true;
  }
}
