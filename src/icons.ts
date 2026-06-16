import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type BtwIconMode = "nerd" | "unicode" | "emoji" | "fallback";
export type BtwIconPreference = "auto" | BtwIconMode;

export type BtwIconSet = {
  agents: string;
  session: string;
  model: string;
  thinking: string;
  pending: string;
  error: string;
};

export type BtwIconDetectionContext = {
  platform: string;
  env: Record<string, string | undefined>;
  pathExists: (path: string) => boolean;
  readTextFile: (path: string) => string | null;
};

export type ResolvedBtwIcons = {
  mode: BtwIconMode;
  icons: BtwIconSet;
};

const NERD_FONT_ICONS: BtwIconSet = {
  agents: "\uF0C0",
  session: "\uF550",
  model: "\uEC19",
  thinking: "\uF0EB",
  pending: "\u{F0150}",
  error: "\uF071",
};

const UNICODE_ICONS: BtwIconSet = {
  agents: "⍟",
  session: "◍",
  model: "◈",
  thinking: "∿",
  pending: "⌛",
  error: "⚠",
};

const EMOJI_ICONS: BtwIconSet = {
  agents: "🧭",
  session: "🆔",
  model: "◈",
  thinking: "🧠",
  pending: "⏳",
  error: "⚠️",
};

const FALLBACK_ICONS: BtwIconSet = {
  ...EMOJI_ICONS,
  error: "❌",
};

const NERD_AGENT_ICONS: Record<string, string> = {
  ask: "\uF059",
  architect: "\uF1AD",
  code: "\uF121",
  debug: "\uF188",
  devops: "\uF233",
  docs: "\uF02D",
  git: "\uF126",
  orchestrator: "\uF0AE",
  product: "\uF0CA",
  refactor: "\uF021",
  researcher: "\uF0AC",
  security: "\uF023",
  test: "\uF0C3",
  ui: "\uF1FC",
};

function normalizeAgentName(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function getBtwAgentIcon(agentName: string | null | undefined, mode: BtwIconMode): string {
  const normalizedName = normalizeAgentName(agentName);
  if (mode === "nerd") {
    return NERD_AGENT_ICONS[normalizedName] ?? NERD_FONT_ICONS.agents;
  }
  return iconsForMode(mode).agents;
}

export function resolveBtwAgentIcon(agentName: string | null | undefined): string {
  const resolved = resolveBtwIcons();
  return getBtwAgentIcon(agentName, resolved.mode);
}

const WINDOWS_TERMINAL_SETTINGS_CANDIDATES = [
  ["Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"],
  ["Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json"],
  ["Packages", "Microsoft.WindowsTerminalDev_8wekyb3d8bbwe", "LocalState", "settings.json"],
  ["Microsoft", "Windows Terminal", "settings.json"],
] as const;

const FONT_HINT_ENV_KEYS = [
  "PI_BTW_SIDECAR_FONT_FAMILY",
  "PI_FONT_FAMILY",
  "TERM_PROGRAM_FONT",
  "KITTY_FONT_FAMILY",
  "WEZTERM_FONT",
  "WT_PROFILE_FONT_FACE",
] as const;

function createDefaultContext(): BtwIconDetectionContext {
  return {
    platform: process.platform,
    env: process.env,
    pathExists: (path) => existsSync(path),
    readTextFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

function parseBoolean(value: string | undefined): boolean | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return null;
}

function parsePreference(value: string | undefined): BtwIconPreference | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "nerd" || normalized === "unicode" || normalized === "emoji" || normalized === "fallback") {
    return normalized;
  }

  return null;
}

function resolvePreference(env: Record<string, string | undefined>): BtwIconPreference {
  const explicitMode = parsePreference(env.PI_BTW_SIDECAR_ICON_MODE);
  if (explicitMode) {
    return explicitMode;
  }

  const explicitBoolean = parseBoolean(env.PI_BTW_SIDECAR_NERD_FONT ?? env.PI_NERD_FONT);
  if (explicitBoolean !== null) {
    return explicitBoolean ? "nerd" : "fallback";
  }

  return "auto";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stripJsonComments(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const next = value[index + 1];

    if (inLineComment) {
      if (current === "\n") {
        inLineComment = false;
        result += current;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      result += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }

    if (current === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    result += current;
  }

  return result;
}

function stripTrailingCommas(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];

    if (inString) {
      result += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }

    if (current !== ",") {
      result += current;
      continue;
    }

    let lookahead = index + 1;
    while (lookahead < value.length && /\s/.test(value[lookahead] ?? "")) {
      lookahead += 1;
    }

    const nextNonSpace = value[lookahead];
    if (nextNonSpace === "}" || nextNonSpace === "]") {
      continue;
    }

    result += current;
  }

  return result;
}

