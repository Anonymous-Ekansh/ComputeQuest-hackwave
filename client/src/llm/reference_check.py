#!/usr/bin/env python3
"""
reference_check.py — Run TinyLlama layer-by-layer using HuggingFace
transformers and dump hidden-state outputs for numerical comparison
against the WebGPU implementation.

Usage:
    python reference_check.py --layer 0
    python reference_check.py --layer 0 --prompt "Hello world"
    python reference_check.py --layer 0 --compare webgpu_output.json

Output: reference_output.json with shape, flattened hidden states,
        and the token IDs used.

When --compare is given, the script also loads the WebGPU output JSON
and prints the max absolute difference.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer


MODEL_ID = "TinyLlama/TinyLlama-1.1B-Chat-v1.0"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--layer", type=int, default=0,
        help="Dump hidden state after this layer index (0-indexed, default 0)",
    )
    parser.add_argument(
        "--prompt", type=str,
        default="The quick brown fox jumps over the lazy dog.",
        help="Input prompt to tokenise",
    )
    parser.add_argument(
        "--output", type=str, default="reference_output.json",
        help="Where to write the reference hidden states",
    )
    parser.add_argument(
        "--compare", type=str, default=None,
        help="Path to a WebGPU output JSON to compare against",
    )
    args = parser.parse_args()

    # ── load model ────────────────────────────────────────────────────────
    print(f"Loading {MODEL_ID} …")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID, torch_dtype=torch.float32
    )
    model.eval()

    # ── tokenise ──────────────────────────────────────────────────────────
    inputs = tokenizer(args.prompt, return_tensors="pt")
    input_ids = inputs.input_ids                          # [1, seq_len]
    seq_len   = input_ids.shape[1]
    position_ids = torch.arange(seq_len).unsqueeze(0)     # [1, seq_len]

    print(f"Prompt : {args.prompt!r}")
    print(f"Tokens : {input_ids.squeeze().tolist()}")
    print(f"SeqLen : {seq_len}")
    print()

    # ── layer-by-layer forward ────────────────────────────────────────────
    with torch.no_grad():
        hidden = model.model.embed_tokens(input_ids)       # [1, S, 2048]
        print(f"After embedding : shape={list(hidden.shape)}")

        for i in range(args.layer):
            layer = model.model.layers[i]
            out = layer(hidden, position_ids=position_ids, use_cache=False)
            hidden = out[0]
            
        layer_input = hidden.clone()
        rms_in = torch.sqrt(torch.mean(layer_input ** 2)).item()
        print(f"  Input to Layer {args.layer:2d} → rms={rms_in:.6f}")
        
        layer = model.model.layers[args.layer]
        out = layer(layer_input, position_ids=position_ids, use_cache=False)
        hidden = out[0]
        rms = torch.sqrt(torch.mean(hidden ** 2)).item()
        print(f"  Output of Layer {args.layer:2d} → rms={rms:.6f}  "
              f"min={hidden.min().item():.6f}  max={hidden.max().item():.6f}")

    layer_input_np = layer_input.squeeze(0).numpy()
    hidden_np = hidden.squeeze(0).numpy()                  # [S, 2048]

    # ── write reference input ─────────────────────────────────────────────
    ref_in = {
        "model_id":   MODEL_ID,
        "prompt":     args.prompt,
        "layer":      args.layer,
        "input_ids":  input_ids.squeeze().tolist(),
        "shape":      list(layer_input_np.shape),
        "hidden_states": layer_input_np.flatten().tolist(),
    }
    input_output_path = args.output.replace(".json", "_input.json")
    if input_output_path == args.output:
        input_output_path = args.output + "_input.json"
    Path(input_output_path).write_text(json.dumps(ref_in))
    print(f"\nWrote layer input → {input_output_path}")

    # ── write reference ───────────────────────────────────────────────────
    ref = {
        "model_id":   MODEL_ID,
        "prompt":     args.prompt,
        "layer":      args.layer,
        "input_ids":  input_ids.squeeze().tolist(),
        "shape":      list(hidden_np.shape),
        "hidden_states": hidden_np.flatten().tolist(),
    }
    Path(args.output).write_text(json.dumps(ref))
    print(f"\nWrote reference → {args.output}  ({hidden_np.size} floats)")

    # ── optional comparison ───────────────────────────────────────────────
    if args.compare:
        print(f"\n── Comparing with {args.compare} ──")
        with open(args.compare) as f:
            gpu_data = json.load(f)

        gpu_arr = np.array(gpu_data["hidden_states"], dtype=np.float32)
        ref_arr = hidden_np.flatten()

        if gpu_arr.shape != ref_arr.shape:
            print(f"⚠  Shape mismatch: reference {ref_arr.shape} vs gpu {gpu_arr.shape}")
            sys.exit(1)

        diff     = np.abs(ref_arr - gpu_arr)
        max_diff = diff.max()
        mean_diff = diff.mean()
        p99_diff = np.percentile(diff, 99)

        print(f"  Elements    : {ref_arr.size}")
        print(f"  Max |diff|  : {max_diff:.6e}")
        print(f"  Mean |diff| : {mean_diff:.6e}")
        print(f"  P99 |diff|  : {p99_diff:.6e}")

        TOLERANCE = 1e-2
        if max_diff < TOLERANCE:
            print(f"  ✅ PASS  (max diff {max_diff:.2e} < {TOLERANCE})")
        else:
            print(f"  ❌ FAIL  (max diff {max_diff:.2e} >= {TOLERANCE})")
            # Find worst-offending indices
            worst_idx = np.argsort(diff)[-10:][::-1]
            print("  Worst 10 indices:")
            for idx in worst_idx:
                print(f"    [{idx}]  ref={ref_arr[idx]:.6f}  gpu={gpu_arr[idx]:.6f}  "
                      f"diff={diff[idx]:.6e}")


if __name__ == "__main__":
    main()
