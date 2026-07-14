export const ASIDE_COMMAND_NAME = "aside";

export const ASIDE_COMMAND_DESCRIPTION =
  "Continue a side conversation. Subcommands: new, tangent, clear, inject, inject-select, summarize, agent, model, thinking.";

export const ASIDE_SUBCOMMANDS = [
  "tangent",
  "new",
  "clear",
  "inject",
  "inject-select",
  "summarize",
  "agent",
  "model",
  "thinking",
] as const;

export type AsideSubcommand = (typeof ASIDE_SUBCOMMANDS)[number];
export type BtwRuntimeCommandName = "btw" | `btw:${AsideSubcommand}`;

export type ParsedAsideCommand = {
  name: BtwRuntimeCommandName;
  args: string;
};

function isAsideSubcommand(value: string): value is AsideSubcommand {
  return (ASIDE_SUBCOMMANDS as readonly string[]).includes(value);
}

export function parseAsideCommandArgs(args: string): ParsedAsideCommand {
  const trimmed = args.trim();
  if (!trimmed) {
    return { name: "btw", args: "" };
  }

  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const candidate = match?.[1] ?? "";
  if (!isAsideSubcommand(candidate)) {
    return { name: "btw", args: trimmed };
  }

  return {
    name: `btw:${candidate}`,
    args: match?.[2]?.trim() ?? "",
  };
}

export function parseAsideSlashCommand(value: string): ParsedAsideCommand | null {
  const match = value.trim().match(/^\/aside(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }

  return parseAsideCommandArgs(match[1] ?? "");
}
