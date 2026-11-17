/**
 * src/tools/astReplaceDispatch.js
 *
 * Dispatch handler for the AST-aware rename tools.
 * Called by the CallToolRequestSchema handler in index.js:
 *
 *   const astResult = await dispatchAstReplace(name, args, getProject);
 *   if (astResult !== null) return astResult;
 *
 * Returns null when the tool name is not handled here,
 * so the caller falls through to its own dispatch.
 */

import { renameSymbol, renameSymbolInProject } from './astReplace.js';

/**
 * @param {string}   name        - tool name from MCP request
 * @param {object}   args        - tool arguments
 * @param {Function} getProject  - getProject(projectName) from projectRegistry
 * @returns {object|null}        - MCP content response, or null if not handled
 */
export async function dispatchAstReplace(name, args, getProject) {
    if (name === 'project_rename_symbol') {
        try {
            const proj = getProject(args.project);
            const r    = renameSymbol(
                proj.root, args.path, args.oldName, args.newName,
                { dryRun: args.dryRun ?? false, backup: args.backup ?? false }
            );
            if (!r.ok) return { content: [{ type: 'text', text: `Error: ${r.error}` }] };
            const action = (args.dryRun ?? false) ? 'Preview' : 'Renamed';
            return { content: [{ type: 'text', text:
                `${action}: "${args.oldName}" \u2192 "${args.newName}" | ${r.replacements} occurrence(s) in ${args.path}\n${r.preview}`
            }] };
        } catch (e) {
            return { content: [{ type: 'text', text: `project_rename_symbol error: ${e.message}` }] };
        }
    }

    if (name === 'project_rename_symbol_all') {
        try {
            const proj = getProject(args.project);
            const r    = renameSymbolInProject(
                proj.root, args.oldName, args.newName,
                args.extensions, args.dryRun ?? false
            );
            if (r.totalReplacements === 0) {
                return { content: [{ type: 'text', text: `No occurrences of "${args.oldName}" found in project.` }] };
            }
            const action = (args.dryRun ?? false) ? 'Preview' : 'Renamed';
            const lines  = [
                `${action}: "${args.oldName}" \u2192 "${args.newName}" | ${r.totalReplacements} total occurrence(s) across ${r.files.length} file(s)`,
                ...r.files.map(f => `  ${f.path}: ${f.replacements} occurrence(s)`)
            ];
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (e) {
            return { content: [{ type: 'text', text: `project_rename_symbol_all error: ${e.message}` }] };
        }
    }

    return null;  // not handled — caller should continue its own dispatch
}
