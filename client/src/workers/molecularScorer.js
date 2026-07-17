// ─────────────────────────────────────────────────────────────────────────────
// molecularScorer.js — Molecular scoring worker for virtual drug screening
//
// Computes real molecular descriptors via RDKit.js (WASM) and scores molecules
// against a SARS-CoV-2 Mpro target pocket configuration.
//
// Singleton pattern mirrors computeWorker.js's ensureEngine() approach:
// the RDKit WASM module is loaded lazily on first use, then cached.
// ─────────────────────────────────────────────────────────────────────────────

import initRDKitModule from '@rdkit/rdkit';

// ── RDKit Module Singleton ──────────────────────────────────────────────────
let rdkit = null;
let rdkitPromise = null;

/**
 * Lazily initialize the RDKit WASM module (singleton).
 * Follows the same pattern as ensureEngine() in computeWorker.js:
 *   - If already loaded, return immediately
 *   - If currently loading, return the in-flight promise
 *   - Otherwise, kick off initialization and cache the promise
 *
 * @returns {Promise<RDKitModule>} The initialized RDKit module
 */
export async function ensureRDKit() {
  if (rdkit) return rdkit;
  if (rdkitPromise) return rdkitPromise;

  console.log('[MolecularScorer] Initializing RDKit WASM module...');
  rdkitPromise = (async () => {
    try {
      const mod = await initRDKitModule({
        // In a Vite web worker, the WASM file is served from /public.
        // In Node.js tests this option is ignored (Node resolves from the
        // package's dist/ directory automatically).
        locateFile: (path) => {
          if (path.endsWith('.wasm')) {
            // Try to detect if we're in a web worker context
            if (typeof self !== 'undefined' && typeof self.location !== 'undefined') {
              return '/RDKit_minimal.wasm';
            }
          }
          return path;
        },
      });
      rdkit = mod;
      rdkitPromise = null;
      console.log(`[MolecularScorer] RDKit ${mod.version()} ready.`);
      return mod;
    } catch (err) {
      rdkitPromise = null;
      throw err;
    }
  })();

  return rdkitPromise;
}


// ─────────────────────────────────────────────────────────────────────────────
// LogP Estimator — Simplified Wildman-Crippen Approach
//
// RDKit.js MinimalLib does NOT expose CrippenClogP. We implement a simplified
// atom-contribution LogP estimator based on the Wildman-Crippen method:
//
//   Wildman, S. A. & Crippen, G. M. (1999). J. Chem. Inf. Comput. Sci. 39, 868-873.
//
// This is a coarse approximation using heavy-atom counts by element and bond
// pattern analysis from the SMILES string. It is NOT equivalent to full
// Crippen fragment-based LogP but produces reasonable estimates for
// drug-like molecules (typically within ±1.0 of true ClogP).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimate LogP from molecular descriptors and SMILES structure.
 *
 * Uses a simplified atom-additive model:
 *   LogP ≈ Σ(atom contributions) + corrections
 *
 * Atom contributions (approximate Wildman-Crippen averages):
 *   C (non-aromatic):  +0.29    C (aromatic):  +0.13
 *   N:                 -0.72    O:             -0.46
 *   S:                 +0.60    F:             +0.37
 *   Cl:                +0.87    Br:            +1.09
 *   P:                 +0.49    Se:            +0.97
 *
 * Corrections:
 *   - Each H-bond donor:    -0.45 (polar, hydrophilic)
 *   - Each H-bond acceptor: -0.12 (mild polarity correction)
 *   - Each amide bond:      -0.65 (strong hydrophilic group)
 *
 * @param {string} smiles    - SMILES string
 * @param {number} hbd       - H-bond donor count (from RDKit descriptors)
 * @param {number} hba       - H-bond acceptor count (from RDKit descriptors)
 * @param {number} heavyAtoms - Number of heavy atoms
 * @returns {number} Estimated LogP
 */
function estimateLogP(smiles, hbd, hba, heavyAtoms) {
  // Count atoms by element from SMILES (strip brackets, charges, H-counts, etc.)
  // We work on the raw SMILES string for pattern matching.

  // Count aromatic vs aliphatic carbons
  const aromaticC = (smiles.match(/c/g) || []).length;
  const aliphaticC = (smiles.match(/C/g) || []).length;

  // Heteroatoms (both aromatic and aliphatic forms)
  const nCount = (smiles.match(/[nN]/g) || []).length;
  const oCount = (smiles.match(/[oO]/g) || []).length;
  const sCount = (smiles.match(/[sS](?!e|i)/g) || []).length; // exclude Se, Si
  const fCount = (smiles.match(/F/g) || []).length;
  const clCount = (smiles.match(/Cl/g) || []).length;
  const brCount = (smiles.match(/Br/g) || []).length;
  const pCount = (smiles.match(/P/g) || []).length;
  const seCount = (smiles.match(/Se/g) || []).length;

  // Amide bond count (rough estimate from SMILES pattern)
  const amideCount = (smiles.match(/C\(=O\)N|NC\(=O\)|c\(=O\)n|nc\(=O\)/g) || []).length;

  // Atom contributions
  let logP = 0;
  logP += aliphaticC * 0.29;
  logP += aromaticC * 0.13;
  logP += nCount * (-0.72);
  logP += oCount * (-0.46);
  logP += sCount * 0.60;
  logP += fCount * 0.37;
  logP += clCount * 0.87;
  logP += brCount * 1.09;
  logP += pCount * 0.49;
  logP += seCount * 0.97;

  // Corrections for polar groups
  logP += hbd * (-0.45);
  logP += hba * (-0.12);
  logP += amideCount * (-0.65);

  return Math.round(logP * 100) / 100;
}


