#!/usr/bin/env python3
"""
prepare_model.py — Download TinyLlama-1.1B-Chat-v1.0 from Hugging Face,
apply per-channel int8 quantization to every weight matrix, and export
per-layer binary files suitable for pipeline-parallel inference in the
browser via WebGPU.

Output layout
─────────────
  server/models/layers/layer_00.bin … layer_21.bin   (22 decoder layers)
  server/models/embedding.bin                         (token embedding table)
  server/models/final_head.bin                        (final RMSNorm + LM head)
  server/models/manifest.json                         (tensor metadata)
  server/models/tokenizer/                            (vocab, merges, chat template)

Quantization scheme  (simple per-channel int8)
──────────────────────────────────────────────
  For each 2-D weight tensor W of shape (out_features, …):
    scale[c] = max(abs(W[c, :])) / 127          # per output-channel
    quantized[c, :] = round(W[c, :] / scale[c]) # clamped to [-128, 127]

  Both `quantized` (int8) and `scale` (float32) are stored contiguously in the
  .bin file.  The manifest records the exact byte offset, shape, and dtype of
  every tensor so the runtime can reconstruct them.

Usage:
    pip install torch transformers sentencepiece protobuf
    python scripts/prepare_model.py
"""

from __future__ import annotations

import json
import os
import struct
import sys
import time
from pathlib import Path

import numpy as np
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer


# ── paths ─────────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = REPO_ROOT / "server" / "models"
LAYERS_DIR = MODELS_DIR / "layers"
TOKENIZER_DIR = MODELS_DIR / "tokenizer"

MODEL_ID = "TinyLlama/TinyLlama-1.1B-Chat-v1.0"
NUM_DECODER_LAYERS = 22  # TinyLlama-1.1B has 22 decoder layers


# ── int8 quantization helpers ─────────────────────────────────────────────────

