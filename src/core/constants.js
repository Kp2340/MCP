export const IGNORE_FOLDERS = [
    ".git",
    "node_modules",
    ".gradle",
    "build",
    "target",
    "dist",
    ".next",
    "out",
    ".cache",
    "coverage",
    "__pycache__",
    ".idea",
    ".vscode"
];

export const INDEXABLE_EXTENSIONS = [
    ".js", ".jsx", ".ts", ".tsx", ".java", ".py", ".kt", ".go"
];

export const MAX_FILE_SIZE     = 12000;
export const BUILD_TIMEOUT_MS  = 120000;

// ── Memory layer ──────────────────────────────────────────────────────────────
export const MEMORY_COLLECTION_PREFIX = "memory_";
export const MEMORY_MAX_RESULTS       = 3;
export const MEMORY_MAX_SNIPPET       = 400;

// ── Context compression ───────────────────────────────────────────────────────
export const COMPRESS_EVERY_N_STEPS = 3;
export const COMPRESS_MAX_CHARS     = 6000;

// ── Cost-aware agent ──────────────────────────────────────────────────────────
export const MAX_LLM_CALLS_PER_RUN   = 30;
export const MAX_TOTAL_TOKENS_PER_RUN = 60000;  // soft budget — triggers warning
export const MAX_REPLANS              = 3;

// Real token estimation: 1 token ≈ 4 chars (GPT/Qwen convention)
export const CHARS_PER_TOKEN = 4;

// ── Tool-chain templates ──────────────────────────────────────────────────────
export const TOOL_CHAIN_TEMPLATES = [
    {
        name:        "fix_error",
        keywords:    ["fix", "error", "bug", "crash", "exception", "broken", "failing"],
        projectTypes: null,   // applies to all project types
        intent:      "fix",
        steps: [
            "Run static analysis to identify issues",
            "Read the files mentioned in the errors",
            "Apply targeted fixes using project_str_replace",
            "Run build and fix to verify"
        ]
    },
    {
        name:        "add_api",
        keywords:    ["add api", "new endpoint", "add route", "create endpoint", "add service method"],
        projectTypes: ["spring-boot", "liferay-backend", "nodejs"],
        intent:      "api",
        steps: [
            "Find the relevant controller or service symbol",
            "Read the controller and service files",
            "Add the new method using project_str_replace",
            "Run static analysis",
            "Run build and fix to verify"
        ]
    },
    {
        name:        "add_ui_component",
        keywords:    ["add component", "create page", "add form", "create ui", "add screen"],
        projectTypes: ["react-vite", "nextjs"],
        intent:      "ui",
        steps: [
            "Scan project structure to find components folder",
            "Find similar existing component for reference",
            "Read the reference component",
            "Create the new component file using project_apply_changes",
            "Run static analysis",
            "Run build and fix to verify"
        ]
    },
    {
        name:        "fix_import_error",
        keywords:    ["import error", "module not found", "cannot find module", "unresolved import"],
        projectTypes: null,
        intent:      "fix",
        steps: [
            "Run static analysis to find broken imports",
            "Read the file with the broken import",
            "Fix the import path using project_str_replace",
            "Run build and fix to verify"
        ]
    },
    {
        name:        "read_only",
        keywords:    ["explain", "understand", "show me", "what is", "how does", "analyse", "analyze"],
        projectTypes: null,
        intent:      "general",
        steps: [
            "Find the relevant symbol in the project",
            "Read the relevant files"
        ]
    }
];
