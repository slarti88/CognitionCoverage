import type { CodeChunk, LineRange, CoverageState } from "./types.js";

export const ANALYSIS_SYSTEM = `You are a software architecture analyst. Analyze the provided codebase and return ONLY valid JSON with no markdown fences. The response must be parseable by JSON.parse().`;

export const QUESTION_GEN_SYSTEM = `You are a technical quiz author. Generate MCQ questions about the provided source code. Return ONLY a valid JSON array, no markdown. Each question must test genuine understanding, not trivia. Wrong answer options must be plausible.`;

export function buildAnalysisPrompt(params: {
  directoryTree: string;
  dependencyFileContents: string;
  sampleSourceFiles: string;
}): string {
  return `Analyze this codebase and return JSON matching this exact shape:
{
  "tools": [{ "name": "...", "description": "one-line purpose", "source": "Cargo.toml" }],
  "architectureDecisions": [{ "id": "arch_001", "name": "...", "description": "..." }]
}

Identify:
- All significant libraries/frameworks found in dependency files
- Key architecture decisions visible in the code (auth patterns, data patterns, concurrency model, API style, storage choices, etc.)

Directory structure:
${params.directoryTree}

Dependency files:
${params.dependencyFileContents}

Sample source files:
${params.sampleSourceFiles}`;
}

export function buildQuestionGenPrompt(params: {
  count: number;
  coveredLineRanges: string;
  coveredTools: string;
  coveredArchDecisions: string;
  codeChunks: string;
  analysisJson: string;
}): string {
  return `Generate ${params.count} multiple-choice questions about this codebase.
Return a JSON array where each item matches this shape exactly:
{
  "id": "q_<8-char random hex>",
  "category": "lines_of_code" | "tool" | "architecture",
  "file": "relative/path.ts",
  "startLine": 10,
  "endLine": 25,
  "toolName": "...",
  "decisionId": "arch_001",
  "codeContext": "...code snippet...",
  "text": "Question text?",
  "options": ["Option A", "Option B", "Option C"],
  "correctIndex": 0,
  "explanation": "Why the correct answer is right."
}

Notes:
- Include "file", "startLine", "endLine", "codeContext" only for lines_of_code questions
- Include "toolName" only for tool questions
- Include "decisionId" only for architecture questions
- "correctIndex" must be 0, 1, or 2

Do NOT generate questions covering these already-covered areas:
- Lines: ${params.coveredLineRanges || "none"}
- Tools: ${params.coveredTools || "none"}
- Architecture decisions: ${params.coveredArchDecisions || "none"}

Target distribution: 60% lines_of_code, 20% tool, 20% architecture

Source code chunks:
${params.codeChunks}

Tool and architecture context:
${params.analysisJson}`;
}

export function formatDependencyFiles(depFiles: Array<{ path: string; content: string }>): string {
  return depFiles
    .slice(0, 10)
    .map(f => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 2000)}\n\`\`\``)
    .join("\n\n");
}

export function formatSampleSourceFiles(sourceFiles: Array<{ path: string; content: string }>): string {
  return sourceFiles
    .slice(0, 5)
    .map(f => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 3000)}\n\`\`\``)
    .join("\n\n");
}

export function formatCodeChunks(chunks: CodeChunk[]): string {
  return chunks
    .map(c => `### ${c.file} (lines ${c.startLine}–${c.endLine})\n\`\`\`\n${c.content}\n\`\`\``)
    .join("\n\n");
}

export function formatCoveredLineRanges(lineCoverage: Record<string, LineRange[]>): string {
  const parts: string[] = [];
  for (const [file, ranges] of Object.entries(lineCoverage)) {
    if (ranges.length === 0) continue;
    const rangeStr = ranges.map(r => `${r.startLine}-${r.endLine}`).join(", ");
    parts.push(`${file}: [${rangeStr}]`);
  }
  return parts.join("; ") || "none";
}

export function buildPromptParams(state: CoverageState, analysis: { tools: Array<{ name: string }>; architectureDecisions: Array<{ id: string }> }) {
  return {
    coveredLineRanges: formatCoveredLineRanges(state.lineCoverage),
    coveredTools: Object.entries(state.toolCoverage)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ") || "none",
    coveredArchDecisions: Object.entries(state.archCoverage)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ") || "none",
  };
}
