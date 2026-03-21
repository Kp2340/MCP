// ── Model config (single source of truth — change here to swap models) ─────────
export const LLM_MODEL          = "qwen2.5-coder:7b";
export const LLM_TEMPERATURE    = 0.1;
export const OLLAMA_HOST        = process.env.OLLAMA_HOST || "http://localhost:11434";
export const CHROMA_HOST        = process.env.CHROMA_HOST || "localhost";
export const CHROMA_PORT        = parseInt(process.env.CHROMA_PORT || "8000", 10);

// ── Embedding model versioning — bump when swapping models to avoid stale vectors
export const EMBEDDING_MODEL    = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_VERSION  = "v1";  // appended to collection names

// ── Dynamic num_predict budgets per call type ──────────────────────────────
export const NUM_PREDICT = {
    planner:    600,
    executor:   512,
    executor_apply: 2048,
    compressor: 400,
    reviewer:   300,
    memory:     120,
    autofix:    4096
};

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
    ".js", ".jsx", ".ts", ".tsx",
    ".java", ".py", ".kt", ".go",
    ".rb", ".rs", ".xml"
];

export const MAX_FILE_SIZE     = 12000;
export const BUILD_TIMEOUT_MS  = 120000;

// ── Memory layer ───────────────────────────────────────────────────────
export const MEMORY_COLLECTION_PREFIX = "memory_";
export const MEMORY_MAX_RESULTS       = 3;
export const MEMORY_MAX_SNIPPET       = 400;

// ── Context compression ───────────────────────────────────────────────
export const COMPRESS_EVERY_N_STEPS = 3;
export const COMPRESS_MAX_CHARS     = 6000;

// ── Cost-aware agent ──────────────────────────────────────────────────
export const MAX_LLM_CALLS_PER_RUN   = 30;
export const MAX_TOTAL_TOKENS_PER_RUN = 60000;
export const MAX_REPLANS              = 3;

export const CHARS_PER_TOKEN = 4;

// ── Memory eviction ─────────────────────────────────────────────────────
export const MEMORY_MAX_ENTRIES       = 200;
export const MEMORY_EVICT_BATCH       = 20;

// ── Syntax batch check ──────────────────────────────────────────────────
export const SYNTAX_BATCH_SIZE        = 50;

// ── Incremental index ────────────────────────────────────────────────────
export const INDEX_CACHE_FILE         = ".ai-dev-index-cache.json";

// ── Tool-chain templates ────────────────────────────────────────────────
// projectTypes: null = works for ANY project type
export const TOOL_CHAIN_TEMPLATES = [
    {
        name:        "fix_error",
        keywords:    ["fix", "error", "bug", "crash", "exception", "broken", "failing"],
        projectTypes: null,
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
        keywords:    ["add api", "new endpoint", "add route", "create endpoint", "add service method", "implement api", "similar api"],
        projectTypes: null,   // was spring-boot/liferay/nodejs — now works for ALL
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
        name:        "ui_edit",
        keywords:    [
            "add", "update", "change", "modify", "insert", "put", "place",
            "footer", "header", "navbar", "sidebar", "banner", "button",
            "text", "label", "link", "color", "style", "class", "section",
            "made by", "copyright", "bottom", "top", "page"
        ],
        projectTypes: ["react-vite", "nextjs"],
        intent:      "ui",
        steps: [
            "Find the relevant component symbol in the project index",
            "Read the relevant component file",
            "Apply targeted changes using project_str_replace",
            "Run static analysis",
            "Run build and fix to verify"
        ]
    },
    {
        name:        "add_ui_component",
        keywords:    ["add component", "create page", "add form", "create ui", "add screen", "new page", "new component"],
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
        keywords:    ["explain", "understand", "show me", "what is", "how does", "analyse", "analyze", "tell me", "describe", "list all", "find api"],
        projectTypes: null,
        intent:      "general",
        steps: [
            "Find the relevant symbol in the project",
            "Read the relevant files"
        ]
    },
    {
        name:        "refactor",
        keywords:    ["refactor", "rename", "restructure", "move", "extract", "clean up"],
        projectTypes: null,
        intent:      "fix",
        steps: [
            "Run static analysis to identify issues",
            "Find the relevant symbol in the project",
            "Read the relevant files",
            "Apply targeted refactor using project_str_replace",
            "Run static analysis",
            "Run build and fix to verify"
        ]
    },
    {
        name:        "add_test",
        keywords:    ["add test", "write test", "create test", "unit test", "test for"],
        projectTypes: null,
        intent:      "general",
        steps: [
            "Find the relevant symbol in the project",
            "Read the relevant files",
            "Read similar existing test for reference",
            "Create the new test file using project_apply_changes",
            "Run static analysis",
            "Run build and fix to verify"
        ]
    },
    {
        name:        "add_db_migration",
        keywords:    ["add migration", "create migration", "add column", "add table", "alter table"],
        projectTypes: null,
        intent:      "api",
        steps: [
            "Scan project structure to find migrations folder",
            "Read similar existing migration for reference",
            "Create the new migration file using project_apply_changes",
            "Run static analysis",
            "Run build and fix to verify"
        ]
    }
];

// ── Keyword synonyms for heuristic planner (stem → canonical) ────────────────
export const KEYWORD_STEMS = {
    "creating": "create",
    "adding":   "add",
    "fixing":   "fix",
    "building": "build",
    "updating": "update",
    "deleting": "delete",
    "removing": "remove",
    "refactoring": "refactor",
    "renaming":  "rename",
    "testing":   "test",
    "analyzing": "analyze"
};
