# scripts/README.md — Model Preparation

## `prepare_model.py`

Downloads **TinyLlama/TinyLlama-1.1B-Chat-v1.0** from Hugging Face, applies
per-channel **int8 quantization** to every weight matrix, and exports the model
in a per-decoder-layer binary format ready for pipeline-parallel inference in
the browser via WebGPU.

### Prerequisites

| Requirement | Version |
|---|---|
| Python | ≥ 3.9 |
| Disk space | ~5 GB free (for HF cache + exported files) |
| RAM | ≥ 8 GB recommended |

### Install dependencies

```bash
pip install torch transformers sentencepiece protobuf numpy
```

> **Note:** If you have a CUDA GPU, `torch` will use it for download/load but
> the export itself runs on CPU. A CPU-only torch is fine:
> `pip install torch --index-url https://download.pytorch.org/whl/cpu`

### Run

```bash
cd /path/to/ComputeQuest-hackwave
python scripts/prepare_model.py
```

Expected runtime: **~3–5 minutes** depending on download speed and hardware.

### What it produces

```
server/models/
├── layers/
│   ├── layer_00.bin      # Decoder layer 0  (~20 MB each)
│   ├── layer_01.bin
│   │   …
│   └── layer_21.bin      # Decoder layer 21
├── embedding.bin          # Token embedding table
├── final_head.bin         # Final RMSNorm + LM head
├── manifest.json          # Tensor names, shapes, byte offsets, model config
└── tokenizer/
    ├── tokenizer_export.json   # Vocab + merges + chat template (browser-ready)
    ├── tokenizer.json          # Full HF tokenizer config
    ├── tokenizer_config.json
    └── special_tokens_map.json
```

### Quantization scheme

Every 2-D+ weight tensor is quantized per output channel:

```
scale[c] = max(|W[c, :]|) / 127
quantized[c, :] = clamp(round(W[c, :] / scale[c]), -128, 127)
```

Both `quantized` (int8) and `scale` (float32) are stored contiguously in each
`.bin` file. 1-D tensors (layer norms, biases) are stored as raw float32.

The `manifest.json` records every tensor's exact byte offset, shape, and dtype
so the runtime can memory-map or fetch byte ranges as needed.

### Why per-layer files?

The number of browser nodes available at demo time is variable (1–4 tabs).
Stages are assembled at runtime by grouping consecutive layer files — e.g.,
with 2 nodes, node 0 gets layers 0–10 and node 1 gets layers 11–21. This
avoids baking a fixed shard count into the model export.

### Re-running

The script is idempotent — re-running overwrites any existing files under
`server/models/`. The Hugging Face model cache (`~/.cache/huggingface/`) is
reused across runs so subsequent invocations skip the download step.
