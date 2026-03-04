import type { Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { CoverageStats, CodebaseAnalysis } from "../types.js";

function progressBar(percent: number, barWidth = 17): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * barWidth);
  const empty = barWidth - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

class ReportComponent {
  constructor(
    private readonly stats: CoverageStats,
    private readonly analysis: CodebaseAnalysis | null,
    private readonly invalidated: string[],
    private readonly theme: Theme,
    private readonly onDone: () => void
  ) {}

  handleInput(data: string): void {
    if (data.toLowerCase() === "q" || matchesKey(data, "escape") || matchesKey(data, "enter")) {
      this.onDone();
    }
  }

  invalidate(): void {
    // Report is static — no cache needed
  }

  render(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    const pad = (s: string) => truncateToWidth(s, width);
    const sepChar = "─";
    const sep = th.fg("borderMuted", sepChar.repeat(Math.min(width - 1, 56)));

    lines.push("");
    lines.push(pad(`  ${sep}`));
    lines.push(pad(`  ${th.fg("accent", "Cognition Coverage Report")}`));
    lines.push(pad(`  ${sep}`));
    lines.push("");

    // Overall line coverage
    const overallPct = `${Math.round(this.stats.linePercent)}%`.padStart(4);
    const overallDetail = th.fg("dim", `(${this.stats.coveredLines}/${this.stats.totalLines} lines)`);
    lines.push(pad(`  ${th.fg("muted", "Overall        ")}  ${th.fg("accent", progressBar(this.stats.linePercent))}  ${th.fg("text", overallPct)}  ${overallDetail}`));

    // Per-module rows
    if (this.stats.moduleStats.length > 0) {
      lines.push("");
      lines.push(pad(`  ${th.fg("muted", "By Module:")}`));
      for (const mod of this.stats.moduleStats) {
        const done = mod.linePercent >= 100;
        const bar = th.fg(done ? "success" : "accent", progressBar(mod.linePercent));
        const pct = `${Math.round(mod.linePercent)}%`.padStart(4);
        const detail = th.fg("dim", `(${mod.coveredLines}/${mod.totalLines} lines)`);
        const label = mod.name.padEnd(15).slice(0, 15);
        const labelColor = done ? th.fg("success", label) : th.fg("muted", label);
        lines.push(pad(`  ${labelColor}  ${bar}  ${th.fg("text", pct)}  ${detail}`));
      }
    }

    if (this.invalidated.length > 0) {
      lines.push("");
      lines.push(pad(`  ${sep}`));
      lines.push(pad(`  ${th.fg("warning", "Stale coverage — modified since last answer:")}`));
      for (const file of this.invalidated) {
        lines.push(pad(`    ${th.fg("dim", "- " + file)}`));
      }
    }

    if (this.analysis && this.analysis.modules.length > 0) {
      lines.push("");
      lines.push(pad(`  ${sep}`));
      lines.push(pad(`  ${th.fg("muted", "Modules:")} ${th.fg("dim", this.analysis.modules.map(m => m.name).join(", "))}`));
    }

    lines.push("");
    lines.push(pad(`  ${sep}`));
    lines.push(pad(`  ${th.fg("dim", "[Q / Enter / Esc] Back to menu")}`));
    lines.push("");

    return lines;
  }
}

export async function showReport(
  stats: CoverageStats,
  analysis: CodebaseAnalysis | null,
  invalidated: string[],
  ctx: { ui: { custom: <T>(factory: (tui: TUI, theme: Theme, kb: unknown, done: (r: T) => void) => object) => Promise<T> } }
): Promise<void> {
  return ctx.ui.custom<void>((tui, theme, _kb, done) => {
    return new ReportComponent(stats, analysis, invalidated, theme, () => done(undefined));
  });
}
