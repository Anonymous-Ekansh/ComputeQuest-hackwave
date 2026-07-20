// dockingWorker.js
// Runs Webina (AutoDock Vina WebAssembly) for real molecular docking

let receptorPdbqt = null;
let webinaModule = null;
let boxConfig = null;

// Initialize Webina Module
async function initWebina() {
  if (webinaModule) return webinaModule;
  console.log('[DockingWorker] Initializing Webina WASM...');
  
  try {
    // Dynamically import the ES module (bypassing Vite analysis)
    const module = await import(/* @vite-ignore */ '/webina.js');
    webinaModule = await module.default({
      locateFile: (path) => {
        if (path.endsWith('.wasm')) return '/webina.wasm';
        if (path.endsWith('.worker.js')) return '/webina.worker.js';
        return '/' + path;
      },
      print: (text) => console.log('[Webina] ' + text),
      printErr: (text) => console.error('[Webina] ' + text)
    });
    console.log('[DockingWorker] Webina initialized successfully.');
  } catch (err) {
    console.error('[DockingWorker] Failed to load Webina module:', err);
  }
  return webinaModule;
}

// Fetch the receptor if not cached
async function getReceptor() {
  if (receptorPdbqt) return receptorPdbqt;
  try {
    const res = await fetch('/receptor.pdbqt');
    if (res.ok) {
      receptorPdbqt = await res.text();
    }
  } catch (err) {
    console.error('[DockingWorker] Failed to fetch receptor.pdbqt', err);
  }
  return receptorPdbqt;
}

// Fetch bounding box config if not cached
async function getBoxConfig() {
  if (boxConfig) return boxConfig;
  try {
    const res = await fetch('/box_config.json');
    if (res.ok) {
      boxConfig = await res.json();
    }
  } catch (err) {
    console.error('[DockingWorker] Failed to fetch box_config.json', err);
  }
  // Fallback to origin with a large box if missing
  return boxConfig || {
    center_x: 0, center_y: 0, center_z: 0,
    size_x: 40, size_y: 40, size_z: 40
  };
}

// Extract the best binding affinity from the PDBQT output
function parseAffinity(outPdbqt) {
  if (!outPdbqt) return null;
  const lines = outPdbqt.split('\n');
  for (const line of lines) {
    if (line.startsWith('REMARK VINA RESULT:')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        return parseFloat(parts[3]);
      }
    }
  }
  return null;
}

export async function scoreMoleculeBatch(molecules, exhaustiveness = 1) {
  const mod = await initWebina();
  const rec = await getReceptor();
  const box = await getBoxConfig();
  
  const results = [];
  
  for (const mol of molecules) {
    if (!mol || !mol.smiles) {
      results.push(null);
      continue;
    }
    
    try {
      if (mod && rec && mol.pdbqt) {
        // Write files to virtual FS
        mod.FS.writeFile('receptor.pdbqt', rec);
        mod.FS.writeFile('ligand.pdbqt', mol.pdbqt);
        
        // Call Vina main using dynamic bounding box
        mod.callMain([
          '--receptor', 'receptor.pdbqt',
          '--ligand', 'ligand.pdbqt',
          '--center_x', String(box.center_x), '--center_y', String(box.center_y), '--center_z', String(box.center_z),
          '--size_x', String(box.size_x), '--size_y', String(box.size_y), '--size_z', String(box.size_z),
          '--cpu', '1',
          '--exhaustiveness', String(exhaustiveness),
          '--out', 'out.pdbqt'
        ]);
        
        let outData = null;
        try {
          outData = mod.FS.readFile('out.pdbqt', { encoding: 'utf8' });
        } catch (e) {
          // If Vina failed to write output (e.g. grid box too small), readFile throws
          console.error(`[DockingWorker] Webina output missing for ${mol.smiles}:`, e);
        }

        const affinity = parseAffinity(outData);
        
        results.push({
          smiles: mol.smiles,
          affinity: affinity !== null ? affinity : -2.0, 
          source: affinity !== null ? 'real' : 'fallback_error'
        });
        
        // Clean up FS
        try { mod.FS.unlink('receptor.pdbqt'); } catch(e){}
        try { mod.FS.unlink('ligand.pdbqt'); } catch(e){}
        try { mod.FS.unlink('out.pdbqt'); } catch(e){}
      } else {
        results.push({
          smiles: mol.smiles,
          affinity: -5.0 - (mol.smiles.length % 5),
          source: 'fallback_missing'
        });
      }
    } catch (err) {
      console.error(`[DockingWorker] Webina failed for ${mol.smiles}:`, err);
      results.push({
        smiles: mol.smiles,
        affinity: -2.0,
        source: 'fallback_error'
      });
    }
  }
  
  return results;
}
