/**
 * single-node-generate.js
 * 
 * Drives the autoregressive generation loop.
 */
import { 
  loadLayerWeights, 
  loadEmbeddingWeights, 
  loadFinalHeadWeights,
  runEmbedding,
  runDecoderLayer,
  runFinalHead,
  readBuffer,
  HIDDEN_SIZE 
} from './webgpu-kernels.js';
import { Tokenizer } from './tokenizer.js';

export class Generator {
  constructor(device) {
    this.device = device;
    this.tokenizer = null;
    this.embedding = null;
    this.layers = [];
    this.finalHead = null;
    this.vocabSize = 32000;
  }

  async loadFromUrl(baseUrl, log) {
    log("Loading manifest...");
    const manifestRes = await fetch(`${baseUrl}/manifest.json`);
    const rawManifest = await manifestRes.json();
    const manifest = Array.isArray(rawManifest) ? rawManifest : Object.values(rawManifest);
    
    log("Loading tokenizer...");
    const tokRes = await fetch(`${baseUrl}/tokenizer/tokenizer_export.json`);
    const tokData = await tokRes.json();
    this.tokenizer = new Tokenizer(tokData);
    this.vocabSize = Object.keys(this.tokenizer.vocab).length;

    const readBin = async (filename) => {
      const res = await fetch(`${baseUrl}/${filename}`);
      if (!res.ok) throw new Error(`Failed to load ${filename}. Check server paths.`);
      return await res.arrayBuffer();
    };

    log("Loading embedding...");
    const embedEntries = manifest.filter(e => e.file === 'embedding.bin' || (e.name && e.name.includes('embed_tokens')));
    const embedBuf = await readBin('embedding.bin');
    this.embedding = loadEmbeddingWeights(this.device, embedBuf, embedEntries);

    this.layers = [];
    for (let i = 0; i < 22; i++) {
      log(`Loading layer ${i}...`);
      const layerFile = `layers/layer_${i.toString().padStart(2, '0')}.bin`;
      const lEntries = manifest.filter(e => e.file === layerFile || (e.name && e.name.includes(`layers.${i}.`)));
      const lBuf = await readBin(layerFile);
      this.layers.push(loadLayerWeights(this.device, lBuf, lEntries));
    }

    log("Loading final head...");
    const finalEntries = manifest.filter(e => e.file === 'final_head.bin' || (e.name && (e.name.includes('lm_head') || e.name === 'model.norm.weight')));
    const finalBuf = await readBin('final_head.bin');
    this.finalHead = loadFinalHeadWeights(this.device, finalBuf, finalEntries);
    
    log("✅ Model fully loaded into VRAM.");
  }

  async generate(prompt, maxTokens = 40, logStream) {
    const chatPrompt = this.tokenizer.applyChatTemplate(prompt);
    let tokenIds = this.tokenizer.encode(chatPrompt);
    
    logStream(`\nPrompt tokenized: ${tokenIds.length} tokens\n`);
    logStream(`[Start Generation]\n`);
    console.log("Initial tokens:", tokenIds);
    
    let kvCaches = new Array(22).fill(null);
    let posOff = 0;
    
    for (let step = 0; step < maxTokens; step++) {
      const seqLen = tokenIds.length;
      
      // 1. Embedding
      let hBuf = runEmbedding(this.device, this.embedding, tokenIds, this.vocabSize);
      
      // 2. Layers
      const newKvCaches = [];
      for (let i = 0; i < 22; i++) {
        const { hiddenStates: outBuf, kvCache } = runDecoderLayer(
          this.device, this.layers[i], hBuf, seqLen, kvCaches[i], posOff
        );
        hBuf.destroy(); // Free intermediate
        hBuf = outBuf;
        newKvCaches.push(kvCache);
      }
      
      // Free old caches
      for (let i = 0; i < 22; i++) {
        if (kvCaches[i]) {
          kvCaches[i].k.destroy();
          kvCaches[i].v.destroy();
        }
      }
      kvCaches = newKvCaches;
      
      // 3. Final Head
      const logitsBuf = runFinalHead(this.device, this.finalHead, hBuf, seqLen, this.vocabSize);
      
      // 4. Read back logits and argmax
      const logits = await readBuffer(this.device, logitsBuf, this.vocabSize);
      hBuf.destroy();
      logitsBuf.destroy();
      
      let maxVal = -Infinity;
      let maxIdx = -1;
      for (let i = 0; i < this.vocabSize; i++) {
        if (logits[i] > maxVal) {
          maxVal = logits[i];
          maxIdx = i;
        }
      }
      
      const nextToken = maxIdx;
      if (nextToken === this.tokenizer.eosId) {
        logStream("\n[EOS reached]");
        break;
      }
      
      // Decode and print just the new token
      const str = this.tokenizer.decode([nextToken]);
      logStream(str);
      console.log(`Step ${step}: token=${nextToken} str='${str}'`);
      
      // Prepare next step (feed only the generated token)
      posOff += seqLen;
      tokenIds = [nextToken]; 
    }
  }
}
