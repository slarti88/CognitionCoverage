import type {
  CoverageState, CoverageStats, LineRange, Question,
  CodebaseAnalysis, SourceFile,
} from "./types.js";

export function mergeRanges(existing: LineRange[], newRange: LineRange): LineRange[] {
  const all = [...existing, newRange].sort((a, b) => a.startLine - b.startLine);
  const merged: LineRange[] = [];

  for (const range of all) {
    const last = merged[merged.length - 1];
    if (last && range.startLine <= last.endLine + 1) {
      // Overlapping or adjacent — extend
      last.endLine = Math.max(last.endLine, range.endLine);
    } else {
      merged.push({ startLine: range.startLine, endLine: range.endLine });
    }
  }

  return merged;
}

export function calculateCoverage(
  state: CoverageState,
  analysis: CodebaseAnalysis,
  sourceFiles: SourceFile[]
): CoverageStats {
  // Line coverage
  let coveredLines = 0;
  for (const ranges of Object.values(state.lineCoverage)) {
    for (const r of ranges) {
      coveredLines += r.endLine - r.startLine + 1;
    }
  }
  const totalLines = sourceFiles.reduce((sum, f) => sum + f.significantLines, 0);

  // Tool coverage
  const coveredTools = Object.values(state.toolCoverage).filter(Boolean).length;
  const totalTools = analysis.tools.length;

  // Architecture coverage
  const coveredArch = Object.values(state.archCoverage).filter(Boolean).length;
  const totalArch = analysis.architectureDecisions.length;

  return {
    linePercent: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
    toolPercent: totalTools > 0 ? (coveredTools / totalTools) * 100 : 0,
    archPercent: totalArch > 0 ? (coveredArch / totalArch) * 100 : 0,
    coveredLines,
    totalLines,
    coveredTools,
    totalTools,
    coveredArch,
    totalArch,
  };
}

export function applyCorrectAnswer(
  state: CoverageState,
  question: Question,
  commitHash: string | null
): CoverageState {
  const cat = question.category;

  if (cat.kind === "lines_of_code") {
    const existing = state.lineCoverage[cat.file] ?? [];
    const newLineCoverage = {
      ...state.lineCoverage,
      [cat.file]: mergeRanges(existing, { startLine: cat.startLine, endLine: cat.endLine }),
    };
    const newCommits = commitHash
      ? { ...state.coveredFileCommits, [cat.file]: commitHash }
      : state.coveredFileCommits;
    return { ...state, lineCoverage: newLineCoverage, coveredFileCommits: newCommits };
  }

  if (cat.kind === "tool") {
    return { ...state, toolCoverage: { ...state.toolCoverage, [cat.toolName]: true } };
  }

  if (cat.kind === "architecture") {
    return { ...state, archCoverage: { ...state.archCoverage, [cat.decisionId]: true } };
  }

  return state;
}

export function invalidateStaleCoverage(
  state: CoverageState,
  changedFiles: string[]
): { newState: CoverageState; invalidated: string[] } {
  const invalidated: string[] = [];
  const newLineCoverage = { ...state.lineCoverage };
  const newCommits = { ...state.coveredFileCommits };

  for (const file of changedFiles) {
    // Normalize path separators for comparison
    const normalized = file.replace(/\\/g, "/");
    if (newLineCoverage[normalized]) {
      delete newLineCoverage[normalized];
      delete newCommits[normalized];
      invalidated.push(normalized);
    }
  }

  return {
    newState: { ...state, lineCoverage: newLineCoverage, coveredFileCommits: newCommits },
    invalidated,
  };
}

export function pickNextQuestion(state: CoverageState): Question | null {
  const asked = new Set(state.askedQuestionIds);
  const available = state.questionCache.filter(q => !asked.has(q.id));
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)]!;
}

export function shouldResetQuestionCache(state: CoverageState): boolean {
  // Reset when all questions have been asked
  const asked = new Set(state.askedQuestionIds);
  return state.questionCache.length > 0 &&
    state.questionCache.every(q => asked.has(q.id));
}