// ─────────────────────────────────────────────────────────────────────────────
// Druglikeness Score — Lipinski Rule-of-Five (partial credit)
//
// Instead of a binary pass/fail, we award partial credit for each rule:
//   Rule 1: MW ≤ 500 Da         (full credit if ≤500, linear decay to 0 at 800)
//   Rule 2: LogP ≤ 5            (full credit if ≤5, linear decay to 0 at 10)
//   Rule 3: HBD ≤ 5             (full credit if ≤5, linear decay to 0 at 10)
//   Rule 4: HBA ≤ 10            (full credit if ≤10, linear decay to 0 at 20)
//
// Each rule contributes 0.25 to the total score (max = 1.0).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score druglikeness using Lipinski's Rule of Five with partial credit.
 *
 * @param {number} mw    - Molecular weight (Da)
 * @param {number} logP  - Estimated LogP
 * @param {number} hbd   - H-bond donor count
 * @param {number} hba   - H-bond acceptor count
 * @returns {number} Score in [0, 1]
 */
function computeDruglikenessScore(mw, logP, hbd, hba) {
  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  // Each rule: full credit within threshold, linear decay beyond
  const mwScore   = clamp01(mw   <= 500 ? 1.0 : 1.0 - (mw - 500) / 300);
  const logPScore = clamp01(logP <= 5   ? 1.0 : 1.0 - (logP - 5)  / 5);
  const hbdScore  = clamp01(hbd  <= 5   ? 1.0 : 1.0 - (hbd - 5)   / 5);
  const hbaScore  = clamp01(hba  <= 10  ? 1.0 : 1.0 - (hba - 10)  / 10);

  // Equal weighting: each rule is worth 0.25
  const score = (mwScore + logPScore + hbdScore + hbaScore) / 4;
  return Math.round(score * 10000) / 10000;
}


// ─────────────────────────────────────────────────────────────────────────────
// Pocket Complementarity Score
//
// Evaluates how well a molecule's physicochemical profile matches the
// target binding pocket from targetConfig. Three sub-scores:
//
// 1. HBD complementarity:  molecule's HBD count vs pocket's HBA count
//    (a good ligand donates H-bonds to pocket acceptors)
//    Optimal when mol_HBD ≈ pocket_hbond_acceptor_count (capped ratio).
//
// 2. HBA complementarity:  molecule's HBA count vs pocket's HBD count
//    (a good ligand accepts H-bonds from pocket donors)
//    Optimal when mol_HBA ≈ pocket_hbond_donor_count (capped ratio).
//
// 3. Volume fit:  molecule's estimated volume vs pocket volume
//    Estimated molecular volume ≈ heavyAtoms × 18 Å³ (rough mean VdW volume
//    per heavy atom for drug-like molecules). Optimal when mol fills
//    50–90% of the pocket.
//
// Each sub-score is in [0, 1]; final score is a weighted mean.
// ─────────────────────────────────────────────────────────────────────────────

/** Average van der Waals volume per heavy atom in drug-like molecules (Å³) */
const VDW_VOLUME_PER_HEAVY_ATOM = 18;

/**
 * Score pocket complementarity between a molecule and a target pocket.
 *
 * @param {number} hbd         - Molecule H-bond donor count
 * @param {number} hba         - Molecule H-bond acceptor count
 * @param {number} heavyAtoms  - Molecule heavy atom count
 * @param {object} targetConfig - Target pocket configuration
 * @returns {number} Score in [0, 1]
 */
