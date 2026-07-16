/**
 * webgpu-kernels.js
 *
 * Complete WebGPU compute shaders + JS glue for one TinyLlama-1.1B decoder
 * layer.  Every operation is a real WGSL compute shader dispatched through the
 * WebGPU API — nothing is stubbed.
 *
 * TinyLlama-1.1B config
 * ─────────────────────
 *   hidden_size          2048
 *   num_attention_heads  32
 *   num_key_value_heads  4   (GQA, group_size = 8)
 *   head_dim             64
 *   intermediate_size    5632
 *   rms_norm_eps         1e-5
 *   rope_theta           10000.0
 *   num_hidden_layers    22
 */

// ════════════════════════════════════════════════════════════════════════════
// 1. Model constants
// ════════════════════════════════════════════════════════════════════════════

export const HIDDEN_SIZE        = 2048;
export const NUM_HEADS          = 32;
export const NUM_KV_HEADS       = 4;
export const HEAD_DIM           = 64;   // HIDDEN_SIZE / NUM_HEADS
export const INTERMEDIATE_SIZE  = 5632;
export const RMS_NORM_EPS       = 1e-5;
export const ROPE_THETA         = 10000.0;
export const GQA_GROUP_SIZE     = NUM_HEADS / NUM_KV_HEADS; // 8
export const KV_DIM             = NUM_KV_HEADS * HEAD_DIM;  // 256

// ════════════════════════════════════════════════════════════════════════════
// 2. WGSL shader sources
// ════════════════════════════════════════════════════════════════════════════

/* ── 2a. Int8 → f32 dequantization ─────────────────────────────────────── */

const dequantShader = /* wgsl */ `
struct Params {
  total : u32,
  in_features : u32,
  _p0 : u32,
  _p1 : u32,
}

@group(0) @binding(0) var<storage, read>       quant  : array<i32>;
@group(0) @binding(1) var<storage, read>       scales : array<f32>;
@group(0) @binding(2) var<storage, read_write> out    : array<f32>;
@group(0) @binding(3) var<uniform>             params : Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.total) { return; }
  let ch = idx / params.in_features;
  out[idx] = f32(quant[idx]) * scales[ch];
}
`;

/* ── 2b. RMSNorm ───────────────────────────────────────────────────────── */

const rmsNormShader = /* wgsl */ `
struct Params {
  hidden : u32,
  seq    : u32,
  eps    : f32,
  _p     : u32,
}

@group(0) @binding(0) var<storage, read>       inp    : array<f32>;
@group(0) @binding(1) var<storage, read>       weight : array<f32>;
@group(0) @binding(2) var<storage, read_write> out    : array<f32>;
@group(0) @binding(3) var<uniform>             params : Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let t = gid.x;
  if (t >= params.seq) { return; }
  let off = t * params.hidden;

  var ss : f32 = 0.0;
  for (var i = 0u; i < params.hidden; i++) {
    let v = inp[off + i];
    ss += v * v;
  }
  let inv = inverseSqrt(ss / f32(params.hidden) + params.eps);

  for (var i = 0u; i < params.hidden; i++) {
    out[off + i] = inp[off + i] * inv * weight[i];
  }
}
`;

/* ── 2c. Matmul:  C[M,N] = A[M,K] × Bᵀ  (B stored row-major [N,K]) ── */

const matmulShader = /* wgsl */ `
struct Params {
  M : u32,
  N : u32,
  K : u32,
  _p : u32,
}

@group(0) @binding(0) var<storage, read>       a      : array<f32>;
@group(0) @binding(1) var<storage, read>       b      : array<f32>;
@group(0) @binding(2) var<storage, read_write> c      : array<f32>;
@group(0) @binding(3) var<uniform>             params : Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let row = gid.x;          // M
  let col = gid.y;          // N
  if (row >= params.M || col >= params.N) { return; }

  var acc : f32 = 0.0;
  for (var k = 0u; k < params.K; k++) {
    acc += a[row * params.K + k] * b[col * params.K + k];
  }
  c[row * params.N + col] = acc;
}
`;

/* ── 2d. RoPE — operates on one buffer (dispatch once for Q, once for K) */

