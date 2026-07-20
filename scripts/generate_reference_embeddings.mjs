import { pipeline, env } from '@huggingface/transformers';
import fs from 'fs';
import path from 'path';

// Run in Node
env.allowLocalModels = false;

const MODEL_ID = 'iamekansh/chemberta-77m-mtr-onnx';

async function generateReferenceEmbeddings() {
  console.log(`Loading model ${MODEL_ID}...`);
  const pipe = await pipeline('feature-extraction', MODEL_ID);

  const refPath = path.join(process.cwd(), 'server', 'data', 'reference_antibiotics.json');
  const refData = JSON.parse(fs.readFileSync(refPath, 'utf8'));

  console.log('Generating embeddings for reference antibiotics...');
  const embeddings = [];

  for (const antibiotic of refData.reference_antibiotics) {
    const smiles = antibiotic.smiles;
    // Mean pooling, normalize
    const output = await pipe(smiles, { pooling: 'mean', normalize: true });
    
    embeddings.push({
      name: antibiotic.name,
      smiles: smiles,
      class: antibiotic.class,
      embedding: Array.from(output.data) // Convert Float32Array to standard array for JSON
    });
    console.log(`  ✓ ${antibiotic.name} (${output.data.length}d)`);
  }

  const outPath = path.join(process.cwd(), 'server', 'data', 'reference_embeddings.json');
  fs.writeFileSync(outPath, JSON.stringify({
    model_id: MODEL_ID,
    model_version: 'v1',
    embedding_dim: embeddings[0].embedding.length,
    embeddings: embeddings
  }, null, 2));

  console.log(`\\n✓ Reference embeddings saved to ${outPath}`);
}

generateReferenceEmbeddings().catch(console.error);
