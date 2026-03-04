# Plan 0.1: Module-Based Question Categories

## Goal
Replace the flat 3-category system (`lines_of_code`, `tool`, `architecture`) with a
module-first hierarchy:
1. Analysis phase identifies **modules** — logical groups of files in the codebase
2. Only `lines_of_code` questions are generated (scope limited for now)
3. Every question is tagged with its parent module
4. Coverage is tracked and reported per module

---

## Conceptual Model

```
Codebase
└── Module A  (e.g. "auth", "api", "database")
│   ├── file1.ts
│   └── file2.ts
└── Module B
    └── file3.ts
```

A **Module** is an AI-identified or directory-derived logical unit.
Coverage progress is exposed at two granularities:
- **Module coverage** — what % of modules have had at least one question answered correctly
- **Line coverage within a module** — what % of significant lines in that module are covered

---

## Changes Per File

### `types.ts`
- Add `Module` interface:
  ```ts
  export interface Module {
    id: string;          // e.g. "auth", "module_001"
    name: string;        // human-readable label
    description: string; // one-line purpose
    files: string[];     // relative paths of files in this module
  }
  ```
- Add `modules: Module[]` to `CodebaseAnalysis`
- Modify `lines_of_code` variant in `QuestionCategory` to include `module: string`
- Remove `tool` and `architecture` category variants (dead code for now)
- Update `CoverageState`:
  - Remove `toolCoverage` and `archCoverage`
  - Keep `lineCoverage` (file → LineRange[] still needed for precise tracking)
- Update `CoverageStats`:
  - Remove `toolPercent`, `archPercent`, `coveredTools`, `totalTools`, `coveredArch`, `totalArch`
  - Add `moduleStats: { moduleId: string; name: string; linePercent: number }[]`
  - Keep top-level `linePercent` as aggregate

### `prompts.ts`
- **`buildAnalysisPrompt`**: Add `modules` to required JSON shape:
  ```json
  {
    "modules": [
      { "id": "auth", "name": "Auth", "description": "...", "files": ["src/auth/index.ts"] }
    ]
  }
  ```
  Identify modules by grouping files that share a root-level directory or a clear
  conceptual boundary. Flat repos (all files at root) should still produce modules
  (e.g. one module per logical concern, using the AI to infer groupings from filenames
  and imports).

- **`buildQuestionGenPrompt`**:
  - Remove the target distribution line (`60% lines_of_code, 20% tool, 20% architecture`)
  - Only `lines_of_code` category is requested
  - Add `"module": "<moduleId>"` to the required JSON shape for each question
  - Group the provided code chunks by module in the prompt body so the AI has context

- Remove `buildPromptParams` helper's references to `coveredTools`/`coveredArchDecisions`
  (or simplify it to only return `coveredLineRanges`)

### `coverage.ts`
- **`applyCorrectAnswer`**: Handle only `lines_of_code` (remove `tool`/`architecture` branches)
- **`calculateCoverage`**:
  - Compute per-module line coverage by summing covered lines for each module's files
  - Return `moduleStats[]` instead of tool/arch stats
- **`invalidateStaleCoverage`**: No change needed (already file-based)
- Keep `mergeRanges`, `pickNextQuestion`, `shouldResetQuestionCache` unchanged

### `store.ts`
- **`emptyState`**: Remove `toolCoverage: {}` and `archCoverage: {}` from initial state
- No other changes needed

### `ai.ts`
- **`validateAnalysis`**: Accept `modules` array; add `normalizeModule()` helper
- **`normalizeQuestion`**: Handle `module` field in `lines_of_code` category;
  remove `tool`/`architecture` normalization paths
- Remove tool/arch references from `generateQuestions`

### `codebase.ts`
- Add `buildModuleCodeChunks(sourceFiles, modules, coveredFiles, maxChunks)` —
  groups chunks by module, ensuring each module gets at least some representation
  in the prompt rather than being crowded out by large files from one module

---

## Data Flow After Change

```
walkCodebase()
    └─> runCodebaseAnalysis()  — returns { modules: [...] }
            └─> saveAnalysis()

generateQuestions(state, analysis, walkResult)
    └─> buildModuleCodeChunks()   — chunks grouped by module
    └─> buildQuestionGenPrompt()  — only lines_of_code, tagged with module
    └─> normalizeQuestion()       — category = { kind, file, startLine, endLine, module }

showReport()
    └─> calculateCoverage()  — returns moduleStats[]
```

---

## Open Questions (need your input before implementation)

1. **Module detection strategy**: Should modules be detected purely from the
   directory structure (each top-level folder = one module), purely by AI inference
   (AI reads filenames and decides logical groups), or a hybrid (directory structure
   as a hint, AI fills in flat repos)? Hybrid is most robust but adds prompt complexity.

2. **Coverage granularity**: Currently coverage is tracked as `file → LineRange[]`.
   Should we keep this fine-grained tracking (lines within a file) and derive module
   coverage from it, or switch to coarser module-level-only tracking?
   Keeping file-level tracking lets us resume per-file progress; module-only is simpler.

3. **Removing `tool`/`architecture` types**: Should I hard-delete these types/branches,
   or comment them out / mark them `// reserved for future use`? Hard-delete is cleaner
   but makes the diff bigger and harder to restore later.

4. **Minimum module granularity**: For small/flat repos (all files at root), what's the
   minimum number of modules? One per file? One per logical concern (even if co-located)?
   This affects what the AI prompt asks for.

5. **Module coverage threshold**: At what point is a module "fully covered"? When 100%
   of lines in its files are covered? Or some lower threshold (e.g. 80%)? This matters
   for the coverage report display.
