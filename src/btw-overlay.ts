import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Editor,
  Key,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type EditorTheme,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import type { BtwConfig, BtwModalSize } from "./config";
import type { BtwTranscript, BtwTranscriptEntry } from "./btw-types";

const BTW_FOCUS_SHORTCUTS = ["alt+/", "ctrl+alt+w"] as const;

type BtwThreadMode = "contextual" | "tangent";
type BtwTheme = ExtensionContext["ui"]["theme"];

type BtwEditorShim = Editor & {
  setValue: (value: string) => void;
  getValue: () => string;
  onEscape?: () => void;
};

type BtwEditorConstructor = {
  readonly length: number;
  new (theme: unknown): Editor;
  new (tui: TUI, theme: EditorTheme): Editor;
};

const BTW_BOX_ROUND = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
} as const;

const BTW_BOX_SHARP = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
  teeDown: "┬",
  teeUp: "┴",
  teeLeft: "┤",
  teeRight: "├",
  cross: "┼",
} as const;

function createBtwEditor(tui: TUI, theme: BtwTheme): Editor {
  const symbols = {
    cursor: ">",
    inputCursor: "▏",
    boxRound: BTW_BOX_ROUND,
    boxSharp: BTW_BOX_SHARP,
    table: BTW_BOX_SHARP,
    quoteBorder: "│",
    hrChar: "─",
    colorSwatch: "[]",
    spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  };
  const editorTheme = {
    borderColor: (str: string) => theme.fg("border", str),
    selectList: {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.bold(text),
      description: (text: string) => theme.fg("dim", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("dim", text),
      symbols,
    },
    symbols,
    editorPaddingX: 0,
  } as EditorTheme;

  const EditorConstructor = Editor as unknown as BtwEditorConstructor;
  // Pi <=0.80 accepts (tui, theme); current OMP exposes the newer (theme)
  // constructor. Function.length distinguishes the two without host/version checks.
  const editor =
    EditorConstructor.length <= 1
      ? new EditorConstructor(editorTheme)
      : new EditorConstructor(tui, editorTheme);
  editor.setPaddingX(0);
  return editor;
}

type BtwOverlayDimensions = {
  maxHeight: number;
};

type BtwOverlayOptions = {
  tui: TUI;
  theme: BtwTheme;
  keybindings: KeybindingsManager;
  readTranscriptEntries: () => BtwTranscript;
  getStatus: () => string | null;
  getMode: () => BtwThreadMode;
  getDetails: () => string;
  config: BtwConfig;
  renderTranscript: (entries: BtwTranscript, theme: BtwTheme, width: number, options: Pick<BtwConfig, "showReasoning">) => string[];
  resolveModalDimensions: (tui: Pick<TUI, "terminal"> | undefined, modalSize: BtwModalSize) => BtwOverlayDimensions;
  onSubmit: (value: string) => void;
  onDismiss: () => void;
  onUnfocus: () => void;
  onInjectSelect?: (selectedIndices: number[], instructions: string) => void;
};

function matchesBtwFocusShortcut(data: string): boolean {
  return BTW_FOCUS_SHORTCUTS.some((shortcut) => matchesKey(data, shortcut));
}

function getOverlayTitle(mode: BtwThreadMode): string {
  return mode === "tangent" ? "BTW tangent" : "BTW";
}

function hasStreamingTranscriptEntry(entries: BtwTranscript): boolean {
  return entries.some(
    (entry) =>
      (entry.type === "thinking" || entry.type === "assistant-text" || entry.type === "tool-result") &&
      entry.streaming,
  );
}

function getCompletedExchangeCount(entries: BtwTranscript): number {
  return entries.filter((entry) => entry.type === "assistant-text" && !entry.streaming).length;
}

export class BtwOverlayComponent extends Container implements Focusable {
  private readonly input: Editor;
  private readonly transcript: Container;
  private readonly statusText: Text;
  private readonly modeText: Text;
  private readonly detailsText: Text;
  private readonly summaryText: Text;
  private readonly hintsText: Text;
  private readonly readTranscriptEntries: () => BtwTranscript;
  private readonly getStatus: () => string | null;
  private readonly getMode: () => BtwThreadMode;
  private readonly getDetails: () => string;
  private readonly renderTranscript: BtwOverlayOptions["renderTranscript"];
  private readonly resolveModalDimensions: BtwOverlayOptions["resolveModalDimensions"];
  private readonly onSubmitCallback: (value: string) => void;
  private readonly onDismissCallback: () => void;
  private readonly onUnfocusCallback: () => void;
  private readonly tui: TUI;
  private readonly theme: BtwTheme;
  private readonly config: BtwConfig;
  private transcriptLines: string[] = [];
  private transcriptScrollOffset = 0;
  private transcriptViewportHeight = 8;
  private followTranscript = true;
  private _focused = false;
  private modeTextValue = "";
  private detailsTextValue = "";
  private summaryTextValue = "";
  private statusTextValue = "";
  private hintsTextValue = "";
  private injectSelectMode = false;
  private injectSelectItems: Array<{ userText: string; checked: boolean }> = [];
  private injectSelectIndex = 0;
  private injectSelectInstructions = "";
  private readonly onInjectSelectCallback: ((selectedIndices: number[], instructions: string) => void) | undefined;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(options: BtwOverlayOptions) {
    super();
    this.tui = options.tui;
    this.theme = options.theme;
    this.readTranscriptEntries = options.readTranscriptEntries;
    this.getStatus = options.getStatus;
    this.getMode = options.getMode;
    this.getDetails = options.getDetails;
    this.config = options.config;
    this.renderTranscript = options.renderTranscript;
    this.resolveModalDimensions = options.resolveModalDimensions;
    this.onSubmitCallback = options.onSubmit;
    this.onDismissCallback = options.onDismiss;
    this.onUnfocusCallback = options.onUnfocus;
    this.onInjectSelectCallback = options.onInjectSelect;

    this.modeText = new Text("", 1, 0);
    this.detailsText = new Text("", 1, 0);
    this.summaryText = new Text("", 1, 0);
    this.transcript = new Container();
    this.statusText = new Text("", 1, 0);

    this.input = createBtwEditor(this.tui, this.theme);
    this.input.onSubmit = (value) => {
      this.followTranscript = true;
      this.onSubmitCallback(value);
    };

    // Shim Input-like API for backward compatibility
    const shimmedInput = this.input as BtwEditorShim;
    shimmedInput.setValue = (value: string) => this.input.setText(value);
    shimmedInput.getValue = () => this.input.getText();
    shimmedInput.onEscape = () => {
      this.onDismissCallback();
    };

    this.hintsText = new Text("", 1, 0);

    // Enable SGR mouse reporting so wheel/touchpad events reach handleInput().
    this.tui.terminal?.write?.("\x1b[?1000h\x1b[?1006h");

    const originalHandleInput = this.input.handleInput.bind(this.input);
    shimmedInput.handleInput = (data: string) => {
      if (options.keybindings.matches(data, "app.clear")) {
        if (this.input.getText().length > 0) {
          this.input.setText("");
          this.tui.requestRender();
          return;
        }

        this.onDismissCallback();
        return;
      }

      if (options.keybindings.matches(data, "tui.select.cancel")) {
        this.onDismissCallback();
        return;
      }
      originalHandleInput(data);
    };

    this.refresh();
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
  }

  private ruleLine(innerWidth: number): string {
    return this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
  }

  private titleLine(innerWidth: number): string {
    const title = ` ${this.modeTextValue.trim() || "BTW"} `;
    const titleText = truncateToWidth(title, Math.max(1, innerWidth - 2), "…");
    const leftWidth = Math.min(3, Math.max(1, innerWidth - visibleWidth(titleText)));
    const rightWidth = Math.max(0, innerWidth - leftWidth - visibleWidth(titleText));
    return `${this.theme.fg("border", `╭${"─".repeat(leftWidth)}`)}${this.theme.fg("accent", this.theme.bold(titleText))}${this.theme.fg("border", `${"─".repeat(rightWidth)}╮`)}`;
  }

  private bottomLine(innerWidth: number): string {
    return this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
  }

  private dimNonAnsiParts(text: string): string {
    if (!text.includes("\x1b[")) {
      return this.theme.fg("dim", text);
    }
    return text
      .split(/(\x1b\[[0-9;]*m)/g)
      .filter((part) => part.length > 0)
      .map((part) => (/\x1b\[[0-9;]*m/.test(part) ? part : this.theme.fg("dim", part)))
      .join("");
  }

  private colorizeDetails(raw: string): string {
    const segments: string[] = [];
    const regex = /<(\w+)>(.*?)<\/\1>/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw)) !== null) {
      const before = raw.slice(lastIndex, match.index);
      if (before) {
        segments.push(this.dimNonAnsiParts(before));
      }
      const colorName = match[1];
      const content = match[2];
      try {
        segments.push(this.theme.fg(colorName as ThemeColor, content));
      } catch {
        segments.push(this.dimNonAnsiParts(content));
      }
      lastIndex = regex.lastIndex;
    }
    const after = raw.slice(lastIndex);
    if (after) {
      segments.push(this.dimNonAnsiParts(after));
    }
    if (segments.length === 0) {
      return this.theme.fg("dim", raw);
    }
    return segments.join("");
  }

  private wrapTranscript(innerWidth: number): string[] {
    const wrapped: string[] = [];
    for (const line of this.transcriptLines) {
      if (!line) {
        wrapped.push("");
        continue;
      }
      wrapped.push(...wrapTextWithAnsi(line, Math.max(1, innerWidth)));
    }
    return wrapped;
  }

  private getDialogHeight(): number {
    return this.resolveModalDimensions(this.tui, this.config.modalSize).maxHeight;
  }

  private scrollTranscript(delta: number): void {
    if (delta < 0) {
      this.followTranscript = false;
    }
    this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset + delta);
    this.tui.requestRender();
  }

  dispose(): void {
    this.tui.terminal?.write?.("\x1b[?1000l\x1b[?1006l");
  }

  private getMouseScrollDelta(data: string): number | null {
    const match = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
    if (!match) {
      return null;
    }

    const button = Number(match[1]);
    if ((button & 64) !== 64) {
      return null;
    }

    return (button & 1) === 0 ? -3 : 3;
  }

  handleInput(data: string): void {
    if (matchesBtwFocusShortcut(data)) {
      this.onUnfocusCallback();
      return;
    }

    if (this.injectSelectMode) {
      if (data === "\x1b[A") {
        this.injectSelectIndex = Math.max(0, this.injectSelectIndex - 1);
        this.tui.requestRender();
        return;
      }
      if (data === "\x1b[B") {
        this.injectSelectIndex = Math.min(this.injectSelectItems.length - 1, this.injectSelectIndex + 1);
        this.tui.requestRender();
        return;
      }
      if (data === " ") {
        const item = this.injectSelectItems[this.injectSelectIndex];
        if (item) {
          item.checked = !item.checked;
          this.tui.requestRender();
        }
        return;
      }
      if (data === "\r" || data === "\n") {
        const selectedIndices = this.injectSelectItems
          .map((item, i) => (item.checked ? i : -1))
          .filter((i) => i !== -1);
        this.onInjectSelectCallback?.(selectedIndices, this.injectSelectInstructions);
        return;
      }
      if (data === "\x1b" || matchesKey(data, Key.escape)) {
        this.exitInjectSelectMode();
        return;
      }
      return;
    }

    const mouseScrollDelta = this.getMouseScrollDelta(data);
    if (mouseScrollDelta !== null) {
      this.scrollTranscript(mouseScrollDelta);
      return;
    }

    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.up)) {
      const step = matchesKey(data, Key.pageUp) ? Math.max(1, this.transcriptViewportHeight - 1) : 1;
      this.scrollTranscript(-step);
      return;
    }

    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.down)) {
      const step = matchesKey(data, Key.pageDown) ? Math.max(1, this.transcriptViewportHeight - 1) : 1;
      this.scrollTranscript(step);
      return;
    }

    this.input.handleInput(data);
  }

  private inputFrameLines(dialogWidth: number): string[] {
    const targetWidth = Math.max(1, dialogWidth - 2);
    const previousFocused = this.input.focused;
    // Editor.render() emits CURSOR_MARKER when focused. Render unfocused so the
    // overlay frame stays geometrically stable while the overlay still owns keyboard input.
    this.input.focused = false;
    try {
      const rendered = this.input.render(targetWidth);
      return rendered.map((line) => `${this.theme.fg("border", "│")}${line}${this.theme.fg("border", "│")}`);
    } finally {
      this.input.focused = previousFocused;
    }
  }

  override render(width: number): string[] {
    const dialogWidth = Math.max(24, width);
    const innerWidth = Math.max(22, dialogWidth - 2);
    if (this.injectSelectMode) {
      this.transcriptLines = this.buildInjectSelectLines(innerWidth);
    } else {
      this.transcriptLines = this.renderTranscript(this.readTranscriptEntries(), this.theme, innerWidth, this.config);
    }
    const transcriptLines = this.wrapTranscript(innerWidth);
    const dialogHeight = this.getDialogHeight();
    const inputLines = this.inputFrameLines(dialogWidth);
    const baseChromeHeight = 8;
    const transcriptHeight = Math.max(1, dialogHeight - baseChromeHeight - inputLines.length);
    this.transcriptViewportHeight = transcriptHeight;

    const maxScroll = Math.max(0, transcriptLines.length - transcriptHeight);
    if (this.followTranscript) {
      this.transcriptScrollOffset = maxScroll;
    } else {
      this.transcriptScrollOffset = Math.max(0, Math.min(this.transcriptScrollOffset, maxScroll));
      if (this.transcriptScrollOffset >= maxScroll) {
        this.followTranscript = true;
      }
    }

    const visibleTranscript = transcriptLines.slice(
      this.transcriptScrollOffset,
      this.transcriptScrollOffset + transcriptHeight,
    );
    const transcriptPadCount = Math.max(0, transcriptHeight - visibleTranscript.length);
    const hiddenAbove = this.transcriptScrollOffset;
    const hiddenBelow = Math.max(0, maxScroll - this.transcriptScrollOffset);
    const summary =
      hiddenAbove || hiddenBelow
        ? `${this.summaryTextValue.trim()} · ↑${hiddenAbove} ↓${hiddenBelow}`
        : this.summaryTextValue.trim();

    const lines = [this.titleLine(innerWidth)];

    lines.push(this.frameLine(this.detailsTextValue.trim(), innerWidth));
    lines.push(this.frameLine(this.theme.fg("dim", summary), innerWidth));
    lines.push(this.ruleLine(innerWidth));

    for (const line of visibleTranscript) {
      lines.push(this.frameLine(line, innerWidth));
    }
    for (let i = 0; i < transcriptPadCount; i++) {
      lines.push(this.frameLine("", innerWidth));
    }

    lines.push(this.ruleLine(innerWidth));
    lines.push(this.frameLine(this.theme.fg("warning", this.statusTextValue.trim()), innerWidth));
    lines.push(...inputLines);
    lines.push(this.frameLine(this.theme.fg("dim", this.hintsTextValue.trim()), innerWidth));
    lines.push(this.bottomLine(innerWidth));

    return lines;
  }

  setDraft(value: string): void {
    if (this.injectSelectMode) {
      return;
    }
    this.input.setText(value);
    this.tui.requestRender();
  }

  getDraft(): string {
    return this.input.getText();
  }

  getTranscriptEntries(): BtwTranscript {
    return this.readTranscriptEntries().map((entry) => ({ ...entry }));
  }

  refresh(): void {
    if (this.injectSelectMode) {
      this.tui.requestRender();
      return;
    }
    this.modeTextValue = `${getOverlayTitle(this.getMode())} · hidden thread preserved`;
    this.modeText.setText(this.modeTextValue);
    this.detailsTextValue = this.colorizeDetails(this.getDetails());
    this.detailsText.setText(this.detailsTextValue);
    const entries = this.readTranscriptEntries();
    const exchanges = getCompletedExchangeCount(entries);
    const active = hasStreamingTranscriptEntry(entries) ? " · streaming" : " · idle";
    this.summaryTextValue = `${exchanges} exchange${exchanges === 1 ? "" : "s"}${active}`;
    this.summaryText.setText(this.summaryTextValue);

    this.transcriptLines = this.renderTranscript(entries, this.theme, 80, this.config);
    this.transcript.clear();
    for (const line of this.transcriptLines) {
      this.transcript.addChild(new Text(line, 1, 0));
    }

    const status = this.getStatus() ?? "Ready. Enter submits; Escape dismisses without clearing.";
    this.statusTextValue = status;
    this.statusText.setText(this.statusTextValue);
    this.hintsTextValue = "Scroll wheel ↑↓ PgUp/PgDn · Enter · Alt+/ focus · Esc";
    this.hintsText.setText(this.hintsTextValue);
    this.tui.requestRender();
  }

  enterInjectSelectMode(instructions: string): void {
    this.injectSelectMode = true;
    this.injectSelectInstructions = instructions;
    this.injectSelectItems = this.getInjectSelectItems();
    this.injectSelectIndex = 0;
    this.statusTextValue = "Select BTW exchanges to inject";
    this.statusText.setText(this.statusTextValue);
    this.hintsTextValue = "[↑/↓] Navigate · [Space] Toggle · [Enter] Inject Selected · [Esc] Cancel";
    this.hintsText.setText(this.hintsTextValue);
    this.input.setText("");
    this.tui.requestRender();
  }

  exitInjectSelectMode(): void {
    this.injectSelectMode = false;
    this.injectSelectItems = [];
    this.injectSelectIndex = 0;
    this.injectSelectInstructions = "";
    this.refresh();
  }

  private getInjectSelectItems(): Array<{ userText: string; checked: boolean }> {
    const entries = this.readTranscriptEntries();
    const items: Array<{ userText: string; checked: boolean }> = [];
    let currentUser = "";
    for (const entry of entries) {
      if (entry.type === "user-message") {
        currentUser = entry.text.split("\n")[0];
      }
      if (entry.type === "assistant-text" && !entry.streaming) {
        items.push({ userText: currentUser || "(No user prompt)", checked: false });
        currentUser = "";
      }
    }
    return items;
  }

  private buildInjectSelectLines(innerWidth: number): string[] {
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold("Select BTW exchanges to inject")));
    lines.push("");
    for (let i = 0; i < this.injectSelectItems.length; i++) {
      const item = this.injectSelectItems[i];
      const checkbox = item.checked ? "☑" : "☐";
      const prefix = `${checkbox} ${i + 1} `;
      const preview = truncateToWidth(item.userText, Math.max(1, innerWidth - visibleWidth(prefix)), "…");
      lines.push(`${prefix}${preview}`);
    }
    if (this.injectSelectItems.length === 0) {
      lines.push(this.theme.fg("dim", "No exchanges available."));
    }
    lines.push("");
    lines.push(this.theme.fg("dim", "[↑/↓] Navigate · [Space] Toggle · [Enter] Inject Selected · [Esc] Cancel"));
    return lines;
  }
}
