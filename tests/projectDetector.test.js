import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs   from "fs";
import path from "path";
import os   from "os";
import { detectProjectType } from "../src/core/projectDetector.js";

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(file, content = "") {
    const full = path.join(tmpDir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

describe("detectProjectType", () => {
    it("detects nextjs", () => {
        write("package.json", JSON.stringify({ dependencies: { next: "14.0.0" } }));
        const { type } = detectProjectType(tmpDir);
        expect(type).toBe("nextjs");
    });

    it("detects react-vite", () => {
        write("package.json", JSON.stringify({ dependencies: { vite: "5.0.0", react: "18.0.0" } }));
        const { type } = detectProjectType(tmpDir);
        expect(type).toBe("react-vite");
    });

    it("detects nodejs (express)", () => {
        write("package.json", JSON.stringify({ dependencies: { express: "4.0.0" } }));
        const { type } = detectProjectType(tmpDir);
        expect(type).toBe("nodejs");
    });

    it("detects spring-boot via pom.xml", () => {
        write("pom.xml", "<project></project>");
        const { type, buildCommand } = detectProjectType(tmpDir);
        expect(type).toBe("spring-boot");
        expect(buildCommand).toBe("mvn clean install");
    });

    it("detects django via manage.py alone", () => {
        write("manage.py", "#!/usr/bin/env python");
        const { type } = detectProjectType(tmpDir);
        expect(type).toBe("django");
    });

    it("detects odoo when manage.py + __manifest__.py present", () => {
        write("manage.py", "");
        write("__manifest__.py", "");
        const { type } = detectProjectType(tmpDir);
        expect(type).toBe("odoo");
    });

    it("detects go via go.mod", () => {
        write("go.mod", "module example.com/app");
        const { type, buildCommand } = detectProjectType(tmpDir);
        expect(type).toBe("go");
        expect(buildCommand).toBe("go build ./...");
    });

    it("detects rust via Cargo.toml", () => {
        write("Cargo.toml", "[package]");
        const { type } = detectProjectType(tmpDir);
        expect(type).toBe("rust");
    });

    it("detects python via requirements.txt", () => {
        write("requirements.txt", "flask");
        const { type } = detectProjectType(tmpDir);
        expect(type).toBe("python");
    });

    it("returns unknown for empty directory", () => {
        const { type } = detectProjectType(tmpDir);
        expect(type).toBe("unknown");
    });
});
