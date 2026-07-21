// dockingWorker.js
// Runs Webina (AutoDock Vina WebAssembly) for real molecular docking

let receptorPdbqt = null;
let webinaModule = null;
let webinaInitFailed = false;
let boxConfig = null;
let webinaCallCount = 0;
const MAX_CALLS_BEFORE_RECYCLE = 1; // highly aggressive recycle to prevent static state corruption

// Initialize Webina Module
async function initWebina(forceFresh = false) {
  if (webinaModule && !forceFresh) return webinaModule;
  if (webinaInitFailed) return null; // already tried and failed, don't retry every chunk

  console.log('[DockingWorker] Initializing Webina WASM' + (forceFresh ? ' (recycled)...' : '...'));
  
  try {
    // Dynamically fetch and evaluate to bypass Vercel/Vite strict-mode or dynamic import bugs
    const jsText = await fetch('/webina.js').then(res => res.text());
    const cleanedText = jsText
      .replace('export default WEBINA_MODULE;', 'return WEBINA_MODULE;')
      .replace(/import\.meta\.url/g, `"${self.location.origin}/webina.js"`);
      
    const getModule = new Function(cleanedText);
    const WebinaFactory = getModule();
    
    let printHistory = [];
    webinaModule = await WebinaFactory({
      locateFile: (path) => {
        if (path.endsWith('.wasm')) return '/webina.wasm';
        if (path.endsWith('.worker.js')) return '/webina.worker.js';
        return '/' + path;
      },
      print: (text) => {
        printHistory.push(text);
        if (printHistory.length > 10) printHistory.shift();
        console.log('[Webina] ' + text);
      },
      printErr: (text) => {
        console.error(`[Webina Error | callCount: ${webinaCallCount}] ` + text);
        if (text.includes('worker sent an error') || text.toLowerCase().includes('crash')) {
          console.error('[Webina Diagnostics] Last 10 print lines before crash:\n' + printHistory.join('\n'));
        }
      }
    });
    webinaCallCount = 0;
    console.log('[DockingWorker] Webina initialized successfully.');
  } catch (err) {
    webinaModule = null;
    webinaInitFailed = true;
    console.error('[DockingWorker] Failed to load Webina module (will use fallback scoring for this session):', err);
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

function getLigandSpan(pdbqt) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const line of pdbqt.split('\n')) {
    if (line.startsWith('ATOM') || line.startsWith('HETATM')) {
      const x = parseFloat(line.substring(30, 38));
      const y = parseFloat(line.substring(38, 46));
      const z = parseFloat(line.substring(46, 54));
      if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
  }
  if (minX === Infinity) return null;
  return { spanX: maxX - minX, spanY: maxY - minY, spanZ: maxZ - minZ };
}

// Vina needs headroom beyond the ligand's raw extent to search rotations/translations.
// A ~6 Å margin per axis is a conservative, commonly-cited rule of thumb.
function fitsInBox(span, box, marginAngstrom = 6) {
  return (
    span.spanX <= box.size_x - marginAngstrom &&
    span.spanY <= box.size_y - marginAngstrom &&
    span.spanZ <= box.size_z - marginAngstrom
  );
}

export async function scoreMoleculeBatch(molecules, exhaustiveness = 1) {
  let mod = await initWebina();
  const rec = await getReceptor();
  const box = await getBoxConfig();
  
  const results = [];
  
  for (const mol of molecules) {
    if (!mol || !mol.smiles) {
      results.push(null);
      continue;
    }

    if (webinaCallCount >= MAX_CALLS_BEFORE_RECYCLE) {
      mod = await initWebina(true); // force fresh instance before state corrupts further
    }
    
    try {
      const span = mol.pdbqt ? getLigandSpan(mol.pdbqt) : null;
      const canDock = span && fitsInBox(span, box);

      if (mod && rec && mol.pdbqt && canDock) {
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
        
        webinaCallCount++;
        
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
        if (mol.pdbqt && canDock === false) {
          console.warn(`[DockingWorker] Skipping ${mol.smiles} — ligand too large for ${box.size_x}Å box`, span);
        }
        results.push({
          smiles: mol.smiles,
          affinity: -5.0 - (mol.smiles.length % 5),
          source: canDock === false ? 'fallback_too_large' : 'fallback_missing'
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
