import type {
  CoverageState, CoverageStats, ModuleStat, LineRange, Question,
  CodebaseAnalysis, SourceFile,
} from "./types.js";

export function mergeRanges(existing: LineRange[], newRange: LineRange): LineRange[] {
  const all = [...existing, newRange].sort((a, b) => a.startLine - b.startLine);
  const merged: LineRange[] = [];

  for (const range of all) {
    const last = merged[merged.length - 1];
    if (last && range.startLine <= last.endLine + 1) {
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
  const fileLineMap = new Map<string, number>();
  for (const f of sourceFiles) {
    fileLineMap.set(f.path, f.significantLines);
  }

  const moduleStats: ModuleStat[] = [];
  for (const mod of analysis.modules) {
    let coveredLines = 0;
    let totalLines = 0;
    for (const file of mod.files) {
      totalLines += fileLineMap.get(file) ?? 0;
      for (const r of state.lineCoverage[file] ?? []) {
        coveredLines += r.endLine - r.startLine + 1;
      }
    }
    moduleStats.push({
      moduleId: mod.id,
      name: mod.name,
      linePercent: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
      coveredLines,
      totalLines,
    });
  }

  let coveredLines = 0;
  for (const ranges of Object.values(state.lineCoverage)) {
    for (const r of ranges) coveredLines += r.endLine - r.startLine + 1;
  }
  const totalLines = sourceFiles.reduce((sum, f) => sum + f.significantLines, 0);

  return {
    linePercent: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
    coveredLines,
    totalLines,
    moduleStats,
  };
}

export function applyCorrectAnswer(
  state: CoverageState,
  question: Question,
  commitHash: string | null
): CoverageState {
  const cat = question.category;
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

export function invalidateStaleCoverage(
  state: CoverageState,
  changedFiles: string[]
): { newState: CoverageState; invalidated: string[] } {
  const invalidated: string[] = [];
  const newLineCoverage = { ...state.lineCoverage };
  const newCommits = { ...state.coveredFileCommits };

  for (const file of changedFiles) {
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
  const asked = new Set(state.askedQuestionIds);
  return state.questionCache.length > 0 &&
    state.questionCache.every(q => asked.has(q.id));
}
