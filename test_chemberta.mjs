import { pipeline, env } from '@huggingface/transformers';

async function testModel() {
  const modelId = 'iamekansh/chemberta-77m-mtr-onnx';
  console.log(`Testing model: ${modelId}`);

  // 1. Check merges.txt
  console.log('\\n--- Checking merges.txt ---');
  try {
    const res = await fetch(`https://huggingface.co/${modelId}/raw/main/merges.txt`);
    if (!res.ok) {
      console.error(`merges.txt fetch failed: ${res.status} ${res.statusText}`);
    } else {
      const text = await res.text();
      console.log(`merges.txt size: ${text.length} bytes`);
      if (text.length < 50) {
        console.error('ERROR: merges.txt is too small, likely missing BPE rules.');
        console.log('Content:', text);
      } else {
        console.log('✓ merges.txt looks OK.');
      }
    }
  } catch (err) {
    console.error('Failed to fetch merges.txt:', err);
  }

  // 2. Test feature extraction
  console.log('\\n--- Testing Feature Extraction ---');
  try {
    const pipe = await pipeline('feature-extraction', modelId);
    console.log('Pipeline loaded successfully.');
    
    const smiles = 'CCO'; // Ethanol
    console.log(`Input SMILES: ${smiles}`);
    
    const output = await pipe(smiles);
    
    console.log('Output tensor dims:', output.dims); // Should be [1, N, 384]
    if (output.dims.length === 3 && output.dims[2] === 384) {
       console.log('✓ Tensor dimensions look correct.');
    } else {
       console.error('ERROR: Unexpected tensor dimensions.');
    }
    
    const data = output.data;
    let hasNaN = false;
    for(let i=0; i<Math.min(data.length, 10); i++) {
       if (Number.isNaN(data[i])) hasNaN = true;
    }
    console.log(`First 5 values: ${Array.from(data.slice(0, 5)).join(', ')}`);
    
    if (hasNaN) {
      console.error('ERROR: Output contains NaN values.');
    } else {
      console.log('✓ Tensor values are valid floats.');
    }
    
  } catch (err) {
    console.error('Feature extraction failed:', err);
  }
}

testModel();
