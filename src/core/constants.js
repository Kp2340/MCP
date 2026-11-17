// Model config
import { config } from "./config.js";
export const LLM_MODEL          = config.LLM_MODEL;
export const LLM_TEMPERATURE    = 0.1;
export const OLLAMA_HOST        = config.OLLAMA_HOST;
export const CHROMA_HOST        = config.CHROMA_HOST;
export const CHROMA_PORT        = config.CHROMA_PORT;

// Embedding model versioning
export const EMBEDDING_MODEL    = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_VERSION  = "v1";

// Dynamic num_predict budgets per call type
export const NUM_PREDICT = {
    planner:        600,
    executor:       512,
    executor_apply: 2048,
    compressor:     400,
    reviewer:       300,
    memory:         120,
    autofix:        4096
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

// Memory layer
export const MEMORY_COLLECTION_PREFIX = "memory_";
export const MEMORY_MAX_RESULTS       = 3;
export const MEMORY_MAX_SNIPPET       = 400;
// Cap on how many entries are fetched in a single memory.get() call.
// Prevents OOM on large collections (fixes memory query performance issue).
export const MEMORY_QUERY_LIMIT       = 50;

// Context compression
export const COMPRESS_EVERY_N_STEPS = 3;
export const COMPRESS_MAX_CHARS     = 6000;

// Cost-aware agent
export const MAX_LLM_CALLS_PER_RUN   = 30;
export const MAX_TOTAL_TOKENS_PER_RUN = 60000;
export const MAX_REPLANS              = 3;
export const MAX_AGENT_STEPS          = 25; // hard cap — agent loop MUST stop after this many steps
export const MAX_RETRIES              = 2;  // per-step retry cap in executeWithRetry

// Progress heuristic kill — abort if no meaningful progress after N consecutive idle steps
export const MAX_IDLE_STEPS           = 5;  // steps with no file changes and no new errors

export const CHARS_PER_TOKEN = 4;

// ─── Tool name enum — single source of truth for all tool name strings ────────────────────
// Use TOOLS.X everywhere instead of bare string literals.
// Prevents typos, enables IDE autocomplete, and makes allowlists self-consistent.
export const TOOLS = {
    REGISTER:          "project_register",
    SCAN:              "project_scan",
    READ_FILES:        "project_read_files",
    APPLY_CHANGES:     "project_apply_changes",
    STR_REPLACE:       "project_str_replace",
    SEARCH:            "project_search",
    APPLY_PATCH:       "project_apply_patch",
    BUILD:             "project_build",
    BUILD_AND_FIX:     "project_build_and_fix",
    INDEX:             "project_index",
    FIND_SYMBOL:       "project_find_symbol",
    ANALYZE:           "project_analyze",
    TEST:              "project_test",
    DIFF:              "project_diff",
    GIT_LOG:           "project_git_log",
    RENAME_SYMBOL:     "project_rename_symbol",
    RENAME_SYMBOL_ALL: "project_rename_symbol_all",
    DEP_GRAPH:         "project_dependency_graph",
    SEMANTIC_SEARCH:   "project_semantic_search",
    MEMORY_STORE:      "project_memory_store",
    MEMORY_QUERY:      "project_memory_query",
    LIST:              "project_list",
};

// Memory eviction
export const MEMORY_MAX_ENTRIES = 200;
export const MEMORY_EVICT_BATCH = 20;

// Syntax batch check
export const SYNTAX_BATCH_SIZE = 50;

// Incremental index
export const INDEX_CACHE_FILE = ".ai-dev-index-cache.json";

// Tool-chain templates
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
            "Run build and fix to verify",
            "Run tests to confirm fix is correct"
        ]
    },
    {
        name:        "fix_failing_test",
        keywords:    ["test failing", "tests fail", "failing test", "fix test", "broken test"],
        projectTypes: null,
        intent:      "fix",
        steps: [
            "Run project tests to see current failures",
            "Run static analysis to identify issues",
            "Find the failing test file",
            "Read the failing test and the code it tests",
            "Apply targeted fix using project_str_replace",
            "Run tests again to verify all pass"
        ]
    },
    {
        name:        "add_api",
        keywords:    [
            "add api", "new endpoint", "add route", "create endpoint",
            "add service method", "implement api", "similar api",
            "endpoint",     // standalone -- lets multi-word prompts score >=2
            "add endpoint", // covers "add a new endpoint" after stem expansion
            "service",      // covers "user service", "api service"
            "controller",   // covers Spring/Express controllers
            "handler",
            "rest api",
            "graphql"
        ],
        projectTypes: null,
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
        keywords:    ["explain", "how does", "describe", "walk me through", "what does", "find api"],
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
            "Rename symbol across project using project_rename_symbol_all",
            "Apply any remaining structural changes using project_str_replace",
            "Run static analysis",
            "Run build and fix to verify"
        ]
    },
    {
        name:        "rename_symbol",
        keywords:    ["rename", "rename function", "rename class", "rename variable", "rename method", "rename constant"],
        projectTypes: null,
        intent:      "fix",
        steps: [
            "Find the relevant symbol in the project",
            "Rename symbol across project using project_rename_symbol_all",
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
            "Run build and fix to verify",
            "Run tests to confirm new tests pass"
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

// Keyword synonyms for heuristic planner (stem -> canonical)
// Maps gerund / past-tense / plural / British variant forms to the canonical
// keyword that appears in TOOL_CHAIN_TEMPLATES.keywords so stem normalisation fires.
export const KEYWORD_STEMS = {
    // core CRUD verbs
    "creating":     "create",
    "created":      "create",
    "adding":       "add",
    "added":        "add",
    "fixing":       "fix",
    "fixed":        "fix",
    "building":     "build",
    "built":        "build",
    "updating":     "update",
    "updated":      "update",
    "deleting":     "delete",
    "deleted":      "delete",
    "removing":     "remove",
    "removed":      "remove",
    "refactoring":  "refactor",
    "refactored":   "refactor",
    "renaming":     "rename",
    "renamed":      "rename",
    "testing":      "test",
    "tested":       "test",
    "analyzing":    "analyze",
    "analysing":    "analyze",
    "analysed":     "analyze",
    "analyzed":     "analyze",
    // API-specific aliases
    "endpoints":    "endpoint",
    "routes":       "route",
    "services":     "service",
    "controllers":  "controller",
    "handlers":     "handler",
    "implementing": "implement",
    "implemented":  "implement",
    // migration aliases
    "migrating":    "migration",
    "migrations":   "migration",
    "columns":      "column",
    "tables":       "table",
    // test aliases
    "tests":        "test",
    "specs":        "test",
    "spec":         "test",
    // explain / describe aliases
    "explaining":   "explain",
    "described":    "describe",
    "describing":   "describe",
    "finding":      "find",
};
