import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getDefaultExtensionRoot, loadBtwConfig, type BtwConfigLoadResult } from "./config";

export type BtwDebugLogger = {
  log(event: string, details?: Record<string, unknown>): Promise<void>;
};

type BtwDebugLoggerOptions = {
  extensionRoot?: string;
  loadConfig?: (extensionRoot: string) => Promise<BtwConfigLoadResult>;
};

const DISABLED_LOGGER: BtwDebugLogger = {
  async log() {},
};

export function createBtwDebugLogger(options: BtwDebugLoggerOptions = {}): BtwDebugLogger {
  const extensionRoot = options.extensionRoot ?? getDefaultExtensionRoot();
  const loadConfigFn = options.loadConfig ?? loadBtwConfig;
  let initialized: Promise<BtwDebugLogger> | null = null;

  async function initialize(): Promise<BtwDebugLogger> {
    const { config } = await loadConfigFn(extensionRoot);
    if (!config.debug) {
      return DISABLED_LOGGER;
    }

    const debugDir = join(extensionRoot, "debug");
    const logPath = join(debugDir, "debug.log");
    await mkdir(debugDir, { recursive: true });

    return {
      async log(event: string, details: Record<string, unknown> = {}) {
        const entry = {
          timestamp: new Date().toISOString(),
          event,
          details,
        };
        await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
      },
    };
  }

  return {
    async log(event: string, details?: Record<string, unknown>) {
      initialized ??= initialize();
      const logger = await initialized;
      await logger.log(event, details);
    },
  };
}