def quantize_per_channel_int8(
    weight: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Quantize a 2-D weight matrix to int8 with per-output-channel scaling.

    Args:
        weight: float32 array of shape (out_features, ...).

    Returns:
        quantized: int8 array of the same shape.
        scale:     float32 array of shape (out_features,).
    """
    assert weight.ndim >= 1, "weight must be at least 1-D"

    # Reshape to (out_features, -1) so each "channel" is one row
    orig_shape = weight.shape
    flat = weight.reshape(orig_shape[0], -1).astype(np.float32)

    # Per-channel absmax
    absmax = np.max(np.abs(flat), axis=1)  # (out_features,)
    # Avoid division by zero for all-zero channels
    absmax = np.where(absmax == 0, 1.0, absmax)

    scale = absmax / 127.0  # float32, shape (out_features,)

    # Quantize
    quantized = np.round(flat / scale[:, None]).astype(np.int8)
    quantized = quantized.reshape(orig_shape)

    return quantized, scale.astype(np.float32)


# ── binary packing helpers ────────────────────────────────────────────────────

class BinaryWriter:
    """Accumulate tensors into a single byte buffer and record metadata."""

    def __init__(self):
        self.buffer = bytearray()
        self.entries: list[dict] = []

    @property
    def offset(self) -> int:
        return len(self.buffer)

    def write_raw(self, data: bytes, name: str, shape: list[int], dtype: str):
        """Append raw bytes and record an entry."""
        byte_offset = self.offset
        self.buffer.extend(data)
        self.entries.append({
            "name": name,
            "shape": shape,
            "dtype": dtype,
            "byte_offset": byte_offset,
            "byte_length": len(data),
        })

    def write_tensor(self, arr: np.ndarray, name: str):
        """Write a numpy array (any dtype) with automatic metadata."""
        data = arr.tobytes()
        dtype_str = str(arr.dtype)  # e.g. "int8", "float32"
        self.write_raw(data, name, list(arr.shape), dtype_str)

    def write_quantized(self, weight: np.ndarray, name_prefix: str):
        """Quantize a weight to int8 and write both quantized + scale."""
        q, s = quantize_per_channel_int8(weight)
        self.write_tensor(q, f"{name_prefix}.quantized")
        self.write_tensor(s, f"{name_prefix}.scale")

    def save(self, path: Path) -> list[dict]:
        """Write buffer to disk and return tensor entries."""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(bytes(self.buffer))
        return self.entries


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    print(f"{'=' * 60}")
    print(f"  prepare_model.py — TinyLlama-1.1B int8 export")
    print(f"{'=' * 60}")
    print()

    # ── 1. Load model & tokenizer from Hugging Face ───────────────────────
    t0 = time.time()
    print(f"[1/5] Downloading / loading {MODEL_ID} …")
    print("       (this may take a few minutes on first run)")

    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.float32,
        low_cpu_mem_usage=True,
    )
    model.eval()

    elapsed = time.time() - t0
    print(f"       Model loaded in {elapsed:.1f}s")
    print()

    # Verify layer count
    n_layers = len(model.model.layers)
    assert n_layers == NUM_DECODER_LAYERS, (
        f"Expected {NUM_DECODER_LAYERS} decoder layers, got {n_layers}"
    )

    # ── 2. Create output directories ──────────────────────────────────────
    LAYERS_DIR.mkdir(parents=True, exist_ok=True)
    TOKENIZER_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[2/5] Output directories created:")
    print(f"       {LAYERS_DIR}")
    print(f"       {TOKENIZER_DIR}")
    print()

    # ── 3. Export per-layer binary files ──────────────────────────────────
    print(f"[3/5] Quantizing & exporting {NUM_DECODER_LAYERS} decoder layers …")

    manifest_files: list[dict] = []

    for layer_idx in range(NUM_DECODER_LAYERS):
        layer = model.model.layers[layer_idx]
        writer = BinaryWriter()
        state = layer.state_dict()

        for param_name in sorted(state.keys()):
            tensor = state[param_name].detach().cpu().numpy()
            full_name = f"model.layers.{layer_idx}.{param_name}"

            # Quantize weight matrices (2-D+), keep biases / norms as float32
            if tensor.ndim >= 2:
                writer.write_quantized(tensor, full_name)
            else:
                writer.write_tensor(tensor.astype(np.float32), full_name)

        filename = f"layer_{layer_idx:02d}.bin"
        filepath = LAYERS_DIR / filename
        entries = writer.save(filepath)
        file_size = filepath.stat().st_size

        manifest_files.append({
            "filename": f"layers/{filename}",
            "layer_index": layer_idx,
            "tensors": entries,
            "size_bytes": file_size,
        })

        size_mb = file_size / (1024 * 1024)
        print(f"       layer_{layer_idx:02d}.bin  — {size_mb:6.2f} MB  ({len(entries)} tensors)")

    print()

    # ── 3b. Export embedding table ────────────────────────────────────────
    print("       Exporting embedding.bin …")
    embed_writer = BinaryWriter()
    embed_weight = model.model.embed_tokens.weight.detach().cpu().numpy()
    embed_writer.write_quantized(embed_weight, "model.embed_tokens.weight")

    embed_path = MODELS_DIR / "embedding.bin"
    embed_entries = embed_writer.save(embed_path)
    embed_size = embed_path.stat().st_size
    manifest_files.append({
        "filename": "embedding.bin",
        "tensors": embed_entries,
        "size_bytes": embed_size,
    })
    print(f"       embedding.bin       — {embed_size / (1024 * 1024):6.2f} MB")

    # ── 3c. Export final RMSNorm + LM head ───────────────────────────────
    print("       Exporting final_head.bin …")
    head_writer = BinaryWriter()

    # Final layer norm (RMSNorm)
    norm_weight = model.model.norm.weight.detach().cpu().numpy()
    head_writer.write_tensor(
        norm_weight.astype(np.float32), "model.norm.weight"
    )

    # LM head (linear projection to vocab)
    lm_head_weight = model.lm_head.weight.detach().cpu().numpy()
    head_writer.write_quantized(lm_head_weight, "lm_head.weight")

    head_path = MODELS_DIR / "final_head.bin"
    head_entries = head_writer.save(head_path)
    head_size = head_path.stat().st_size
    manifest_files.append({
        "filename": "final_head.bin",
        "tensors": head_entries,
        "size_bytes": head_size,
    })
    print(f"       final_head.bin      — {head_size / (1024 * 1024):6.2f} MB")
    print()

    # ── 4. Write manifest.json ────────────────────────────────────────────
    print("[4/5] Writing manifest.json …")

    # Collect model config metadata
    config = model.config
    manifest = {
        "model_id": MODEL_ID,
        "architecture": "LlamaForCausalLM",
        "num_decoder_layers": NUM_DECODER_LAYERS,
        "hidden_size": config.hidden_size,
        "intermediate_size": config.intermediate_size,
        "num_attention_heads": config.num_attention_heads,
        "num_key_value_heads": config.num_key_value_heads,
        "vocab_size": config.vocab_size,
        "max_position_embeddings": config.max_position_embeddings,
        "rms_norm_eps": config.rms_norm_eps,
        "rope_theta": getattr(config, "rope_theta", 10000.0),
        "quantization": {
            "method": "per_channel_int8",
            "description": (
                "Per output-channel absmax int8 quantization. "
                "scale = absmax(channel) / 127. "
                "quantized = round(weight / scale), clamped to [-128, 127]. "
                "1-D tensors (biases, norms) stored as float32."
            ),
        },
        "files": manifest_files,
    }

    manifest_path = MODELS_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"       {manifest_path}")
    print()

    # ── 5. Export tokenizer ───────────────────────────────────────────────
    print("[5/5] Exporting tokenizer …")

    # Save the full HF tokenizer config for reference
    tokenizer.save_pretrained(str(TOKENIZER_DIR))

    # Also write a simplified JSON for browser consumption
    tokenizer_export: dict = {}

    # Vocab: token → id
    tokenizer_export["vocab"] = tokenizer.get_vocab()

    # Merges (BPE merge rules) if available
    if hasattr(tokenizer, "bpe_ranks"):
        # sentencepiece-based tokenizers won't have this directly;
        # fall back to the merges file saved by save_pretrained
        pass

    # Try to read merges.txt produced by save_pretrained
    merges_path = TOKENIZER_DIR / "merges.txt"
    if merges_path.exists():
        merges_lines = merges_path.read_text().strip().split("\n")
        # Skip the header line if present
        if merges_lines and merges_lines[0].startswith("#"):
            merges_lines = merges_lines[1:]
        tokenizer_export["merges"] = merges_lines
    else:
        tokenizer_export["merges"] = []

    # Special tokens
    tokenizer_export["special_tokens"] = {
        "bos_token": str(tokenizer.bos_token) if tokenizer.bos_token else None,
        "eos_token": str(tokenizer.eos_token) if tokenizer.eos_token else None,
        "pad_token": str(tokenizer.pad_token) if tokenizer.pad_token else None,
        "unk_token": str(tokenizer.unk_token) if tokenizer.unk_token else None,
    }
    tokenizer_export["bos_token_id"] = tokenizer.bos_token_id
    tokenizer_export["eos_token_id"] = tokenizer.eos_token_id

    # Chat template (Jinja2 string used by transformers)
    chat_template = getattr(tokenizer, "chat_template", None)
    if chat_template:
        tokenizer_export["chat_template"] = chat_template

    # Model max length
    tokenizer_export["model_max_length"] = getattr(
        tokenizer, "model_max_length", 2048
    )

    tokenizer_json_path = TOKENIZER_DIR / "tokenizer_export.json"
    tokenizer_json_path.write_text(
        json.dumps(tokenizer_export, indent=2, ensure_ascii=False)
    )

    print(f"       Tokenizer files saved to {TOKENIZER_DIR}/")
    print(f"       Browser-friendly export: {tokenizer_json_path}")
    print()

    # ── summary ───────────────────────────────────────────────────────────
    total_bytes = sum(f["size_bytes"] for f in manifest_files)
    total_mb = total_bytes / (1024 * 1024)

    print(f"{'=' * 60}")
    print(f"  Done!  Total model size: {total_mb:.1f} MB (int8 quantized)")
    print()
    print(f"  Per-file sizes:")
    for f in manifest_files:
        size_mb = f["size_bytes"] / (1024 * 1024)
        print(f"    {f['filename']:30s}  {size_mb:6.2f} MB")
    print()
    print(f"  Manifest:   {manifest_path}")
    print(f"  Tokenizer:  {TOKENIZER_DIR}/")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
