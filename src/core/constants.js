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

export const MAX_FILE_SIZE = 12000;
export const BUILD_TIMEOUT_MS = 120000;

// Memory layer
export const MEMORY_COLLECTION_PREFIX = "memory_";
export const MEMORY_MAX_RESULTS = 3;
export const MEMORY_MAX_SNIPPET = 400;

// Context compression: summarise execution context every N steps
export const COMPRESS_EVERY_N_STEPS = 3;
export const COMPRESS_MAX_CHARS = 6000;  // trigger compression above this
