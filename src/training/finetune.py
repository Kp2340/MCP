"""
fine-tune qwen2.5-coder:7b on collected agent run data using Unsloth + QLoRA.

Requirements:
    pip install unsloth trl datasets

Usage:
    python src/training/finetune.py

Outputs a GGUF model you can register with Ollama:
    ollama create company-coder -f Modelfile
"""

from unsloth import FastLanguageModel
from trl import SFTTrainer
from transformers import TrainingArguments
from datasets import load_dataset
import os

# ── Config ────────────────────────────────────────────────────────────────────
BASE_MODEL   = "unsloth/Qwen2.5-Coder-7B-Instruct"
DATASET_FILE = os.path.join(os.path.dirname(__file__), "dataset", "runs.jsonl")
OUTPUT_DIR   = os.path.join(os.path.dirname(__file__), "output")
MAX_SEQ_LEN  = 4096
LORA_RANK    = 16

# ── Load base model with 4-bit QLoRA (fits in 4 GB VRAM) ─────────────────────
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name     = BASE_MODEL,
    max_seq_length = MAX_SEQ_LEN,
    load_in_4bit   = True,
)

model = FastLanguageModel.get_peft_model(
    model,
    r                = LORA_RANK,
    target_modules   = ["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
    lora_alpha       = LORA_RANK,
    lora_dropout     = 0,
    bias             = "none",
    use_gradient_checkpointing = True,
)

# ── Dataset ───────────────────────────────────────────────────────────────────
if not os.path.exists(DATASET_FILE):
    raise FileNotFoundError(
        f"No training data found at {DATASET_FILE}.\n"
        "Run the agent with COLLECT_TRAINING_DATA=1 to collect examples first."
    )

dataset = load_dataset("json", data_files=DATASET_FILE, split="train")
print(f"Loaded {len(dataset)} training examples")


def format_example(example):
    """Convert messages list to a single formatted string for SFT."""
    parts = []
    for msg in example["messages"]:
        role    = msg["role"].upper()
        content = msg["content"]
        parts.append(f"<|{role}|>\n{content}")
    parts.append("<|END|>")
    return {"text": "\n".join(parts)}


dataset = dataset.map(format_example)

# ── Training ──────────────────────────────────────────────────────────────────
trainer = SFTTrainer(
    model           = model,
    tokenizer       = tokenizer,
    train_dataset   = dataset,
    dataset_text_field = "text",
    max_seq_length  = MAX_SEQ_LEN,
    args            = TrainingArguments(
        output_dir            = OUTPUT_DIR,
        num_train_epochs      = 3,
        per_device_train_batch_size = 2,
        gradient_accumulation_steps = 4,
        warmup_steps          = 10,
        learning_rate         = 2e-4,
        fp16                  = True,
        logging_steps         = 10,
        save_strategy         = "epoch",
        report_to             = "none",
    ),
)

print("Starting fine-tuning...")
trainer.train()
print("Fine-tuning complete.")

# ── Export to GGUF for Ollama ─────────────────────────────────────────────────
gguf_path = os.path.join(OUTPUT_DIR, "company-coder")
print(f"Exporting GGUF to {gguf_path} ...")
model.save_pretrained_gguf(gguf_path, tokenizer, quantization_method="q4_k_m")

modelfile_path = os.path.join(OUTPUT_DIR, "Modelfile")
with open(modelfile_path, "w") as f:
    f.write(f'FROM {gguf_path}-Q4_K_M.gguf\n')
    f.write('SYSTEM "You are an expert AI coding agent. Output only valid JSON tool calls."\n')

print(f"\nDone. Register with Ollama:\n  ollama create company-coder -f {modelfile_path}")
print("Then in ollamaClient.js set: const MODEL = 'company-coder'")
