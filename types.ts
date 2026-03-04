export type QuestionCategory =
  | { kind: "lines_of_code"; file: string; startLine: number; endLine: number; module: string };

export interface Question {
  id: string;
  category: QuestionCategory;
  text: string;
  options: [string, string, string];
  correctIndex: 0 | 1 | 2;
  explanation: string;
  codeContext?: string;
}

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface CoverageState {
  lineCoverage: Record<string, LineRange[]>;
  coveredFileCommits: Record<string, string>;
  questionCache: Question[];
  askedQuestionIds: string[];
}

export interface Module {
  id: string;
  name: string;
  description: string;
  files: string[];
}

export interface CodebaseAnalysis {
  modules: Module[];
}

export interface CodeChunk {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
  module: string;
}

export interface SourceFile {
  path: string;
  content: string;
  significantLines: number;
}

export interface DepFile {
  path: string;
  content: string;
}

export interface WalkResult {
  sourceFiles: SourceFile[];
  depFiles: DepFile[];
  dirTree: string;
}

export interface ModuleStat {
  moduleId: string;
  name: string;
  linePercent: number;
  coveredLines: number;
  totalLines: number;
}

export interface CoverageStats {
  linePercent: number;
  coveredLines: number;
  totalLines: number;
  moduleStats: ModuleStat[];
}
