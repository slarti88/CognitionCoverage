import * as fs from "node:fs";
import * as path from "node:path";
import type { CoverageState, CodebaseAnalysis } from "./types.js";

const COGCOV_DIR = ".cogcov";
const STATE_FILE = path.join(COGCOV_DIR, "state.json");
const ANALYSIS_FILE = path.join(COGCOV_DIR, "analysis.json");

export function isFirstRun(cwd: string): boolean {
  return !fs.existsSync(path.join(cwd, STATE_FILE));
}

export function ensureDirs(cwd: string): void {
  fs.mkdirSync(path.join(cwd, COGCOV_DIR), { recursive: true });
}

export function emptyState(): CoverageState {
  return {
    lineCoverage: {},
    toolCoverage: {},
    archCoverage: {},
    coveredFileCommits: {},
    questionCache: [],
    askedQuestionIds: [],
  };
}

export function loadState(cwd: string): CoverageState {
  try {
    const raw = fs.readFileSync(path.join(cwd, STATE_FILE), "utf-8");
    return JSON.parse(raw) as CoverageState;
  } catch {
    return emptyState();
  }
}

export function saveState(cwd: string, state: CoverageState): void {
  ensureDirs(cwd);
  fs.writeFileSync(
    path.join(cwd, STATE_FILE),
    JSON.stringify(state, null, 2),
    "utf-8"
  );
}

export function loadAnalysis(cwd: string): CodebaseAnalysis | null {
  try {
    const raw = fs.readFileSync(path.join(cwd, ANALYSIS_FILE), "utf-8");
    return JSON.parse(raw) as CodebaseAnalysis;
  } catch {
    return null;
  }
}

export function saveAnalysis(cwd: string, analysis: CodebaseAnalysis): void {
  ensureDirs(cwd);
  fs.writeFileSync(
    path.join(cwd, ANALYSIS_FILE),
    JSON.stringify(analysis, null, 2),
    "utf-8"
  );
}

export function ensureGitignore(cwd: string): void {
  const gitignorePath = path.join(cwd, ".gitignore");
  const entry = ".cogcov/";
  try {
    const existing = fs.readFileSync(gitignorePath, "utf-8");
    if (!existing.includes(entry)) {
      fs.appendFileSync(gitignorePath, `\n${entry}\n`);
    }
  } catch {
    // No .gitignore — skip silently
  }
}
