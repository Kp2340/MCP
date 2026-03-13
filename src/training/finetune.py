"""
Fine-tune qwen2.5-coder:7b on your collected agent run data.

Requirements:
    pip install unsloth trl datasets transformers torch

Hardware: Works on RTX 3050 Ti (4GB VRAM) via QLoRA 4-bit.
Training time: ~2-4 hours for 200 examples, 3 epochs.

Steps:
    1. Collect data:  COLLECT_TRAINING_DATA=1 node src/agent/agent.js
    2. Fine-tune:     python src/training/finetune.py
    3. Register:      ollama create company-coder -f src/training/Modelfile
    4. Swap model:    set MODEL = "company-coder" in ollamaClient.js
"""

import os, json
from pathlib import Path

BASE_MODEL   = "unsloth/Qwen2.5-Coder-7B-Instruct"
DATASET_FILE = Path(__file__).parent / "dataset" / "runs.jsonl"
OUTPUT_DIR   = Path(__file__).parent / "output"
MODEL_NAME   = "my-coder-model"
LORA_RANK    = 16
EPOCHS       = 3
BATCH_SIZE   = 2
GRAD_ACCUM   = 4
MAX_SEQ_LEN  = 2048

def main():
    if not DATASET_FILE.exists():
        print(f"ERROR: No dataset at {DATASET_FILE}")
        print("Run the agent with COLLECT_TRAINING_DATA=1 first.")
        return

    examples = [json.loads(l) for l in DATASET_FILE.read_text().splitlines() if l.strip()]
    print(f"Loaded {len(examples)} training examples")

    if len(examples) < 10:
        print("WARNING: Collect at least 50 examples for meaningful improvement.")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    from unsloth import FastLanguageModel
    from trl import SFTTrainer, SFTConfig
    from datasets import Dataset

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=BASE_MODEL,
        max_seq_length=MAX_SEQ_LEN,
        dtype=None,
        load_in_4bit=True
    )

    model = FastLanguageModel.get_peft_model(
        model, r=LORA_RANK,
        target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"],
        lora_alpha=LORA_RANK, lora_dropout=0, bias="none",
        use_gradient_checkpointing="unsloth", random_state=42
    )

    texts   = [tokenizer.apply_chat_template(ex["messages"], tokenize=False, add_generation_prompt=False) for ex in examples]
    dataset = Dataset.from_dict({"text": texts})

    trainer = SFTTrainer(
        model=model, tokenizer=tokenizer, train_dataset=dataset,
        args=SFTConfig(
            dataset_text_field="text", max_seq_length=MAX_SEQ_LEN,
            per_device_train_batch_size=BATCH_SIZE,
            gradient_accumulation_steps=GRAD_ACCUM,
            num_train_epochs=EPOCHS, learning_rate=2e-4,
            fp16=True, logging_steps=10,
            output_dir=str(OUTPUT_DIR / "checkpoints"),
            warmup_ratio=0.1, lr_scheduler_type="cosine", report_to="none"
        )
    )
    trainer.train()

    gguf_path = str(OUTPUT_DIR / MODEL_NAME)
    model.save_pretrained_gguf(gguf_path, tokenizer, quantization_method="q4_k_m")

    gguf_file = OUTPUT_DIR / f"{MODEL_NAME}-Q4_K_M.gguf"
    modelfile = Path(__file__).parent / "Modelfile"
    modelfile.write_text(f'FROM {gguf_file}\n\nSYSTEM """You are an expert coding agent. Output ONLY a JSON tool call. No explanation, no markdown."""\n\nPARAMETER temperature 0.1\nPARAMETER num_predict 2048\n')

    print("\nDone! Next steps:")
    print(f"  ollama create company-coder -f {modelfile}")
    print('  Set MODEL = "company-coder" in src/agent/ollamaClient.js')

if __name__ == "__main__":
    main()
