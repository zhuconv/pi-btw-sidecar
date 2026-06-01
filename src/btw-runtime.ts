import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

const BTW_MESSAGE_TYPE = "btw-note";
const BTW_FOCUS_SHORTCUTS = ["alt+/", "ctrl+alt+w"] as const;
const BTW_COMMANDS = [
  {
    name: "btw",
    description: "Continue a side conversation in a focused BTW modal. Add --save to also persist a visible note.",
  },
  {
    name: "btw:tangent",
    description: "Start or continue a contextless BTW tangent in the focused BTW modal.",
  },
  {
    name: "btw:new",
    description: "Start a fresh BTW thread with main-session context. Optionally ask the first question immediately.",
  },
  {
    name: "btw:clear",
    description: "Dismiss the BTW modal/widget and clear the current thread.",
  },
  {
    name: "btw:inject",
    description: "Inject the full BTW thread into the main agent as a user message.",
  },
  {
    name: "btw:summarize",
    description: "Summarize the BTW thread, then inject the summary into the main agent.",
  },
  {
    name: "btw:agent",
    description: "Open the BTW agent picker, list agents, or select an agent by name.",
  },
  {
    name: "btw:model",
    description: "Show, set, or clear the BTW-only model override.",
  },
  {
    name: "btw:thinking",
    description: "Show, set, or clear the BTW-only thinking override.",
  },
] as const;

type RuntimeCommandName = (typeof BTW_COMMANDS)[number]["name"];
type CapturedCommand = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void };
type CapturedShortcut = { handler: (ctx: ExtensionContext) => Promise<void> | void };
type CapturedHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type BtwRuntimeDelegate = {
  commands: Map<string, CapturedCommand>;
  shortcuts: Map<string, CapturedShortcut>;
  handlers: Map<string, CapturedHandler[]>;
};

class BtwMessageComponent implements Component {
  readonly children: Array<{ text: string }>;

  constructor(text: string, private readonly theme: ExtensionContext["ui"]["theme"]) {
    this.children = [{ text }];
  }

  render(): string[] {
    return this.children[0]?.text.split(/\r?\n/).map((line) => this.theme.bg("customMessageBg", line)) ?? [];
  }

  invalidate(): void {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getNumericUsageField(usage: unknown, fieldNames: string[]): number | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }

  for (const fieldName of fieldNames) {
    const value = usage[fieldName];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function formatBtwUsage(usage: unknown): string | null {
  const input = getNumericUsageField(usage, ["input", "inputTokens", "promptTokens", "prompt_tokens"]);
  const output = getNumericUsageField(usage, ["output", "outputTokens", "completionTokens", "completion_tokens"]);
  const cacheRead = getNumericUsageField(usage, ["cacheRead", "cache_read", "cachedTokens", "cached_tokens"]);
  const cacheWrite = getNumericUsageField(usage, ["cacheWrite", "cache_write"]);
  const total =
    getNumericUsageField(usage, ["totalTokens", "total", "total_tokens"]) ??
    (input !== undefined || output !== undefined || cacheRead !== undefined || cacheWrite !== undefined
      ? (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
      : undefined);

  if (input === undefined && output === undefined && total === undefined) {
    return null;
  }

  return `tokens: in ${input ?? "?"} · out ${output ?? "?"} · total ${total ?? "?"}`;
}

function isVisibleBtwMessage(message: { role: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === BTW_MESSAGE_TYPE;
}

function createBtwMessageComponent(lines: string[], theme: ExtensionContext["ui"]["theme"]): Component {
  return new BtwMessageComponent(lines.join("\n"), theme);
}

async function createBtwRuntimeDelegate(pi: ExtensionAPI): Promise<BtwRuntimeDelegate> {
  const commands = new Map<string, CapturedCommand>();
  const shortcuts = new Map<string, CapturedShortcut>();
  const handlers = new Map<string, CapturedHandler[]>();

  const proxy = new Proxy(pi as unknown as Record<PropertyKey, unknown>, {
    get(target, property, receiver) {
      if (property === "registerCommand") {
        return (name: string, options: CapturedCommand) => {
          commands.set(name, options);
        };
      }

      if (property === "registerShortcut") {
        return (shortcut: string, options: CapturedShortcut) => {
          shortcuts.set(shortcut, options);
        };
      }

      if (property === "registerMessageRenderer") {
        return () => {};
      }

      if (property === "on") {
        return (event: string, handler: CapturedHandler) => {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as ExtensionAPI;

  const runtimeModule = await import("./btw-runtime-core.js");
  await runtimeModule.default(proxy);

  return { commands, shortcuts, handlers };
}

async function dispatchRuntimeEvent(
  runtimePromise: Promise<BtwRuntimeDelegate>,
  eventName: string,
  event: unknown,
  ctx: ExtensionContext,
): Promise<unknown[]> {
  const runtime = await runtimePromise;
  const results: unknown[] = [];
  for (const handler of runtime.handlers.get(eventName) ?? []) {
    results.push(await handler(event, ctx));
  }
  return results;
}

export default function (pi: ExtensionAPI) {
  let runtimePromise: Promise<BtwRuntimeDelegate> | null = null;

  const getRuntime = () => {
    runtimePromise ??= createBtwRuntimeDelegate(pi);
    return runtimePromise;
  };

  const dispatchCommand = async (name: RuntimeCommandName, args: string, ctx: ExtensionCommandContext) => {
    const runtime = await getRuntime();
    const command = runtime.commands.get(name);
    if (!command) {
      throw new Error(`BTW runtime did not register command: ${name}`);
    }

    await command.handler(args, ctx);
  };

  pi.registerMessageRenderer(BTW_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as
      | { provider: string; model: string; api?: string; thinkingLevel: string; usage?: unknown }
      | undefined;
    const content = typeof message.content === "string" ? message.content : "[non-text btw message]";
    const lines = [theme.fg("accent", theme.bold("[BTW]")), content];

    if (expanded && details) {
      lines.push(
        theme.fg(
          "dim",
          `model: ${details.provider}/${details.model} (${details.api ?? "openai-responses"}) · thinking: ${details.thinkingLevel}`,
        ),
      );

      const usageText = formatBtwUsage(details.usage);
      if (usageText) {
        lines.push(theme.fg("dim", usageText));
      }
    }

    return createBtwMessageComponent(lines, theme);
  });

  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((message) => !isVisibleBtwMessage(message)),
    };
  });

  pi.on("session_start", async (event, ctx) => {
    await dispatchRuntimeEvent(getRuntime(), "session_start", event, ctx);
  });

  pi.on("session_tree", async (event, ctx) => {
    await dispatchRuntimeEvent(getRuntime(), "session_tree", event, ctx);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (!runtimePromise) {
      return;
    }

    await dispatchRuntimeEvent(runtimePromise, "session_shutdown", event, ctx);
  });

  for (const shortcut of BTW_FOCUS_SHORTCUTS) {
    pi.registerShortcut(shortcut, {
      description: "Toggle BTW overlay focus while leaving it open.",
      handler: async (ctx) => {
        const runtime = await getRuntime();
        const captured = runtime.shortcuts.get(shortcut);
        if (!captured) {
          throw new Error(`BTW runtime did not register shortcut: ${shortcut}`);
        }

        await captured.handler(ctx);
      },
    });
  }

  for (const command of BTW_COMMANDS) {
    pi.registerCommand(command.name, {
      description: command.description,
      handler: async (args, ctx) => {
        await dispatchCommand(command.name, args, ctx);
      },
    });
  }
}
