# Training Data Collection & Fine-tuning

## Step 1 — Collect training data

Enable collection before running the agent:

```
COLLECT_TRAINING_DATA=1 node src/agent/agent.js
```

Each successful tool call is saved to `dataset/runs.jsonl`.
Aim for 50–200 examples before fine-tuning.

Check collection progress:
```js
import { printStats } from "./collector.js";
printStats();
```

## Step 2 — Fine-tune on your laptop

Install Python dependencies:
```
pip install unsloth trl datasets transformers torch
```

Run fine-tuning (overnight recommended):
```
python src/training/finetune.py
```

This uses QLoRA 4-bit quantisation to fit the 7B model into 4GB VRAM.
Training takes ~2–4 hours on the RTX 3050 Ti.

## Step 3 — Register with Ollama

```
ollama create company-coder -f src/training/Modelfile
```

## Step 4 — Switch the agent to use your model

In `src/agent/ollamaClient.js` and `src/agent/planner.js`:
```js
const MODEL = "company-coder";
```

## What gets learned

The model learns your team's specific patterns:
- Which tools to call for which types of tasks
- Your project naming conventions
- Your codebase structure and file organisation
- Common patterns in your stack (React, Spring Boot, etc.)

Private data stays entirely on your laptop. Nothing is sent to any cloud service.
