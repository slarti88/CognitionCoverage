import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  isFirstRun, loadState, saveState, loadAnalysis, saveAnalysis,
  emptyState, ensureGitignore,
} from "./store.js";
import { isGitRepo, getChangedFiles, getCurrentCommit } from "./git.js";
import { walkCodebase } from "./codebase.js";
import { runCodebaseAnalysis, generateQuestions } from "./ai.js";
import {
  invalidateStaleCoverage, applyCorrectAnswer, calculateCoverage,
  pickNextQuestion, shouldResetQuestionCache,
} from "./coverage.js";
import { showMenu } from "./ui/menu.js";
import { showQuestion } from "./ui/question.js";
import { showReport } from "./ui/report.js";

const INITIAL_QUESTION_COUNT = 20;
const REFILL_THRESHOLD = 5;
const REFILL_COUNT = 15;

async function runCogcov(ctx: ExtensionCommandContext): Promise<void> {
  const { cwd } = ctx;

  if (!ctx.hasUI) {
    ctx.ui.notify("/cogcov requires interactive mode", "error");
    return;
  }

  ensureGitignore(cwd);

  // --- First Run ---
  if (isFirstRun(cwd)) {
    try {
      ctx.ui.setStatus("cogcov", "Analyzing codebase...");
      const walkResult = walkCodebase(cwd);

      const analysis = await runCodebaseAnalysis(walkResult, ctx);
      saveAnalysis(cwd, analysis);

      ctx.ui.setStatus("cogcov", `Generating ${INITIAL_QUESTION_COUNT} questions...`);
      const initialState = emptyState();
      const questions = await generateQuestions(initialState, analysis, walkResult, INITIAL_QUESTION_COUNT, ctx);
      const newState = { ...initialState, questionCache: questions };
      saveState(cwd, newState);
    } catch (err) {
      ctx.ui.setStatus("cogcov", undefined);
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`cogcov setup failed: ${msg}`, "error");
      return;
    } finally {
      ctx.ui.setStatus("cogcov", undefined);
    }
  }

  // --- Load State ---
  let state = loadState(cwd);
  const analysis = loadAnalysis(cwd);

  // Reset question cache if all questions have been asked
  if (shouldResetQuestionCache(state)) {
    state = { ...state, askedQuestionIds: [], questionCache: [] };
    saveState(cwd, state);
  }

  // --- Git Invalidation ---
  let invalidated: string[] = [];
  const inGit = await isGitRepo(cwd);

  if (inGit) {
    const changedFiles = await getChangedFiles(cwd);
    if (changedFiles.length > 0) {
      const result = invalidateStaleCoverage(state, changedFiles);
      state = result.newState;
      invalidated = result.invalidated;
      if (invalidated.length > 0) {
        saveState(cwd, state);
      }
    }
  } else {
    ctx.ui.notify("Not a git repo — coverage invalidation is disabled", "info");
  }

  // --- Background Question Refill ---
  const walkResult = walkCodebase(cwd);

  const availableCount = state.questionCache.filter(
    q => !state.askedQuestionIds.includes(q.id)
  ).length;

  if (availableCount < REFILL_THRESHOLD && analysis) {
    // Fire-and-forget: don't await so we don't block the menu
    generateQuestions(state, analysis, walkResult, REFILL_COUNT, ctx)
      .then(newQs => {
        // Re-load to avoid overwriting concurrent saves
        const fresh = loadState(cwd);
        const existingIds = new Set(fresh.questionCache.map(q => q.id));
        const toAdd = newQs.filter(q => !existingIds.has(q.id));
        if (toAdd.length > 0) {
          saveState(cwd, { ...fresh, questionCache: [...fresh.questionCache, ...toAdd] });
        }
      })
      .catch(() => {
        // Silent failure — next invocation will retry
      });
  }

  // --- Main Loop ---
  while (true) {
    const stats = calculateCoverage(
      state,
      analysis ?? { modules: [] },
      walkResult.sourceFiles
    );

    const choice = await showMenu(stats, invalidated, ctx);
    invalidated = []; // Clear after first display

    if (choice === "quit") break;

    if (choice === "report") {
      await showReport(stats, analysis, invalidated, ctx);
      continue;
    }

    if (choice === "question") {
      // Re-load in case background refill completed
      state = loadState(cwd);

      // Reset if all asked
      if (shouldResetQuestionCache(state)) {
        state = { ...state, askedQuestionIds: [], questionCache: [] };
        saveState(cwd, state);
      }

      const question = pickNextQuestion(state);
      if (!question) {
        ctx.ui.notify("No questions available yet — generating more in the background...", "info");
        continue;
      }

      // Mark as asked immediately to prevent re-ask on loop
      state = {
        ...state,
        askedQuestionIds: [...state.askedQuestionIds, question.id],
      };
      saveState(cwd, state);

      const result = await showQuestion(question, ctx);

      if (!result.skipped && result.correct) {
        const commitHash = inGit ? await getCurrentCommit(cwd) : null;
        state = applyCorrectAnswer(state, question, commitHash);
        saveState(cwd, state);
      }
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("cogcov", {
    description: "Cognition Coverage — test your understanding of this codebase",
    handler: async (_args, ctx) => {
      await runCogcov(ctx);
    },
  });
}
