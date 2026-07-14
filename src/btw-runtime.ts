import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { ASIDE_COMMAND_DESCRIPTION, ASIDE_COMMAND_NAME } from "./aside-command";
import { formatBtwUsage } from "./btw-usage";
import { isBtwConfigEnabledSync } from "./config";

const BTW_MESSAGE_TYPE = "btw-note";
const BTW_FOCUS_SHORTCUTS = ["alt+/", "ctrl+alt+w"] as const;
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

      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value.bind(target) as unknown) : value;
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

export default function btwRuntime(pi: ExtensionAPI) {
  if (!isBtwConfigEnabledSync()) {
    return;
  }

  let runtimePromise: Promise<BtwRuntimeDelegate> | null = null;

  const getRuntime = () => {
    runtimePromise ??= createBtwRuntimeDelegate(pi);
    return runtimePromise;
  };

  const dispatchCommand = async (args: string, ctx: ExtensionCommandContext) => {
    const runtime = await getRuntime();
    const command = runtime.commands.get(ASIDE_COMMAND_NAME);
    if (!command) {
      throw new Error(`BTW runtime did not register command: ${ASIDE_COMMAND_NAME}`);
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

  pi.registerCommand(ASIDE_COMMAND_NAME, {
    description: ASIDE_COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      await dispatchCommand(args, ctx);
    },
  });
}
