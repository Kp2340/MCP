# AI Dev MCP

AI Dev MCP is a **local autonomous coding environment** that enables AI models to safely interact with real software projects using the **Model Context Protocol (MCP)**.

It allows an AI agent to:

* explore large codebases
* perform semantic code search
* read and modify files
* run project builds
* automatically fix compilation errors
* analyze project dependencies

All components run **locally**, ensuring privacy, security, and full control over development workflows.

---

# Features

* MCP Tool Server
* semantic code indexing
* vector code search using ChromaDB
* dependency graph analysis
* Git branch automation
* automated builds
* build error auto-fix loop
* AST-based project indexing
* multi-project configuration
* local LLM integration using Ollama

---

# Requirements

Install the following dependencies before running the system:

| Tool            | Purpose                          |
| --------------- | -------------------------------- |
| Node.js **20+** | Runtime for MCP server and agent |
| Ollama          | Local LLM inference              |
| ChromaDB CLI    | Vector database                  |
| Ripgrep         | Fast code searching              |

---

## Install Ripgrep

Windows:

```
winget install BurntSushi.ripgrep.MSVC
```

---

# Installation

Clone the repository and install dependencies.

```
git clone https://github.com/kp2340/mcp
cd mcp
npm install
```

---

# Project Configuration

Projects are defined in:

```
src/config/projects.json
```

Example configuration:

```
{
  "jsv": {
    "root": "C:/Users/kushp/IdeaProjects/jsv solution",
    "type": "nextjs",
    "buildCommand": "npm run build",
    "branchPrefix": "JSV"
  }
}
```

This allows the agent to operate across **multiple codebases**.

---

# First Time Setup

Before running the agent, build the **vector index** for your project.

```
node src/vector/runIndex.js <project-name>
```

Example:

```
node src/vector/runIndex.js jsv
```

This process:

1. scans project files
2. splits code into chunks
3. generates embeddings
4. stores vectors in ChromaDB

---

# Running the System

Start the environment:

```
start-ai-dev.bat
```

This launches three services.

| Service      | Description              |
| ------------ | ------------------------ |
| ChromaDB     | Vector database          |
| MCP Server   | Tool server              |
| AI Agent CLI | Interactive coding agent |

Ollama runs automatically in the background.

---

# Quick Start

1️⃣ Install dependencies

```
npm install
```

2️⃣ Build vector index

```
node src/vector/runIndex.js jsv
```

3️⃣ Start MCP environment

```
start-ai-dev.bat
```

4️⃣ Enter a prompt in the Agent CLI

Example:

```
Create login page in jsv project
```

---

# Example Prompt

```
Create a login page in jsv project with email/password authentication
```

Agent workflow:

```
vector search
↓
planner
↓
executor
↓
MCP tools
↓
code modification
↓
project build
↓
auto fix errors
```

---

# MCP Tools

The MCP server exposes tools that the AI agent can use to interact with projects.

| Tool                     | Purpose                           |
| ------------------------ | --------------------------------- |
| project_scan             | Scan project structure            |
| project_search           | Search code using ripgrep         |
| project_read_files       | Read project files                |
| project_apply_changes    | Write files and commit            |
| project_apply_patch      | Apply git diff patch              |
| project_build            | Run project build                 |
| project_build_and_fix    | Build project and auto-fix errors |
| project_index            | Build semantic code index         |
| project_find_symbol      | Find classes/functions            |
| project_dependency_graph | Analyze project dependencies      |

---

# Architecture

```
User
 │
Agent CLI
 │
Planner LLM
 │
Executor LLM
 │
Vector Retrieval
 │
MCP Client
 │
MCP Tool Server
 │
Tools
 │
Filesystem / Git
 │
Build + Auto Fix
 │
Dependency Graph Analysis
```

---

# Project Structure

```
src/
├─ agent/
│  ├─ planner.js
│  ├─ executor.js
│  ├─ mcpClient.js
│  └─ retriever.js
│
├─ analysis/
│  └─ dependencyGraph.js
│
├─ autoFixLoop/
│  └─ autoFixLoop.js
│
├─ build/
│  └─ parseBuildErrors.js
│
├─ config/
│  └─ projects.json
│
├─ core/
│  ├─ constants.js
│  ├─ projectRegistry.js
│  └─ validator.js
│
├─ git/
│  ├─ branch.js
│  └─ commit.js
│
├─ indexer/
│  ├─ languageLoader.js
│  └─ semanticIndexer.js
│
├─ tools/
│  ├─ scanProject.js
│  ├─ projectSearch.js
│  ├─ projectBuild.js
│  ├─ projectPatch.js
│  ├─ projectIndex.js
│  └─ applyChanges.js
│
├─ vector/
│  ├─ embedder.js
│  ├─ queryCodebase.js
│  ├─ runIndex.js
│  └─ runIndexCore.js
│
└─ index.js
```

---

# Troubleshooting

### Chroma collection error

Run indexing again:

```
node src/vector/runIndex.js <project-name>
```

---

### Ollama port error

Ollama runs as a background service.

Do **not run**:

```
ollama serve
```

---

### Missing vector results

Rebuild the index:

```
node src/vector/runIndex.js <project-name>
```

---

# Security

The MCP server includes safeguards to prevent unsafe file access:

* path validation
* project root isolation
* controlled git operations
* patch validation

---

# Future Improvements

* AST patch editing
* dependency graph reasoning improvements
* token-efficient memory compression
* multi-agent architecture (planner / coder / reviewer)
* repository-wide reasoning
* long-term project memory

---

# License

MIT License

---

# Author

Kp2340