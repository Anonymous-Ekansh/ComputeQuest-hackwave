#!/usr/bin/env python3
"""
Convert DeepChem/ChemBERTa-77M-MTR to ONNX format for Transformers.js.

Run once:
    pip install optimum[onnxruntime] transformers
    python scripts/convert_chemberta.py

Output: server/models/chemberta-77m-mtr-onnx/
  ├── config.json
  ├── tokenizer.json
  ├── tokenizer_config.json
  ├── special_tokens_map.json
  └── model.onnx

Then upload this folder to a HuggingFace repo or serve from your static assets.
"""

import os
import sys
import json
import subprocess

MODEL_ID = "DeepChem/ChemBERTa-77M-MTR"
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "server", "models", "chemberta-77m-mtr-onnx")

def main():
    print(f"Converting {MODEL_ID} to ONNX...")
    print(f"Output directory: {OUTPUT_DIR}")
    
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # Use optimum-cli to export
    cmd = [
        sys.executable, "-m", "optimum.exporters.onnx",
        "--model", MODEL_ID,
        "--task", "feature-extraction",
        OUTPUT_DIR
    ]
    
    print(f"Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=False)
    
    if result.returncode != 0:
        print("\nFailed! Try installing dependencies:")
        print("  pip install optimum[onnxruntime] transformers torch")
        sys.exit(1)
    
    print(f"\n✓ ONNX model exported to {OUTPUT_DIR}")
    print("\nNext steps:")
    print("  1. Upload this folder to a HuggingFace repo (e.g., your-username/ChemBERTa-77M-MTR-ONNX)")
    print("  2. Or serve it from your Express server / CDN")
    print("  3. Update the model URL in server/data/reference_antibiotics.json")
    
    # Also generate reference embeddings while we have the model loaded
    print("\n--- Generating reference embeddings ---")
    generate_reference_embeddings()

def generate_reference_embeddings():
    """Generate embeddings for reference antibiotics using the converted ONNX model."""
    try:
        from transformers import AutoTokenizer, AutoModel
        import torch
        import numpy as np
    except ImportError:
        print("Skipping reference embedding generation (need transformers + torch)")
        return
    
    ref_path = os.path.join(os.path.dirname(__file__), "..", "server", "data", "reference_antibiotics.json")
    with open(ref_path) as f:
        ref_data = json.load(f)
    
    print(f"Loading model {MODEL_ID}...")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModel.from_pretrained(MODEL_ID)
    model.eval()
    
    embeddings = []
    for antibiotic in ref_data["reference_antibiotics"]:
        smiles = antibiotic["smiles"]
        inputs = tokenizer(smiles, return_tensors="pt", padding=True, truncation=True, max_length=512)
        
        with torch.no_grad():
            outputs = model(**inputs)
        
        # Mean pooling over token embeddings (excluding padding)
        attention_mask = inputs["attention_mask"]
        token_embeddings = outputs.last_hidden_state
        input_mask_expanded = attention_mask.unsqueeze(-1).expand(token_embeddings.size()).float()
        embedding = torch.sum(token_embeddings * input_mask_expanded, 1) / torch.clamp(input_mask_expanded.sum(1), min=1e-9)
        
        emb_list = embedding[0].numpy().tolist()
        embeddings.append({
            "name": antibiotic["name"],
            "smiles": smiles,
            "class": antibiotic["class"],
            "embedding": emb_list
        })
        print(f"  ✓ {antibiotic['name']} ({len(emb_list)}d)")
    
    out_path = os.path.join(os.path.dirname(__file__), "..", "server", "data", "reference_embeddings.json")
    with open(out_path, "w") as f:
        json.dump({
            "model_id": MODEL_ID,
            "model_version": "v1",
            "embedding_dim": len(embeddings[0]["embedding"]),
            "embeddings": embeddings
        }, f, indent=2)
    
    print(f"\n✓ Reference embeddings saved to {out_path}")

if __name__ == "__main__":
    main()
