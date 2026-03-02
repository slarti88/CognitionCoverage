import type { Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { CoverageStats } from "../types.js";

export type MenuChoice = "question" | "report" | "quit";

const CHOICES: MenuChoice[] = ["question", "report", "quit"];
const LABELS = ["Ask a question", "View coverage report", "Quit"];

class MenuComponent {
  private selection = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly stats: CoverageStats,
    private readonly invalidated: string[],
    private readonly theme: Theme,
    private readonly tui: TUI,
    private readonly onDone: (choice: MenuChoice) => void
  ) {}

  handleInput(data: string): void {
    if (data === "1") { this.onDone("question"); return; }
    if (data === "2") { this.onDone("report"); return; }
    if (data === "3" || matchesKey(data, "escape")) { this.onDone("quit"); return; }

    if (matchesKey(data, "up")) {
      this.selection = Math.max(0, this.selection - 1);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selection = Math.min(CHOICES.length - 1, this.selection + 1);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.onDone(CHOICES[this.selection]!);
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const lines: string[] = [];
    const pad = (s: string) => truncateToWidth(s, width);

    const pct = (n: number) => `${Math.round(n)}%`;
    const statsLine = `Line: ${pct(this.stats.linePercent)}  Tool: ${pct(this.stats.toolPercent)}  Arch: ${pct(this.stats.archPercent)}`;

    const innerWidth = Math.min(42, width - 4);
    const sep = th.fg("borderMuted", "─".repeat(innerWidth + 2));

    lines.push("");
    lines.push(pad(`  ${th.fg("accent", "Cognition Coverage")}`));
    lines.push(pad(`  ${th.fg("muted", statsLine)}`));
    lines.push(pad(`  ${sep}`));
    lines.push("");

    for (let i = 0; i < CHOICES.length; i++) {
      const num = th.fg("accent", `[${i + 1}]`);
      const label = i === this.selection
        ? th.fg("text", LABELS[i]!)
        : th.fg("muted", LABELS[i]!);
      const cursor = i === this.selection ? th.fg("accent", "▶") : " ";
      lines.push(pad(`  ${cursor} ${num} ${label}`));
    }

    lines.push("");
    lines.push(pad(`  ${sep}`));
    lines.push(pad(`  ${th.fg("dim", "↑↓ to navigate · Enter or 1/2/3 to select")}`));

    if (this.invalidated.length > 0) {
      lines.push("");
      lines.push(pad(`  ${th.fg("warning", `⚠ ${this.invalidated.length} file(s) changed — coverage invalidated`)}`));
    }

    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

export async function showMenu(
  stats: CoverageStats,
  invalidated: string[],
  ctx: { ui: { custom: <T>(factory: (tui: TUI, theme: Theme, kb: unknown, done: (r: T) => void) => object) => Promise<T> } }
): Promise<MenuChoice> {
  return ctx.ui.custom<MenuChoice>((tui, theme, _kb, done) => {
    return new MenuComponent(stats, invalidated, theme, tui, done);
  });
}
