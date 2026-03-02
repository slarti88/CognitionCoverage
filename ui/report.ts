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

    const rows = [
      {
        label: "Line Coverage  ",
        pct: this.stats.linePercent,
        covered: this.stats.coveredLines,
        total: this.stats.totalLines,
        unit: "lines",
      },
      {
        label: "Tool Coverage  ",
        pct: this.stats.toolPercent,
        covered: this.stats.coveredTools,
        total: this.stats.totalTools,
        unit: "tools",
      },
      {
        label: "Architecture   ",
        pct: this.stats.archPercent,
        covered: this.stats.coveredArch,
        total: this.stats.totalArch,
        unit: "decisions",
      },
    ];

    for (const row of rows) {
      const bar = th.fg("accent", progressBar(row.pct));
      const pctStr = `${Math.round(row.pct)}%`.padStart(4);
      const detail = th.fg("dim", `(${row.covered}/${row.total} ${row.unit})`);
      lines.push(pad(`  ${th.fg("muted", row.label)}  ${bar}  ${th.fg("text", pctStr)}  ${detail}`));
    }

    if (this.invalidated.length > 0) {
      lines.push("");
      lines.push(pad(`  ${sep}`));
      lines.push(pad(`  ${th.fg("warning", "Stale coverage — modified since last answer:")}`));
      for (const file of this.invalidated) {
        lines.push(pad(`    ${th.fg("dim", "- " + file)}`));
      }
    }

    if (this.analysis) {
      lines.push("");
      lines.push(pad(`  ${sep}`));
      lines.push(pad(`  ${th.fg("muted", "Tracked tools:")} ${th.fg("dim", this.analysis.tools.map(t => t.name).join(", ") || "none")}`));
      lines.push(pad(`  ${th.fg("muted", "Architecture decisions:")} ${th.fg("dim", String(this.analysis.architectureDecisions.length))}`));
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
