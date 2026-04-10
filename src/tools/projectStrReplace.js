import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { getProject } from "../core/projectRegistry.js";
import { validatePath, sanitizeCommitMessage } from "../core/validator.js";
import { createLogger } from "../core/logger.js";
import { findDependents } from "../analysis/symbolGraph.js";

const log = createLogger("str-replace");

const MAX_EDITS_PER_CALL = 20;
const MAX_IMPACT_DISPLAYED = 8;

function normalize(s) {
    return s
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t");
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fuzzyLineMatch(fileContent, searchStr) {
    const fileLines = fileContent.split("\n");
    const searchLines = searchStr
        .split("\n")
        .map(l => l.trimEnd())
        .filter(l => l.trim().length > 0);

    if (searchLines.length < 2) return null;

    for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
        let matched = true;
        for (let j = 0; j < searchLines.length; j++) {
            if (fileLines[i + j].trimEnd() !== searchLines[j]) {
                matched = false;
                break;
            }
        }
        if (matched) {
            return fileLines.slice(i, i + searchLines.length).join("\n");
        }
    }
    return null;
}

function hasChanges(root) {
    const r = spawnSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
    });
    return (r.stdout || "").trim().length > 0;
}

function ensureGitIdentity(root) {
    const get = (scope, key) =>
        spawnSync("git", ["config", scope, key], { cwd: root, encoding: "utf8" }).stdout.trim();

    if (!get("--local", "user.email") && !get("--global", "user.email")) {
        spawnSync("git", ["config", "user.email", "aidev@mcp.local"], { cwd: root });
        spawnSync("git", ["config", "user.name", "AI Dev MCP"], { cwd: root });
    }
}

function commitChanges(root, message) {
    spawnSync("git", ["add", "."], { cwd: root });

    const safeMessage = sanitizeCommitMessage(message || "str-replace edit");

    const result = spawnSync("git", ["commit", "-m", safeMessage], {
        cwd: root,
        encoding: "utf8",
    });

    if (result.status !== 0) {
        throw new Error(
            `Git commit failed: ${(result.stderr || result.stdout || "").trim()}`
        );
    }

    return result.stdout.trim();
}

function resolveFilePath(root, relativePath) {
    const fullPath = validatePath(root, relativePath);

    if (!fs.existsSync(fullPath)) {
        throw new Error(
            `File not found: "${relativePath}".\n` +
            `Use relative path like: src/file.js`
        );
    }

    return fullPath;
}

function applyEditInMemory(relativePath, rawOriginal, search, replace) {
    const normalizedFile = normalize(rawOriginal);
    const normalizedSearch = normalize(search);
    const normalizedReplace = normalize(replace);

    let effectiveSearch = normalizedSearch;

    if (!normalizedFile.includes(normalizedSearch)) {
        const fuzzyMatch = fuzzyLineMatch(normalizedFile, normalizedSearch);
        if (fuzzyMatch) {
            effectiveSearch = fuzzyMatch;
        } else {
            throw new Error(
                `Search string not found in "${relativePath}".\n` +
                `Fix: re-read file and retry.`
            );
        }
    }

    const matchCount = (normalizedFile.match(new RegExp(escapeRegex(effectiveSearch), "g")) || []).length;

    if (matchCount > 1) {
        throw new Error(
            `Ambiguous match in "${relativePath}" (${matchCount} matches).`
        );
    }

    return normalizedFile
        .replace(effectiveSearch, normalizedReplace)
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
}

function computeImpact(project, editedPaths) {
    try {
        const allAffected = new Set();

        for (const file of editedPaths) {
            findDependents(project, file, 2).forEach(f => allAffected.add(f));
        }

        if (allAffected.size === 0) return [];

        const lines = ["\nImpact analysis:"];
        [...allAffected]
            .slice(0, MAX_IMPACT_DISPLAYED)
            .forEach(f => lines.push(`  - ${f}`));

        return lines;
    } catch {
        return [];
    }
}

export function projectStrReplace({ project, edits, commitMessage }) {
    if (!project) throw new Error("project required");
    if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error("edits must be non-empty");
    }

    const config = getProject(project);
    const root = config.root;

    ensureGitIdentity(root);

    const results = [];

    for (const edit of edits) {
        const fullPath = resolveFilePath(root, edit.path);
        const raw = fs.readFileSync(fullPath, "utf8");

        const updated = applyEditInMemory(
            edit.path,
            raw,
            edit.search,
            edit.replace
        );

        fs.writeFileSync(fullPath, updated, "utf8");

        results.push(`edited: ${edit.path}`);
    }

    if (!hasChanges(root)) {
        return {
            content: [{
                type: "text",
                text: `No changes:\n${results.join("\n")}`
            }]
        };
    }

    commitChanges(root, commitMessage);

    const impact = computeImpact(project, edits.map(e => e.path));

    return {
        content: [{
            type: "text",
            text: `Changes applied:\n${results.join("\n")}${impact.join("\n")}`
        }],
        changedFiles: edits.map(e => e.path)
    };
}