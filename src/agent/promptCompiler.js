/**
 * src/agent/promptCompiler.js
 *
 * The Prompt Compiler is the bridge between the codebase and the LLM.
 * Instead of concatenating strings, it assembles a structured, budget-aware
 * context window that gives the LLM exactly what it needs — no more, no less.
 *
 * What it does:
 *   1. Scores every piece of available context by relevance to the current step
 *   2. Fills the token budget from highest relevance down
 *   3. Produces a single structured prompt string with clearly labelled sections
 *   4. Guarantees the CURRENT file content is always included for any file about to be edited
 *
 * Why this matters:
 *   The #1 failure mode in coding agents is str_replace with a search string that
 *   no longer matches the file (because the agent used stale content). The compiler
 *   solves this by ALWAYS fetching fresh file content for files the current step will edit.
 */

import { CHARS_PER_TOKEN, MAX_FILE_SIZE } from "../core/constants.js";
import { validatePath } from "../core/validator.js";
import { getProject }   from "../core/projectRegistry.js";
import fs   from "fs";
import path from "path";

// Token budget reserved for the system prompt + task instructions
const RESERVED_TOKENS    = 800;
// Max tokens for a single file snippet in context
const MAX_FILE_TOKENS    = 1200;
// Max tokens for memory entries
const MAX_MEMORY_TOKENS  = 300;
// Max tokens for error context
const MAX_ERROR_TOKENS   = 400;

/**
 * Estimate token count from character count.
 */
function tokens(text) {
    return Math.ceil((text || "").length / CHARS_PER_TOKEN);
}

/**
 * Truncate text to a token budget.
 */
function truncate(text, maxTokens) {
    const maxChars = maxTokens * CHARS_PER_TOKEN;
    if (!text || text.length <= maxChars) return text || "";
    return text.substring(0, maxChars) + "
... [truncated]";
}

/**
 * Score a context piece by relevance to the current step.
 * Returns 0.0–1.0.
 */
function relevanceScore(content, step, execState) {
    if (!content) return 0;
    const stepLower    = step.toLowerCase();
    const contentLower = content.toLowerCase();

    // Extract identifiers from step (camelCase, PascalCase, snake_case words ≥ 4 chars)
    const identifiers = [
        ...(step.match(/\b[A-Z][a-zA-Z]{2,}\b/g) || []),
        ...(step.match(/\b[a-z][a-zA-Z]{3,}\b/g) || []),
        ...(step.match(/\b[a-z_]{4,}\b/g) || [])
    ].filter(id => !STOP_WORDS.has(id.toLowerCase()));

    const identifierHits = identifiers.filter(id =>
        contentLower.includes(id.toLowerCase())
    ).length;

    const identifierScore = identifiers.length > 0
        ? identifierHits / identifiers.length
        : 0;

    // Boost recently modified files
    let modifiedBoost = 0;
    if (execState) {
        for (const modFile of execState.filesModified) {
            const base = path.basename(modFile).toLowerCase();
            if (base && contentLower.includes(base)) { modifiedBoost = 0.3; break; }
        }
    }

    return Math.min(1.0, identifierScore * 0.7 + modifiedBoost);
}

// Common English stop words to ignore in identifier extraction
const STOP_WORDS = new Set([
    "read", "find", "run", "apply", "create", "check", "build", "using",
    "with", "from", "into", "after", "before", "static", "analysis",
    "project", "file", "files", "code", "the", "and", "for"
]);

/**
 * Read the current content of a file from disk (not from index).
 * This guarantees the LLM sees the actual current state, not a cached version.
 */
function readCurrentFile(projectName, relativePath) {
    try {
        const project  = getProject(projectName);
        const fullPath = validatePath(project.root, relativePath);
        if (!fs.existsSync(fullPath)) return null;
        const content = fs.readFileSync(fullPath, "utf-8");
        return content.length > MAX_FILE_SIZE
            ? content.substring(0, MAX_FILE_SIZE) + "
... [file truncated at 12KB]"
            : content;
    } catch {
        return null;
    }
}

/**
 * Detect which files the current step is likely to edit.
 * Returns an array of relative file paths.
 */
function detectTargetFiles(step, execState) {
    const targets = [];

    // Explicit file mentions: any word containing / or . that looks like a path
    const pathMatches = step.match(/[\w./\\-]+\.(?:js|jsx|ts|tsx|java|py|kt|go|rb|rs|xml|json|md)/g) || [];
    targets.push(...pathMatches);

    // Recently modified files are almost always relevant to the next step.
    // Use the full relative path (not just basename) so readCurrentFile() can
    // locate the file correctly under the project root.
    if (execState) {
        for (const f of execState.filesModified) {
            if (!targets.includes(f)) targets.push(f);
        }
    }

    return [...new Set(targets)].slice(0, 3); // max 3 files in context
}