function parseSettingsJson(raw: string): Record<string, unknown> | null {
  const withoutBom = raw.replace(/^\uFEFF/, "");

  try {
    const parsed = JSON.parse(withoutBom);
    return isRecord(parsed) ? parsed : null;
  } catch {
    const withoutComments = stripJsonComments(withoutBom);
    const withoutTrailingCommas = stripTrailingCommas(withoutComments);

    try {
      const parsed = JSON.parse(withoutTrailingCommas);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function getRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function getProfileFontFace(profile: Record<string, unknown> | null): string | null {
  if (!profile) {
    return null;
  }

  const font = getRecord(profile, "font");
  if (font && typeof font.face === "string" && font.face.trim().length > 0) {
    return font.face;
  }

  if (typeof profile.fontFace === "string" && profile.fontFace.trim().length > 0) {
    return profile.fontFace;
  }

  return null;
}

function normalizeProfileId(value: string): string {
  return value.trim().replace(/^\{/, "").replace(/\}$/, "").toLowerCase();
}

function findProfileById(settings: Record<string, unknown>, wtProfileId: string | undefined): Record<string, unknown> | null {
  if (!wtProfileId) {
    return null;
  }

  const profiles = getRecord(settings, "profiles");
  const list = profiles?.list;
  if (!Array.isArray(list)) {
    return null;
  }

  const expectedId = normalizeProfileId(wtProfileId);
  if (expectedId.length === 0) {
    return null;
  }

  for (const item of list) {
    if (!isRecord(item)) {
      continue;
    }

    const guid = typeof item.guid === "string" ? normalizeProfileId(item.guid) : "";
    if (guid === expectedId) {
      return item;
    }
  }

  return null;
}

function resolveWindowsTerminalSettingsPath(context: BtwIconDetectionContext): string | null {
  const localAppData = context.env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }

  for (const segments of WINDOWS_TERMINAL_SETTINGS_CANDIDATES) {
    const candidatePath = join(localAppData, ...segments);
    if (context.pathExists(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

function isNerdFontFace(fontFace: string | null): boolean {
  return typeof fontFace === "string" && /(?:nerd|(?:^|\s)nf(?:\s|$))/i.test(fontFace);
}

function detectFontHintFromEnv(env: Record<string, string | undefined>): boolean {
  for (const key of FONT_HINT_ENV_KEYS) {
    if (isNerdFontFace(env[key] ?? null)) {
      return true;
    }
  }

  return false;
}

function detectWindowsTerminalNerdFont(context: BtwIconDetectionContext): boolean {
  if (!context.env.WT_SESSION) {
    return false;
  }

  const settingsPath = resolveWindowsTerminalSettingsPath(context);
  if (!settingsPath) {
    return false;
  }

  const rawSettings = context.readTextFile(settingsPath);
  if (!rawSettings) {
    return false;
  }

  const settings = parseSettingsJson(rawSettings);
  if (!settings) {
    return false;
  }

  const activeProfile = findProfileById(settings, context.env.WT_PROFILE_ID);
  const activeProfileFont = getProfileFontFace(activeProfile);
  if (activeProfileFont !== null) {
    return isNerdFontFace(activeProfileFont);
  }

  const profiles = getRecord(settings, "profiles");
  const profileDefaultsFont = getProfileFontFace(getRecord(profiles, "defaults"));
  if (profileDefaultsFont !== null) {
    return isNerdFontFace(profileDefaultsFont);
  }

  const rootDefaultsFont = getProfileFontFace(getRecord(settings, "defaults"));
  if (rootDefaultsFont !== null) {
    return isNerdFontFace(rootDefaultsFont);
  }

  return false;
}

function resolveAutoMode(context: BtwIconDetectionContext): BtwIconMode {
  if (context.platform === "win32" && detectWindowsTerminalNerdFont(context)) {
    return "nerd";
  }

  return detectFontHintFromEnv(context.env) ? "nerd" : "fallback";
}

function iconsForMode(mode: BtwIconMode): BtwIconSet {
  switch (mode) {
    case "nerd":
      return NERD_FONT_ICONS;
    case "unicode":
      return UNICODE_ICONS;
    case "emoji":
      return EMOJI_ICONS;
    default:
      return FALLBACK_ICONS;
  }
}

export function resolveBtwIconsForContext(context: BtwIconDetectionContext): ResolvedBtwIcons {
  const preference = resolvePreference(context.env);
  const mode = preference === "auto" ? resolveAutoMode(context) : preference;

  return {
    mode,
    icons: iconsForMode(mode),
  };
}

export function resolveBtwIcons(): ResolvedBtwIcons {
  return resolveBtwIconsForContext(createDefaultContext());
}
