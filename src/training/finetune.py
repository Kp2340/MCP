"""
fine-tune qwen2.5-coder:7b on collected agent run data using Unsloth + QLoRA.

Workflow:
    1. Run agent with COLLECT_TRAINING_DATA=1   -> dataset/runs.jsonl
    2. node src/training/formatter.js            -> dataset/train.jsonl + eval.jsonl
    3. python src/training/finetune.py           -> fine-tunes and exports GGUF
    4. ollama create company-coder -f output/Modelfile

Flags:
    --dry-run          validate data + print stats, skip training
    --epochs N         number of training epochs (default: 3)
    --batch-size N     per-device batch size (default: 2)
    --lora-rank N      LoRA rank (default: 16)
    --min-examples N   abort if fewer than N training examples (default: 10)

Requirements:
    pip install unsloth trl datasets transformers
"""

import argparse
import json
import os
import sys

DATASET_DIR = os.path.join(os.path.dirname(__file__), "dataset")
TRAIN_FILE  = os.path.join(DATASET_DIR, "train.jsonl")
EVAL_FILE   = os.path.join(DATASET_DIR, "eval.jsonl")
STATS_FILE  = os.path.join(DATASET_DIR, "stats.json")
OUTPUT_DIR  = os.path.join(os.path.dirname(__file__), "output")

BASE_MODEL  = "unsloth/Qwen2.5-Coder-7B-Instruct"
MAX_SEQ_LEN = 4096


def parse_args():
    p = argparse.ArgumentParser(description="Fine-tune the MCP coding agent")
    p.add_argument("--dry-run",      action="store_true", help="validate data only, skip training")
    p.add_argument("--epochs",       type=int,   default=3,  help="training epochs")
    p.add_argument("--batch-size",   type=int,   default=2,  help="per-device batch size")
    p.add_argument("--lora-rank",    type=int,   default=16, help="LoRA rank")
    p.add_argument("--min-examples", type=int,   default=10, help="min training examples required")
    return p.parse_args()


def validate_data(min_examples):
    """Check that formatter output exists and meets minimum quality bar."""
    if not os.path.exists(TRAIN_FILE):
        print(
            f"[finetune] ERROR: no training data at {TRAIN_FILE}\n"
            "Run the agent with COLLECT_TRAINING_DATA=1 then:\n"
            "  node src/training/formatter.js",
            file=sys.stderr
        )
        sys.exit(1)

    with open(TRAIN_FILE) as f:
        train_lines = [l for l in f if l.strip()]
    n_train = len(train_lines)

    eval_lines = []
    if os.path.exists(EVAL_FILE):
        with open(EVAL_FILE) as f:
            eval_lines = [l for l in f if l.strip()]
    n_eval = len(eval_lines)

    print(f"[finetune] Training examples : {n_train}")
    print(f"[finetune] Eval examples     : {n_eval}")

    if os.path.exists(STATS_FILE):
        with open(STATS_FILE) as f:
            stats = json.load(f)
        print(f"[finetune] Avg quality score : {stats.get('avgQuality', '?')}")
        print(f"[finetune] Tool breakdown    : {stats.get('toolCounts', {})}")
        print(f"[finetune] Format            : {stats.get('format', '?')}")

    if n_train < min_examples:
        print(
            f"[finetune] ERROR: only {n_train} training examples, need at least {min_examples}.\n"
            "Collect more runs or lower --min-examples.",
            file=sys.stderr
        )
        sys.exit(1)

    # Validate that examples have the expected messages structure
    bad = 0
    for i, line in enumerate(train_lines[:20]):
        try:
            ex = json.loads(line)
            msgs = ex.get("messages", [])
            roles = [m["role"] for m in msgs]
            if roles != ["system", "user", "assistant"]:
                bad += 1
        except Exception:
            bad += 1
    if bad > 0:
        print(f"[finetune] WARNING: {bad}/20 sampled examples have unexpected structure")

    return n_train, n_eval


def format_example(example):
    """Convert messages list -> single text string for SFT."""
    parts = []
    for msg in example.get("messages", []):
        parts.append(f"<|{msg['role'].upper()}|>\n{msg['content']}")
    parts.append("<|END|>")
    return {"text": "\n".join(parts)}


def run_training(args, n_train, n_eval):
    """Import heavy deps only when actually training (not during dry-run)."""
    try:
        from unsloth import FastLanguageModel
        from trl import SFTTrainer
        from transformers import TrainingArguments
        from datasets import load_dataset
    except ImportError as e:
        print(
            f"[finetune] ERROR: missing dependency: {e}\n"
            "Install with: pip install unsloth trl datasets transformers",
            file=sys.stderr
        )
        sys.exit(1)

    print(f"[finetune] Loading base model: {BASE_MODEL}")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name     = BASE_MODEL,
        max_seq_length = MAX_SEQ_LEN,
        load_in_4bit   = True,
    )

    model = FastLanguageModel.get_peft_model(
        model,
        r              = args.lora_rank,
        target_modules = ["q_proj", "k_proj", "v_proj", "o_proj",
                          "gate_proj", "up_proj", "down_proj"],
        lora_alpha     = args.lora_rank,
        lora_dropout   = 0,
        bias           = "none",
        use_gradient_checkpointing = True,
    )

    train_dataset = load_dataset("json", data_files=TRAIN_FILE, split="train")
    eval_dataset  = load_dataset("json", data_files=EVAL_FILE,  split="train") \
        if os.path.exists(EVAL_FILE) and n_eval > 0 else None

    train_dataset = train_dataset.map(format_example)
    if eval_dataset:
        eval_dataset = eval_dataset.map(format_example)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    trainer = SFTTrainer(
        model              = model,
        tokenizer          = tokenizer,
        train_dataset      = train_dataset,
        eval_dataset       = eval_dataset,
        dataset_text_field = "text",
        max_seq_length     = MAX_SEQ_LEN,
        args = TrainingArguments(
            output_dir                  = OUTPUT_DIR,
            num_train_epochs            = args.epochs,
            per_device_train_batch_size = args.batch_size,
            gradient_accumulation_steps = 4,
            warmup_steps                = 10,
            learning_rate               = 2e-4,
            fp16                        = True,
            logging_steps               = 10,
            save_strategy               = "epoch",
            evaluation_strategy         = "epoch" if eval_dataset else "no",
            load_best_model_at_end      = eval_dataset is not None,
            report_to                   = "none",
        ),
    )

    print(f"[finetune] Starting training ({args.epochs} epochs, batch={args.batch_size}, lora_rank={args.lora_rank})...")
    trainer.train()
    print("[finetune] Training complete.")

    gguf_path = os.path.join(OUTPUT_DIR, "company-coder")
    print(f"[finetune] Exporting GGUF to {gguf_path} ...")
    model.save_pretrained_gguf(gguf_path, tokenizer, quantization_method="q4_k_m")

    modelfile_path = os.path.join(OUTPUT_DIR, "Modelfile")
    with open(modelfile_path, "w") as f:
        f.write(f"FROM {gguf_path}-Q4_K_M.gguf\n")
        f.write('SYSTEM "You are an expert AI coding agent. Output only valid JSON tool calls."\n')

    print(f"\n[finetune] Done. Register with Ollama:")
    print(f"  ollama create company-coder -f {modelfile_path}")
    print(f"Then set LLM_MODEL=company-coder in your .env")


def main():
    args = parse_args()
    n_train, n_eval = validate_data(args.min_examples)

    if args.dry_run:
        print("[finetune] Dry-run complete — data looks good. Run without --dry-run to train.")
        return

    run_training(args, n_train, n_eval)


if __name__ == "__main__":
    main()