/**
 * Compile a structured LLM prompt for a single execution step.
 *
 * @param {object} params
 * @param {string}         params.step             — the plan step to execute
 * @param {string}         params.project          — project name
 * @param {string}         params.taskDescription  — original user task
 * @param {string[]}       params.ragChunks         — retrieved vector search chunks
 * @param {string}         params.memoryContext     — relevant memory entries
 * @param {string}         params.executionLog      — compressed prior steps log
 * @param {ExecutionState} params.execState         — live execution state
 * @param {number}         params.tokenBudget       — total tokens available for context
 * @returns {{ prompt: string, stats: object }}
 */
export function compilePrompt({
    step,
    project,
    taskDescription,
    ragChunks = [],
    memoryContext = "",
    executionLog = "",
    execState = null,
    tokenBudget = 3000,
}) {
    const usable = tokenBudget - RESERVED_TOKENS;
    let usedTokens = 0;
    const sections = [];

    // ── 1. Task header (always included) ────────────────────────────────────
    const taskHeader = `Task: ${taskDescription}
Current step: ${step}`;
    sections.push({ label: "TASK", content: taskHeader, priority: 100 });
    usedTokens += tokens(taskHeader);

    // ── 2. Execution state (always included, compressed) ────────────────────
    if (execState) {
        const stateLines = [];
        if (execState.filesModified.size > 0)
            stateLines.push(`Files modified this run: ${[...execState.filesModified].join(", ")}`);
        if (execState.filesRead.size > 0)
            stateLines.push(`Files already read: ${[...execState.filesRead].slice(-5).join(", ")}`);
        if (execState.errors.length > 0) {
            const lastErr = execState.errors[execState.errors.length - 1];
            stateLines.push(`Last error: [${lastErr.type}] ${String(lastErr.text).substring(0, 200)}`);
        }
        if (stateLines.length > 0) {
            const stateBlock = stateLines.join("
");
            sections.push({ label: "STATE", content: stateBlock, priority: 90 });
            usedTokens += tokens(stateBlock);
        }
    }

    // ── 3. Current file contents (CRITICAL — always fresh from disk) ─────────
    // If the step will edit a file, we MUST include the current content.
    // Stale content is the #1 cause of "search string not found" errors.
    const targetFiles = detectTargetFiles(step, execState);
    const fileContents = [];

    for (const filePath of targetFiles) {
        const content = readCurrentFile(project, filePath);
        if (!content) continue;
        const snippet = truncate(content, MAX_FILE_TOKENS);
        const cost = tokens(snippet);
        if (usedTokens + cost > usable) break;
        fileContents.push(`// ${filePath}
${snippet}`);
        usedTokens += cost;
    }

    if (fileContents.length > 0) {
        sections.push({
            label: "CURRENT FILE CONTENTS",
            content: fileContents.join("

---
"),
            priority: 85
        });
    }

    // ── 4. Error context (high priority if present) ──────────────────────────
    if (execState?.errors.length > 0) {
        const errorText = execState.errors
            .slice(-2)
            .map(e => `[${e.type}] ${e.text}`)
            .join("
");
        const snippet = truncate(errorText, MAX_ERROR_TOKENS);
        const cost = tokens(snippet);
        if (usedTokens + cost <= usable) {
            sections.push({ label: "ERRORS TO FIX", content: snippet, priority: 80 });
            usedTokens += cost;
        }
    }

    // ── 5. RAG chunks (scored by relevance to this step) ─────────────────────
    const scoredChunks = ragChunks
        .map(chunk => ({ chunk, score: relevanceScore(chunk, step, execState) }))
        .filter(s => s.score > 0.1)
        .sort((a, b) => b.score - a.score);

    for (const { chunk } of scoredChunks) {
        const cost = tokens(chunk);
        if (usedTokens + cost > usable) break;
        sections.push({ label: "RELEVANT CODE", content: truncate(chunk, 400), priority: 60 });
        usedTokens += cost;
    }

    // ── 6. Memory context ────────────────────────────────────────────────────
    if (memoryContext) {
        const snippet = truncate(memoryContext, MAX_MEMORY_TOKENS);
        const cost = tokens(snippet);
        if (usedTokens + cost <= usable) {
            sections.push({ label: "ARCHITECTURE MEMORY", content: snippet, priority: 50 });
            usedTokens += cost;
        }
    }

    // ── 7. Execution log (lowest priority — compressed history) ──────────────
    if (executionLog) {
        const remaining = usable - usedTokens;
        if (remaining > 200) {
            const snippet = truncate(executionLog, remaining);
            sections.push({ label: "EXECUTION LOG", content: snippet, priority: 30 });
            usedTokens += tokens(snippet);
        }
    }

    // ── Assemble final prompt ─────────────────────────────────────────────────
    // Sort by priority desc so most important sections come first
    sections.sort((a, b) => b.priority - a.priority);

    const body = sections
        .map(s => `[${s.label}]
${s.content}`)
        .join("

");

    const stats = {
        totalTokens:  usedTokens,
        budget:       tokenBudget,
        sections:     sections.map(s => s.label),
        filesFetched: targetFiles,
        ragUsed:      scoredChunks.length,
    };

    return { prompt: body, stats };
}