const ropeShader = /* wgsl */ `
struct Params {
  seq       : u32,
  num_heads : u32,
  head_dim  : u32,
  pos_off   : u32,
  theta     : f32,
  _p0       : u32,
  _p1       : u32,
  _p2       : u32,
}

@group(0) @binding(0) var<storage, read_write> data   : array<f32>;
@group(0) @binding(1) var<uniform>             params : Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let idx      = gid.x;
  let half_dim = params.head_dim / 2u;
  let total    = params.seq * params.num_heads * half_dim;
  if (idx >= total) { return; }

  let d = idx % half_dim;
  let r = idx / half_dim;
  let h = r % params.num_heads;
  let s = r / params.num_heads;

  let pos   = f32(params.pos_off + s);
  let freq  = 1.0 / pow(params.theta, 2.0 * f32(d) / f32(params.head_dim));
  let angle = pos * freq;
  let cs    = cos(angle);
  let sn    = sin(angle);

  let base = s * params.num_heads * params.head_dim + h * params.head_dim;
  let i0   = base + d;
  let i1   = base + d + half_dim;

  let x0 = data[i0];
  let x1 = data[i1];
  data[i0] = x0 * cs - x1 * sn;
  data[i1] = x0 * sn + x1 * cs;
}
`;

/* ── 2e. Attention scores  S[H, Sq, Skv] = Q·Kᵀ / √d  + causal mask ── */

const attnScoresShader = /* wgsl */ `
struct Params {
  seq_q     : u32,
  seq_kv    : u32,
  num_heads : u32,
  num_kv_h  : u32,
  head_dim  : u32,
  gqa_group : u32,
  pos_off   : u32,
  _p        : u32,
}

@group(0) @binding(0) var<storage, read>       q      : array<f32>;
@group(0) @binding(1) var<storage, read>       k      : array<f32>;
@group(0) @binding(2) var<storage, read_write> scores : array<f32>;
@group(0) @binding(3) var<uniform>             params : Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let qi = gid.x;
  let ki = gid.y;
  let h  = gid.z;
  if (qi >= params.seq_q || ki >= params.seq_kv || h >= params.num_heads) { return; }

  let out_idx = h * params.seq_q * params.seq_kv + qi * params.seq_kv + ki;

  // Causal mask: absolute position of query must be >= key position
  if (ki > params.pos_off + qi) {
    scores[out_idx] = -1e9;
    return;
  }

  let kv_h   = h / params.gqa_group;
  let q_base = qi * params.num_heads  * params.head_dim + h    * params.head_dim;
  let k_base = ki * params.num_kv_h   * params.head_dim + kv_h * params.head_dim;

  var dot : f32 = 0.0;
  for (var d = 0u; d < params.head_dim; d++) {
    dot += q[q_base + d] * k[k_base + d];
  }

  scores[out_idx] = dot * inverseSqrt(f32(params.head_dim));
}
`;

/* ── 2f. Softmax (in-place, one thread per row [h, qi]) ────────────── */

const softmaxShader = /* wgsl */ `
struct Params {
  num_heads : u32,
  seq_q     : u32,
  seq_kv    : u32,
  _p        : u32,
}

@group(0) @binding(0) var<storage, read_write> s      : array<f32>;
@group(0) @binding(1) var<uniform>             params : Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let row = gid.x;
  if (row >= params.num_heads * params.seq_q) { return; }

  let h    = row / params.seq_q;
  let qi   = row % params.seq_q;
  let base = h * params.seq_q * params.seq_kv + qi * params.seq_kv;

  // --- max ---
  var mx : f32 = -1e30;
  for (var ki = 0u; ki < params.seq_kv; ki++) {
    mx = max(mx, s[base + ki]);
  }

  // --- exp + sum ---
  var sm : f32 = 0.0;
  for (var ki = 0u; ki < params.seq_kv; ki++) {
    let e = exp(s[base + ki] - mx);
    s[base + ki] = e;
    sm += e;
  }

  // --- normalise ---
  let inv = select(0.0, 1.0 / sm, sm > 0.0);
  for (var ki = 0u; ki < params.seq_kv; ki++) {
    s[base + ki] *= inv;
  }
}
`;

/* ── 2g. Attention output  O[Sq, H, d] = Σ_k probs·V  (GQA) ────────── */

