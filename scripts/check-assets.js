const fs = require('fs');
const path = require('path');

const REQUIRED_FILES = [
  'client/public/webina.js',
  'client/public/webina.wasm',
  'client/public/webina.worker.js',
  'client/public/receptor.pdbqt'
];

let missing = false;

for (const file of REQUIRED_FILES) {
  const fullPath = path.join(__dirname, '..', file);
  if (!fs.existsSync(fullPath)) {
    console.error(`[check-assets] ERROR: Missing required asset ${file}`);
    missing = true;
  } else {
    console.log(`[check-assets] Found ${file}`);
  }
}

if (missing) {
  console.error('\n[check-assets] FAILED. Please ensure you have downloaded the Webina WASM assets and generated the receptor.pdbqt file before deploying.');
  process.exit(1);
} else {
  console.log('[check-assets] All required assets are present.');
  process.exit(0);
}
