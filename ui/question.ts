import type { Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { Question } from "../types.js";

export interface QuestionResult {
  correct: boolean;
  skipped: boolean;
  question: Question;
}

class QuestionComponent {
  private answered = false;
  private skipped = false;
  private wasCorrect = false;
  private chosenIndex: 0 | 1 | 2 | null = null;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly question: Question,
    private readonly theme: Theme,
    private readonly tui: TUI,
    private readonly onDone: (result: QuestionResult) => void
  ) {}

  handleInput(data: string): void {
    if (this.answered || this.skipped) {
      // Any key returns to menu
      this.onDone({
        correct: this.wasCorrect,
        skipped: this.skipped,
        question: this.question,
      });
      return;
    }

    if (matchesKey(data, "escape")) {
      this.skipped = true;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    const key = data.toLowerCase();
    if (key === "a" || key === "b" || key === "c") {
      this.chosenIndex = (key.charCodeAt(0) - "a".charCodeAt(0)) as 0 | 1 | 2;
      this.wasCorrect = this.chosenIndex === this.question.correctIndex;
      this.answered = true;
      this.invalidate();
      this.tui.requestRender();
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
    const sep = th.fg("borderMuted", "─".repeat(Math.min(width - 2, 60)));

    const cat = this.question.category;

    lines.push("");

    // Category header
    lines.push(pad(`  ${th.fg("accent", cat.module)}  ${th.fg("muted", cat.file)}  ${th.fg("dim", `lines ${cat.startLine}–${cat.endLine}`)}`));
    lines.push(pad(`  ${sep}`));
    if (this.question.codeContext) {
      for (const codeLine of this.question.codeContext.split("\n").slice(0, 20)) {
        lines.push(pad(`  ${th.fg("dim", codeLine)}`));
      }
      lines.push(pad(`  ${sep}`));
    }

    lines.push("");
    // Word-wrap the question text to fit width
    for (const textLine of wrapText(this.question.text, width - 4)) {
      lines.push(pad(`  ${th.fg("text", textLine)}`));
    }
    lines.push("");

    // Answer options
    const labels = ["A", "B", "C"] as const;
    for (let i = 0; i < 3; i++) {
      const label = labels[i]!;
      const opt = this.question.options[i]!;

      if (!this.answered && !this.skipped) {
        lines.push(pad(`  ${th.fg("accent", label + ")")} ${th.fg("text", opt)}`));
      } else {
        const isCorrect = i === this.question.correctIndex;
        const isChosen = i === this.chosenIndex;
        let optColor: string;
        if (isCorrect) {
          optColor = th.fg("success", opt);
        } else if (isChosen && !isCorrect) {
          optColor = th.fg("error", opt);
        } else {
          optColor = th.fg("dim", opt);
        }
        const labelColor = isCorrect
          ? th.fg("success", label + ")")
          : isChosen
          ? th.fg("error", label + ")")
          : th.fg("dim", label + ")");
        lines.push(pad(`  ${labelColor} ${optColor}`));
      }
    }

    lines.push("");
    lines.push(pad(`  ${sep}`));

    if (this.skipped) {
      lines.push(pad(`  ${th.fg("dim", "Skipped.")}`));
      lines.push("");
      lines.push(pad(`  ${th.fg("dim", "Press any key to return to menu")}`));
    } else if (this.answered) {
      if (this.wasCorrect) {
        lines.push(pad(`  ${th.fg("success", "Correct! ✓")}`));
      } else {
        const correctLabel = labels[this.question.correctIndex];
        lines.push(pad(`  ${th.fg("error", `Incorrect. The correct answer was ${correctLabel}.`)}`));
      }
      lines.push("");
      for (const expLine of wrapText(this.question.explanation, width - 4)) {
        lines.push(pad(`  ${th.fg("muted", expLine)}`));
      }
      lines.push("");
      lines.push(pad(`  ${th.fg("dim", "Press any key to return to menu")}`));
    } else {
      lines.push(pad(`  ${th.fg("dim", "Your answer (A/B/C) · Esc to skip")}`));
    }

    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current === "") {
      current = word;
    } else if ((current + " " + word).length <= maxWidth) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export async function showQuestion(
  question: Question,
  ctx: { ui: { custom: <T>(factory: (tui: TUI, theme: Theme, kb: unknown, done: (r: T) => void) => object) => Promise<T> } }
): Promise<QuestionResult> {
  return ctx.ui.custom<QuestionResult>((tui, theme, _kb, done) => {
    return new QuestionComponent(question, theme, tui, done);
  });
}
