"""
fine-tune qwen2.5-coder:7b on collected agent run data using Unsloth + QLoRA.

Workflow:
    1. Run agent with COLLECT_TRAINING_DATA=1   -> produces dataset/runs.jsonl
    2. node src/training/formatter.js            -> produces dataset/train.jsonl + eval.jsonl
    3. python src/training/finetune.py           -> fine-tunes and exports GGUF
    4. ollama create company-coder -f output/Modelfile

Requirements:
    pip install unsloth trl datasets transformers
"""

from unsloth import FastLanguageModel
from trl import SFTTrainer
from transformers import TrainingArguments
from datasets import load_dataset
import os
import json

# Config
BASE_MODEL = "unsloth/Qwen2.5-Coder-7B-Instruct"
DATASET_DIR = os.path.join(os.path.dirname(__file__), "dataset")
TRAIN_FILE  = os.path.join(DATASET_DIR, "train.jsonl")
EVAL_FILE   = os.path.join(DATASET_DIR, "eval.jsonl")
STATS_FILE  = os.path.join(DATASET_DIR, "stats.json")
OUTPUT_DIR  = os.path.join(os.path.dirname(__file__), "output")
MAX_SEQ_LEN = 4096
LORA_RANK   = 16

# Validate formatted data exists
if not os.path.exists(TRAIN_FILE):
    raise FileNotFoundError(
        f"No formatted training data at {TRAIN_FILE}.\n"
        "Steps:\n"
        "  1. Run the agent with COLLECT_TRAINING_DATA=1\n"
        "  2. node src/training/formatter.js"
    )

# Print dataset stats from formatter
if os.path.exists(STATS_FILE):
    with open(STATS_FILE) as f:
        stats = json.load(f)
    print(f"Dataset: {stats['trainExamples']} train, {stats['evalExamples']} eval examples")
    print(f"Avg quality: {stats['avgQuality']}  Tools: {stats['toolCounts']}")

# Load train + eval splits (produced by formatter.js)
train_dataset = load_dataset("json", data_files=TRAIN_FILE, split="train")
eval_dataset  = load_dataset("json", data_files=EVAL_FILE, split="train") \
    if os.path.exists(EVAL_FILE) else None

print(f"Loaded {len(train_dataset)} train examples", end="")
if eval_dataset:
    print(f", {len(eval_dataset)} eval examples")
else:
    print()


def format_example(example):
    """Convert messages list to a single formatted string for SFT."""
    parts = []
    for msg in example.get("messages", []):
        parts.append(f"<|{msg['role'].upper()}|>\n{msg['content']}")
    parts.append("<|END|>")
    return {"text": "\n".join(parts)}


train_dataset = train_dataset.map(format_example)
if eval_dataset:
    eval_dataset = eval_dataset.map(format_example)

# Load base model with 4-bit QLoRA (fits in 4 GB VRAM)
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name     = BASE_MODEL,
    max_seq_length = MAX_SEQ_LEN,
    load_in_4bit   = True,
)

model = FastLanguageModel.get_peft_model(
    model,
    r              = LORA_RANK,
    target_modules = ["q_proj", "k_proj", "v_proj", "o_proj",
                      "gate_proj", "up_proj", "down_proj"],
    lora_alpha     = LORA_RANK,
    lora_dropout   = 0,
    bias           = "none",
    use_gradient_checkpointing = True,
)

# Training
trainer = SFTTrainer(
    model              = model,
    tokenizer          = tokenizer,
    train_dataset      = train_dataset,
    eval_dataset       = eval_dataset,
    dataset_text_field = "text",
    max_seq_length     = MAX_SEQ_LEN,
    args = TrainingArguments(
        output_dir                  = OUTPUT_DIR,
        num_train_epochs            = 3,
        per_device_train_batch_size = 2,
        gradient_accumulation_steps = 4,
        warmup_steps                = 10,
        learning_rate               = 2e-4,
        fp16                        = True,
        logging_steps               = 10,
        save_strategy               = "epoch",
        evaluation_strategy         = "epoch" if eval_dataset else "no",
        load_best_model_at_end      = True if eval_dataset else False,
        report_to                   = "none",
    ),
)

print("Starting fine-tuning...")
trainer.train()
print("Fine-tuning complete.")

# Export to GGUF for Ollama
gguf_path = os.path.join(OUTPUT_DIR, "company-coder")
print(f"Exporting GGUF to {gguf_path} ...")
model.save_pretrained_gguf(gguf_path, tokenizer, quantization_method="q4_k_m")

modelfile_path = os.path.join(OUTPUT_DIR, "Modelfile")
with open(modelfile_path, "w") as f:
    f.write(f'FROM {gguf_path}-Q4_K_M.gguf\n')
    f.write('SYSTEM "You are an expert AI coding agent. Output only valid JSON tool calls."\n')

print(f"\nDone. Register with Ollama:\n  ollama create company-coder -f {modelfile_path}")
print("Then in src/agent/ollamaClient.js set: const MODEL = 'company-coder'")
