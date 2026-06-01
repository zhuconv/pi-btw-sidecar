import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Key,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import type { BtwConfig, BtwModalSize } from "./config";

const BTW_FOCUS_SHORTCUTS = ["alt+/", "ctrl+alt+w"] as const;

type BtwThreadMode = "contextual" | "tangent";

type BtwTranscriptEntry =
  | { id: number; turnId: number; type: "turn-boundary"; phase: "start" | "end" }
  | { id: number; turnId: number; type: "user-message"; text: string }
  | { id: number; turnId: number; type: "thinking"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "assistant-text"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "tool-call"; toolCallId: string; toolName: string; args: string }
  | {
      id: number;
      turnId: number;
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      content: string;
      truncated: boolean;
      isError: boolean;
      streaming: boolean;
    };

type BtwTranscript = BtwTranscriptEntry[];
type BtwTheme = ExtensionContext["ui"]["theme"];

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
  private readonly input: Input;
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

    this.modeText = new Text("", 1, 0);
    this.detailsText = new Text("", 1, 0);
    this.summaryText = new Text("", 1, 0);
    this.transcript = new Container();
    this.statusText = new Text("", 1, 0);

    this.input = new Input();
    this.input.onSubmit = (value) => {
      this.followTranscript = true;
      this.onSubmitCallback(value);
    };
    this.input.onEscape = () => {
      this.onDismissCallback();
    };

    this.hintsText = new Text("", 1, 0);

    // Enable SGR mouse reporting so wheel/touchpad events reach handleInput().
    this.tui.terminal?.write?.("\x1b[?1000h\x1b[?1006h");

    const originalHandleInput = this.input.handleInput.bind(this.input);
    this.input.handleInput = (data: string) => {
      if (options.keybindings.matches(data, "app.clear")) {
        if (this.input.getValue().length > 0) {
          this.input.setValue("");
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

  private inputFrameLine(dialogWidth: number): string {
    const targetWidth = Math.max(1, dialogWidth - 2);
    const previousFocused = this.input.focused;
    // Input.render() emits CURSOR_MARKER when focused. In overlay mode that APC marker
    // can skew width/composition on this one row before the TUI strips it, producing a
    // right-edge notch and shifted border. Render the embedded input unfocused here so
    // the row stays geometrically stable while the overlay still owns keyboard input.
    this.input.focused = false;
    try {
      const inputLine = this.input.render(targetWidth)[0] ?? "";
      return `${this.theme.fg("border", "│")}${inputLine}${this.theme.fg("border", "│")}`;
    } finally {
      this.input.focused = previousFocused;
    }
  }

  override render(width: number): string[] {
    const dialogWidth = Math.max(24, width);
    const innerWidth = Math.max(22, dialogWidth - 2);
    this.transcriptLines = this.renderTranscript(this.readTranscriptEntries(), this.theme, innerWidth, this.config);
    const transcriptLines = this.wrapTranscript(innerWidth);
    const dialogHeight = this.getDialogHeight();
    const chromeHeight = 9;
    const transcriptHeight = Math.max(1, dialogHeight - chromeHeight);
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

    lines.push(this.frameLine(this.theme.fg("dim", this.detailsTextValue.trim()), innerWidth));
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
    lines.push(this.inputFrameLine(dialogWidth));
    lines.push(this.frameLine(this.theme.fg("dim", this.hintsTextValue.trim()), innerWidth));
    lines.push(this.bottomLine(innerWidth));

    return lines;
  }

  setDraft(value: string): void {
    this.input.setValue(value);
    this.tui.requestRender();
  }

  getDraft(): string {
    return this.input.getValue();
  }

  getTranscriptEntries(): BtwTranscript {
    return this.readTranscriptEntries().map((entry) => ({ ...entry }));
  }

  refresh(): void {
    this.modeTextValue = `${getOverlayTitle(this.getMode())} · hidden thread preserved`;
    this.modeText.setText(this.modeTextValue);
    this.detailsTextValue = this.getDetails();
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
}