const attnOutShader = /* wgsl */ `
struct Params {
  seq_q     : u32,
  seq_kv    : u32,
  num_heads : u32,
  num_kv_h  : u32,
  head_dim  : u32,
  gqa_group : u32,
  _p0       : u32,
  _p1       : u32,
}

@group(0) @binding(0) var<storage, read>       probs  : array<f32>;
@group(0) @binding(1) var<storage, read>       v      : array<f32>;
@group(0) @binding(2) var<storage, read_write> out    : array<f32>;
@group(0) @binding(3) var<uniform>             params : Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let qi = gid.x;
  let d  = gid.y;
  let h  = gid.z;
  if (qi >= params.seq_q || d >= params.head_dim || h >= params.num_heads) { return; }

  let kv_h     = h / params.gqa_group;
  let prob_off = h * params.seq_q * params.seq_kv + qi * params.seq_kv;

  var acc : f32 = 0.0;
  for (var ki = 0u; ki < params.seq_kv; ki++) {
    acc += probs[prob_off + ki]
         * v[ki * params.num_kv_h * params.head_dim + kv_h * params.head_dim + d];
  }

  out[qi * params.num_heads * params.head_dim + h * params.head_dim + d] = acc;
}
`;

/* ── 2h. SwiGLU:  gate[i] = SiLU(gate[i]) · up[i]  (in-place on gate) */

const siluMulShader = /* wgsl */ `
struct Params {
  total : u32,
  _p0   : u32,
  _p1   : u32,
  _p2   : u32,
}

@group(0) @binding(0) var<storage, read_write> gate   : array<f32>;
@group(0) @binding(1) var<storage, read>       up     : array<f32>;
@group(0) @binding(2) var<uniform>             params : Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= params.total) { return; }
  let g = gate[i];
  gate[i] = (g / (1.0 + exp(-g))) * up[i];
}
`;

/* ── 2i. Element-wise add:  out = a + b ────────────────────────────────── */

const addShader = /* wgsl */ `
struct Params {
  total : u32,
  _p0   : u32,
  _p1   : u32,
  _p2   : u32,
}

@group(0) @binding(0) var<storage, read>       a      : array<f32>;
@group(0) @binding(1) var<storage, read>       b      : array<f32>;
@group(0) @binding(2) var<storage, read_write> out    : array<f32>;
@group(0) @binding(3) var<uniform>             params : Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= params.total) { return; }
  out[i] = a[i] + b[i];
}
`;

// ════════════════════════════════════════════════════════════════════════════
// 3. Pipeline cache & helpers
// ════════════════════════════════════════════════════════════════════════════

const _pCache = new WeakMap();

function ensurePipelines(device) {
  if (_pCache.has(device)) return _pCache.get(device);

  const mk = (code) =>
    device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code }),
        entryPoint: 'main',
      },
    });

  const p = {
    dequant   : mk(dequantShader),
    rmsNorm   : mk(rmsNormShader),
    matmul    : mk(matmulShader),
    rope      : mk(ropeShader),
    attnScore : mk(attnScoresShader),
    softmax   : mk(softmaxShader),
    attnOut   : mk(attnOutShader),
    siluMul   : mk(siluMulShader),
    add       : mk(addShader),
  };
  _pCache.set(device, p);
  return p;
}

/** Create a storage buffer (optionally with COPY_SRC/DST). */
function mkBuf(device, bytes) {
  return device.createBuffer({
    size: bytes,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_SRC |
      GPUBufferUsage.COPY_DST,
  });
}

