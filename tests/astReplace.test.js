/**
 * tests/astReplace.test.js
 *
 * Tests for the AST-aware symbol rename utility.
 * Uses a real temp directory to test actual file writes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { renameSymbol, renameSymbolInProject } from '../src/tools/astReplace.js';

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ast-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(rel, content) {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
}

function read(rel) {
    return fs.readFileSync(path.join(tmpDir, rel), 'utf-8');
}

describe('renameSymbol — single file', () => {

    it('renames all whole-word occurrences', () => {
        write('src/auth.js', 'function userId() {}\nconst x = userId();\n');
        const r = renameSymbol(tmpDir, 'src/auth.js', 'userId', 'accountId');
        expect(r.ok).toBe(true);
        expect(r.replacements).toBe(2);
        expect(read('src/auth.js')).toContain('accountId');
        expect(read('src/auth.js')).not.toContain('userId');
    });

    it('does not rename substrings (word-boundary respected)', () => {
        write('src/api.js', 'function getUserId() { return userId; }\n');
        const r = renameSymbol(tmpDir, 'src/api.js', 'userId', 'accountId');
        expect(r.ok).toBe(true);
        expect(r.replacements).toBe(1);  // only standalone `userId`, not inside `getUserId`
        const content = read('src/api.js');
        expect(content).toContain('getUserId');    // unchanged
        expect(content).toContain('accountId');    // standalone replaced
    });

    it('returns 0 replacements when symbol not found', () => {
        write('src/empty.js', 'const x = 1;\n');
        const r = renameSymbol(tmpDir, 'src/empty.js', 'userId', 'accountId');
        expect(r.ok).toBe(true);
        expect(r.replacements).toBe(0);
    });

    it('dry-run does not write the file', () => {
        const original = 'const userId = 1;\n';
        write('src/dry.js', original);
        const r = renameSymbol(tmpDir, 'src/dry.js', 'userId', 'accountId', { dryRun: true });
        expect(r.ok).toBe(true);
        expect(r.replacements).toBe(1);
        expect(read('src/dry.js')).toBe(original);  // file unchanged
    });

    it('backup creates a .bak file', () => {
        write('src/bak.js', 'const userId = 1;\n');
        renameSymbol(tmpDir, 'src/bak.js', 'userId', 'accountId', { backup: true });
        expect(fs.existsSync(path.join(tmpDir, 'src/bak.js.bak'))).toBe(true);
    });

    it('rejects invalid identifier names', () => {
        write('src/x.js', 'const a = 1;\n');
        const r1 = renameSymbol(tmpDir, 'src/x.js', 'not-valid', 'b');
        expect(r1.ok).toBe(false);
        const r2 = renameSymbol(tmpDir, 'src/x.js', 'a', '123bad');
        expect(r2.ok).toBe(false);
    });

    it('returns error for non-existent file', () => {
        const r = renameSymbol(tmpDir, 'src/ghost.js', 'foo', 'bar');
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/Cannot read/);
    });

    it('builds a mini diff preview', () => {
        write('src/preview.js', 'const userId = getUserId();\nconst id = userId + 1;\n');
        const r = renameSymbol(tmpDir, 'src/preview.js', 'userId', 'accountId');
        expect(r.preview).toContain('- ');
        expect(r.preview).toContain('+ ');
    });
});

describe('renameSymbolInProject — whole project', () => {

    it('renames across multiple files', () => {
        write('src/a.js', 'const userId = 1;\n');
        write('src/b.js', 'export function getUser(userId) { return userId; }\n');
        write('src/c.js', 'import { getUser } from \'./b.js\';\n');  // no userId here
        const r = renameSymbolInProject(tmpDir, 'userId', 'accountId', ['.js']);
        expect(r.ok).toBe(true);
        expect(r.files).toHaveLength(2);  // a.js and b.js
        expect(r.totalReplacements).toBe(3);  // 1 in a.js, 2 in b.js
        expect(read('src/a.js')).toContain('accountId');
        expect(read('src/b.js')).toContain('accountId');
        expect(read('src/c.js')).not.toContain('accountId');
    });

    it('dry-run leaves all files unchanged', () => {
        write('src/x.js', 'const foo = 1; const bar = foo;\n');
        const original = read('src/x.js');
        renameSymbolInProject(tmpDir, 'foo', 'baz', ['.js'], true);
        expect(read('src/x.js')).toBe(original);
    });

    it('returns 0 files when symbol is absent', () => {
        write('src/nothing.js', 'const a = 1;\n');
        const r = renameSymbolInProject(tmpDir, 'ghost', 'replacement', ['.js']);
        expect(r.totalReplacements).toBe(0);
        expect(r.files).toHaveLength(0);
    });
});