function computePocketComplementarityScore(hbd, hba, heavyAtoms, targetConfig) {
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const {
    pocket_hbond_acceptor_count: pocketHBA,
    pocket_hbond_donor_count: pocketHBD,
    pocket_volume_estimate_A3: pocketVol,
  } = targetConfig;

  // ── HBD complementarity ──
  // Molecule donors should match pocket acceptors.
  // Perfect match = 1.0, score decays linearly for mismatch.
  // Use ratio approach: score = 1 - |mol_HBD - pocketHBA| / max(pocketHBA, 1)
  // Capped at [0, 1].
  const hbdDelta = Math.abs(hbd - pocketHBA);
  const hbdComplement = clamp01(1.0 - hbdDelta / Math.max(pocketHBA, 1));

  // ── HBA complementarity ──
  // Molecule acceptors should match pocket donors.
  const hbaDelta = Math.abs(hba - pocketHBD);
  const hbaComplement = clamp01(1.0 - hbaDelta / Math.max(pocketHBD, 1));

  // ── Volume fit ──
  // Estimate molecular volume from heavy atom count
  const molVol = heavyAtoms * VDW_VOLUME_PER_HEAVY_ATOM;
  // Optimal fill ratio: 50–90% of pocket volume
  const fillRatio = molVol / pocketVol;
  let volScore;
  if (fillRatio >= 0.5 && fillRatio <= 0.9) {
    // Sweet spot — full marks
    volScore = 1.0;
  } else if (fillRatio < 0.5) {
    // Too small — linear ramp from 0 at ratio=0 to 1 at ratio=0.5
    volScore = fillRatio / 0.5;
  } else {
    // Too large — linear decay from 1 at ratio=0.9 to 0 at ratio=1.5
    volScore = clamp01(1.0 - (fillRatio - 0.9) / 0.6);
  }

  // ── Weighted combination ──
  // Weights: HBD complementarity 35%, HBA complementarity 35%, volume fit 30%
  const score = 0.35 * hbdComplement + 0.35 * hbaComplement + 0.30 * volScore;
  return Math.round(score * 10000) / 10000;
}


// ─────────────────────────────────────────────────────────────────────────────
// Composite Score
//
// Weighted sum of druglikeness and pocket complementarity:
//
//   composite = W_druglikeness × druglikeness_score
//             + W_complementarity × complementarity_score
//
// Weights:
//   W_druglikeness     = 0.40  (a good drug must be drug-like)
//   W_complementarity  = 0.60  (but pocket fit matters more for screening)
//
// Rationale: In a virtual screening campaign, the primary goal is finding
// molecules that bind the target. Druglikeness is important for downstream
// development but is a secondary filter at this stage.
// ─────────────────────────────────────────────────────────────────────────────

const W_DRUGLIKENESS     = 0.40;
const W_COMPLEMENTARITY  = 0.60;


// ─────────────────────────────────────────────────────────────────────────────
// Main scoring function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score a molecule against a target pocket configuration.
 *
 * @param {string} smiles       - SMILES string of the molecule
 * @param {object} targetConfig - Target pocket config (from target.json)
 * @returns {Promise<object|null>} Scoring result or null if SMILES is invalid
 *
 * Return shape:
 * {
 *   smiles:               string,   // input SMILES
 *   mw:                   number,   // molecular weight (Da)
 *   logp:                 number,   // estimated LogP
 *   hbd:                  number,   // H-bond donor count (Lipinski)
 *   hba:                  number,   // H-bond acceptor count (Lipinski)
 *   rotatable_bonds:      number,   // rotatable bond count
 *   druglikeness_score:   number,   // [0,1] Lipinski partial-credit score
 *   complementarity_score:number,   // [0,1] pocket complementarity score
 *   composite_score:      number,   // weighted sum (see weights above)
 * }
 */
export async function scoreMolecule(smiles, targetConfig) {
  try {
    const RDKit = await ensureRDKit();

    // ── Parse SMILES ──
    const mol = RDKit.get_mol(smiles);
    if (!mol || !mol.is_valid()) {
      // Invalid SMILES — clean up and return null
      if (mol) mol.delete();
      return null;
    }

    // ── Extract RDKit descriptors ──
    let descriptors;
    try {
      descriptors = JSON.parse(mol.get_descriptors());
    } catch {
      mol.delete();
      return null;
    }

    const mw             = descriptors.exactmw  ?? descriptors.amw ?? 0;
    const hbd            = descriptors.lipinskiHBD ?? descriptors.NumHBD ?? 0;
    const hba            = descriptors.lipinskiHBA ?? descriptors.NumHBA ?? 0;
    const rotatableBonds = descriptors.NumRotatableBonds ?? 0;
    const heavyAtoms     = descriptors.NumHeavyAtoms ?? 0;

    // Done with the C++ mol object — free memory immediately
    mol.delete();

    // ── Estimate LogP (not available in MinimalLib) ──
    const logp = estimateLogP(smiles, hbd, hba, heavyAtoms);

    // ── Compute scores ──
    const druglikenessScore    = computeDruglikenessScore(mw, logp, hbd, hba);
    const complementarityScore = computePocketComplementarityScore(
      hbd, hba, heavyAtoms, targetConfig
    );
    const compositeScore = Math.round(
      (W_DRUGLIKENESS * druglikenessScore + W_COMPLEMENTARITY * complementarityScore) * 10000
    ) / 10000;

    return {
      smiles,
      mw:                    Math.round(mw * 100) / 100,
      logp,
      hbd,
      hba,
      rotatable_bonds:       rotatableBonds,
      druglikeness_score:    druglikenessScore,
      complementarity_score: complementarityScore,
      composite_score:       compositeScore,
    };
  } catch (err) {
    // Any unexpected error — log and return null, never throw
    console.error(`[MolecularScorer] Error scoring "${smiles}":`, err?.message || err);
    return null;
  }
}