/** Upload typed-array to a storage buffer. */
function uploadBuf(device, data) {
  const buf = device.createBuffer({
    size: data.byteLength,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_SRC |
      GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  const dst =
    data instanceof Float32Array
      ? new Float32Array(buf.getMappedRange())
      : new Int32Array(buf.getMappedRange());
  dst.set(data);
  buf.unmap();
  return buf;
}

/**
 * Pack a sequence of [value, 'u32'|'f32'] pairs into a 16-byte-aligned
 * uniform buffer.
 */
function mkUniform(device, fields) {
  const count = Math.ceil(fields.length / 4) * 4;      // pad to 16 B
  const ab = new ArrayBuffer(count * 4);
  const dv = new DataView(ab);
  for (let i = 0; i < fields.length; i++) {
    const [v, t] = fields[i];
    if (t === 'u32') dv.setUint32(i * 4, v, true);
    else             dv.setFloat32(i * 4, v, true);
  }
  const buf = device.createBuffer({
    size: ab.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, ab);
  return buf;
}

/** Encode one compute pass inside an existing command encoder. */
function doPass(device, encoder, pipeline, buffers, wgX, wgY = 1, wgZ = 1) {
  const bg = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: buffers.map((buf, i) => ({
      binding: i,
      resource: { buffer: buf },
    })),
  });
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(wgX, wgY, wgZ);
  pass.end();
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Public helpers — upload, readback, dequantise
// ════════════════════════════════════════════════════════════════════════════

/** Upload a Float32Array to a GPU storage buffer. */
export function uploadFloat32(device, f32) {
  return uploadBuf(device, f32);
}

/** Read *floatCount* f32 values from a GPU buffer back to the CPU. */
export async function readBuffer(device, srcBuf, floatCount) {
  const bytes   = floatCount * 4;
  const staging = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(srcBuf, 0, staging, 0, bytes);
  device.queue.submit([enc.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const copy = new Float32Array(staging.getMappedRange()).slice();
  staging.unmap();
  staging.destroy();
  return copy;
}

/**
 * Dequantize a weight tensor on the GPU.
 *
 * @param {GPUDevice}     device
 * @param {Int8Array}     int8Data     — quantised weight, row-major [outF, inF]
 * @param {Float32Array}  scalesData   — per-output-channel scale [outF]
 * @param {number}        outFeatures
 * @param {number}        inFeatures
 * @returns {GPUBuffer}   — f32 storage buffer [outF × inF]
 */
export function dequantizeWeights(device, int8Data, scalesData, outFeatures, inFeatures) {
  const P     = ensurePipelines(device);
  const total = outFeatures * inFeatures;

  // sign-extend int8 → i32
  const i32 = new Int32Array(total);
  for (let i = 0; i < total; i++) i32[i] = int8Data[i];

  const qBuf  = uploadBuf(device, i32);
  const sBuf  = uploadBuf(device, scalesData);
  const oBuf  = mkBuf(device, total * 4);
  const uBuf  = mkUniform(device, [
    [total, 'u32'], [inFeatures, 'u32'], [0, 'u32'], [0, 'u32'],
  ]);

  const enc = device.createCommandEncoder();
  doPass(device, enc, P.dequant, [qBuf, sBuf, oBuf, uBuf], Math.ceil(total / 256));
  device.queue.submit([enc.finish()]);

  qBuf.destroy();
  sBuf.destroy();
  uBuf.destroy();
  return oBuf;
}

// ════════════════════════════════════════════════════════════════════════════
// 5. runDecoderLayer — the full forward pass
// ════════════════════════════════════════════════════════════════════════════

/**
 * Execute one TinyLlama decoder layer entirely on the GPU.
 *
 * @param {GPUDevice} device
 * @param {Object}    w          Pre-dequantised f32 GPU buffers:
 *   input_layernorm            [HIDDEN_SIZE]                     f32
 *   post_attention_layernorm   [HIDDEN_SIZE]                     f32
 *   q_proj                     [NUM_HEADS*HEAD_DIM, HIDDEN_SIZE] f32
 *   k_proj                     [KV_DIM, HIDDEN_SIZE]             f32
 *   v_proj                     [KV_DIM, HIDDEN_SIZE]             f32
 *   o_proj                     [HIDDEN_SIZE, HIDDEN_SIZE]        f32
 *   gate_proj                  [INTERMEDIATE_SIZE, HIDDEN_SIZE]  f32
 *   up_proj                    [INTERMEDIATE_SIZE, HIDDEN_SIZE]  f32
 *   down_proj                  [HIDDEN_SIZE, INTERMEDIATE_SIZE]  f32
 * @param {GPUBuffer} hBuf      Hidden-state buffer [seqLen, HIDDEN_SIZE]
 * @param {number}    seqLen    Number of tokens in hBuf
 * @param {Object|null} kvCache { k: GPUBuffer, v: GPUBuffer, length: number }
 * @param {number}    posOff    Position offset for RoPE (= kvCache.length or 0)
 * @returns {{ hiddenStates: GPUBuffer, kvCache: Object }}
 */
export function runDecoderLayer(device, w, hBuf, seqLen, kvCache, posOff) {
  const P   = ensurePipelines(device);
  const enc = device.createCommandEncoder();

  const S   = seqLen;
  const HS  = HIDDEN_SIZE;
  const HD  = HEAD_DIM;
  const NH  = NUM_HEADS;
  const NKV = NUM_KV_HEADS;
  const IS  = INTERMEDIATE_SIZE;
  const kvD = KV_DIM;

  const cacheLen = kvCache ? kvCache.length : 0;
  const totalKV  = cacheLen + S;

  // ── helper to ceil-divide ──
  const cd = (a, b) => Math.ceil(a / b);

  // ─── 1. Save residual ────────────────────────────────────────────────
  const residual = mkBuf(device, S * HS * 4);
  enc.copyBufferToBuffer(hBuf, 0, residual, 0, S * HS * 4);

  // ─── 2. Input RMSNorm ────────────────────────────────────────────────
  const normed = mkBuf(device, S * HS * 4);
  const normU  = mkUniform(device, [
    [HS, 'u32'], [S, 'u32'], [RMS_NORM_EPS, 'f32'], [0, 'u32'],
  ]);
  doPass(device, enc, P.rmsNorm,
    [hBuf, w.input_layernorm, normed, normU], cd(S, 64));

  // ─── 3. Q / K / V projections ────────────────────────────────────────
  const qBuf = mkBuf(device, S * NH * HD * 4);
  const kBuf = mkBuf(device, S * kvD * 4);
  const vBuf = mkBuf(device, S * kvD * 4);

  const qU = mkUniform(device, [
    [S, 'u32'], [NH * HD, 'u32'], [HS, 'u32'], [0, 'u32'],
  ]);
  doPass(device, enc, P.matmul,
    [normed, w.q_proj, qBuf, qU], cd(S, 16), cd(NH * HD, 16));

  const kU = mkUniform(device, [
    [S, 'u32'], [kvD, 'u32'], [HS, 'u32'], [0, 'u32'],
  ]);
  doPass(device, enc, P.matmul,
    [normed, w.k_proj, kBuf, kU], cd(S, 16), cd(kvD, 16));

  const vU = mkUniform(device, [
    [S, 'u32'], [kvD, 'u32'], [HS, 'u32'], [0, 'u32'],
  ]);
  doPass(device, enc, P.matmul,
    [normed, w.v_proj, vBuf, vU], cd(S, 16), cd(kvD, 16));

  // ─── 4. RoPE on Q and K ──────────────────────────────────────────────
  const ropeQU = mkUniform(device, [
    [S, 'u32'], [NH, 'u32'], [HD, 'u32'], [posOff, 'u32'],
    [ROPE_THETA, 'f32'], [0, 'u32'], [0, 'u32'], [0, 'u32'],
  ]);
  doPass(device, enc, P.rope,
    [qBuf, ropeQU], cd(S * NH * (HD / 2), 256));

  const ropeKU = mkUniform(device, [
    [S, 'u32'], [NKV, 'u32'], [HD, 'u32'], [posOff, 'u32'],
    [ROPE_THETA, 'f32'], [0, 'u32'], [0, 'u32'], [0, 'u32'],
  ]);
  doPass(device, enc, P.rope,
    [kBuf, ropeKU], cd(S * NKV * (HD / 2), 256));

  // ─── 5. KV-cache concatenation ───────────────────────────────────────
  let kFull, vFull;
  if (cacheLen > 0) {
    const oldB = cacheLen * kvD * 4;
    const newB = S * kvD * 4;
    kFull = mkBuf(device, totalKV * kvD * 4);
    vFull = mkBuf(device, totalKV * kvD * 4);
    enc.copyBufferToBuffer(kvCache.k, 0, kFull, 0, oldB);
    enc.copyBufferToBuffer(kBuf,      0, kFull, oldB, newB);
    enc.copyBufferToBuffer(kvCache.v, 0, vFull, 0, oldB);
    enc.copyBufferToBuffer(vBuf,      0, vFull, oldB, newB);
  } else {
    kFull = kBuf;
    vFull = vBuf;
  }

  // ─── 6. Attention scores  [NH, S, totalKV] ───────────────────────────
  const scoresBuf = mkBuf(device, NH * S * totalKV * 4);
  const scoreU    = mkUniform(device, [
    [S, 'u32'], [totalKV, 'u32'], [NH, 'u32'], [NKV, 'u32'],
    [HD, 'u32'], [GQA_GROUP_SIZE, 'u32'], [posOff, 'u32'], [0, 'u32'],
  ]);
  doPass(device, enc, P.attnScore,
    [qBuf, kFull, scoresBuf, scoreU], cd(S, 8), cd(totalKV, 8), NH);

  // ─── 7. Softmax (in-place) ───────────────────────────────────────────
  const softU = mkUniform(device, [
    [NH, 'u32'], [S, 'u32'], [totalKV, 'u32'], [0, 'u32'],
  ]);
  doPass(device, enc, P.softmax,
    [scoresBuf, softU], cd(NH * S, 256));

  // ─── 8. Attention output  [S, NH, HD] ────────────────────────────────
  const attnBuf = mkBuf(device, S * NH * HD * 4);
  const attnU   = mkUniform(device, [
    [S, 'u32'], [totalKV, 'u32'], [NH, 'u32'], [NKV, 'u32'],
    [HD, 'u32'], [GQA_GROUP_SIZE, 'u32'], [0, 'u32'], [0, 'u32'],
  ]);
  doPass(device, enc, P.attnOut,
    [scoresBuf, vFull, attnBuf, attnU], cd(S, 8), cd(HD, 8), NH);

  // ─── 9. O projection  [S, HS] ────────────────────────────────────────
  const oBuf = mkBuf(device, S * HS * 4);
  const oU   = mkUniform(device, [
    [S, 'u32'], [HS, 'u32'], [HS, 'u32'], [0, 'u32'],
  ]);
  doPass(device, enc, P.matmul,
    [attnBuf, w.o_proj, oBuf, oU], cd(S, 16), cd(HS, 16));

  // ─── 10. Residual add → mid ──────────────────────────────────────────
  const mid  = mkBuf(device, S * HS * 4);
  const addU = mkUniform(device, [
    [S * HS, 'u32'], [0, 'u32'], [0, 'u32'], [0, 'u32'],
  ]);
  doPass(device, enc, P.add,
    [residual, oBuf, mid, addU], cd(S * HS, 256));

  // ─── 11. Save second residual ─────────────────────────────────────────
  const residual2 = mkBuf(device, S * HS * 4);
  enc.copyBufferToBuffer(mid, 0, residual2, 0, S * HS * 4);

  // ─── 12. Post-attention RMSNorm ───────────────────────────────────────
  const normed2 = mkBuf(device, S * HS * 4);
  const norm2U  = mkUniform(device, [
    [HS, 'u32'], [S, 'u32'], [RMS_NORM_EPS, 'f32'], [0, 'u32'],
  ]);
  doPass(device, enc, P.rmsNorm,
    [mid, w.post_attention_layernorm, normed2, norm2U], cd(S, 64));

  // ─── 13. Gate & Up projections  [S, IS] ──────────────────────────────
  const gateBuf = mkBuf(device, S * IS * 4);
  const upBuf   = mkBuf(device, S * IS * 4);
  const mlpU    = mkUniform(device, [
    [S, 'u32'], [IS, 'u32'], [HS, 'u32'], [0, 'u32'],
  ]);
  doPass(device, enc, P.matmul,
    [normed2, w.gate_proj, gateBuf, mlpU], cd(S, 16), cd(IS, 16));
  doPass(device, enc, P.matmul,
    [normed2, w.up_proj,   upBuf,   mlpU], cd(S, 16), cd(IS, 16));

  // ─── 14. SwiGLU (in-place on gateBuf) ────────────────────────────────
  const siluU = mkUniform(device, [
    [S * IS, 'u32'], [0, 'u32'], [0, 'u32'], [0, 'u32'],
  ]);
  doPass(device, enc, P.siluMul,
    [gateBuf, upBuf, siluU], cd(S * IS, 256));

  // ─── 15. Down projection  [S, HS] ────────────────────────────────────
  const downBuf = mkBuf(device, S * HS * 4);
  const downU   = mkUniform(device, [
    [S, 'u32'], [HS, 'u32'], [IS, 'u32'], [0, 'u32'],
  ]);
  doPass(device, enc, P.matmul,
    [gateBuf, w.down_proj, downBuf, downU], cd(S, 16), cd(HS, 16));

  // ─── 16. Final residual add ──────────────────────────────────────────
  const finalBuf = mkBuf(device, S * HS * 4);
  doPass(device, enc, P.add,
    [residual2, downBuf, finalBuf, addU], cd(S * HS, 256));

  // ─── submit ──────────────────────────────────────────────────────────
  device.queue.submit([enc.finish()]);

  return {
    hiddenStates: finalBuf,
    kvCache: { k: kFull, v: vFull, length: totalKV },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Multi-layer helper
// ════════════════════════════════════════════════════════════════════════════

/**
 * Run a contiguous range of decoder layers (for pipeline-parallel inference).
 *
 * @param {GPUDevice}   device
 * @param {Object[]}    layerWeightsArray  Array of per-layer weight objects
 * @param {GPUBuffer}   hBuf               Input hidden states [seqLen, HS]
 * @param {number}      seqLen
 * @param {Object[]|null} kvCaches         Array of KV caches (or null)
 * @param {number}      posOff
 * @returns {{ hiddenStates: GPUBuffer, kvCaches: Object[] }}
 */
export function runLayerRange(device, layerWeightsArray, hBuf, seqLen, kvCaches, posOff) {
  const newCaches = [];
  let current = hBuf;

  for (let i = 0; i < layerWeightsArray.length; i++) {
    const cache  = kvCaches ? kvCaches[i] : null;
    const result = runDecoderLayer(device, layerWeightsArray[i], current, seqLen, cache, posOff);
    current = result.hiddenStates;
    newCaches.push(result.kvCache);
  }

  return { hiddenStates: current, kvCaches: newCaches };
}

// ════════════════════════════════════════════════════════════════════════════
// 7. Weight-loading utility (reads the prepare_model.py binary format)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Load and dequantise one decoder layer's weights from a binary blob + its
 * manifest tensor entries.
 *
 * @param {GPUDevice}    device
 * @param {ArrayBuffer}  binBuffer   Raw bytes of layer_XX.bin
 * @param {Object[]}     tensorEntries  entries from manifest.json for this layer
 * @returns {Object}     layerWeights suitable for runDecoderLayer()
 */
export function loadLayerWeights(device, binBuffer, tensorEntries) {
  // Build lookup:  tensor name → { byte_offset, byte_length, shape, dtype }
  const lookup = {};
  for (const e of tensorEntries) lookup[e.name] = e;

  // Helper: find entry by suffix (e.g. "self_attn.q_proj.quantized")
  const get = (suffix) => {
    const key = Object.keys(lookup).find((k) => k.endsWith(suffix));
    if (!key) throw new Error(`Tensor not found: *${suffix}`);
    return lookup[key];
  };

  // Read raw bytes as typed array
  const readI8  = (e) => new Int8Array(binBuffer, e.byte_offset, e.byte_length);
  const readF32 = (e) =>
    new Float32Array(binBuffer, e.byte_offset, e.byte_length / 4);

  // Dequantise a quantised weight pair (name.quantized + name.scale)
  const dq = (prefix) => {
    const qe = get(`${prefix}.quantized`);
    const se = get(`${prefix}.scale`);
    const shape = qe.shape;                    // [out, in]
    return dequantizeWeights(device, readI8(qe), readF32(se), shape[0], shape[1]);
  };

  return {
    input_layernorm:          uploadFloat32(device, readF32(get('input_layernorm.weight'))),
    post_attention_layernorm: uploadFloat32(device, readF32(get('post_attention_layernorm.weight'))),
    q_proj:    dq('self_attn.q_proj.weight'),
    k_proj:    dq('self_attn.k_proj.weight'),
    v_proj:    dq('self_attn.v_proj.weight'),
    o_proj:    dq('self_attn.o_proj.weight'),
    gate_proj: dq('mlp.gate_proj.weight'),
    up_proj:   dq('mlp.up_proj.weight'),
    down_proj: dq('mlp.down_proj.weight'),
  };
}
