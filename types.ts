export type QuestionCategory =
  | { kind: "lines_of_code"; file: string; startLine: number; endLine: number }
  | { kind: "tool"; toolName: string }
  | { kind: "architecture"; decisionId: string }
  | { kind: "file_class"; file: string };

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
  toolCoverage: Record<string, boolean>;
  archCoverage: Record<string, boolean>;
  coveredFileCommits: Record<string, string>;
  questionCache: Question[];
  askedQuestionIds: string[];
}

export interface ToolEntry {
  name: string;
  description: string;
  source: string;
}

export interface ArchDecision {
  id: string;
  name: string;
  description: string;
}

export interface CodebaseAnalysis {
  tools: ToolEntry[];
  architectureDecisions: ArchDecision[];
}

export interface CodeChunk {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
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

export interface CoverageStats {
  linePercent: number;
  toolPercent: number;
  archPercent: number;
  coveredLines: number;
  totalLines: number;
  coveredTools: number;
  totalTools: number;
  coveredArch: number;
  totalArch: number;
}
