/**
 * server/src/molecularScorer.js — Server-side molecular scoring for spot-check verification
 *
 * This is a Node.js-compatible port of client/src/workers/molecularScorer.js.
 * Uses the same RDKit.js WASM module and identical scoring logic so that
 * server-side spot-checks produce matching scores.
 *
 * Singleton pattern: RDKit WASM is loaded once on first call, then cached.
 */

const initRDKitModule = require('@rdkit/rdkit');

// ── RDKit Module Singleton ──────────────────────────────────────────────────
let rdkit = null;
let rdkitPromise = null;

/**
 * Lazily initialize the RDKit WASM module (singleton).
 * @returns {Promise<RDKitModule>}
 */
async function ensureRDKit() {
  if (rdkit) return rdkit;
  if (rdkitPromise) return rdkitPromise;

  console.log('[MolecularScorer:Server] Initializing RDKit WASM module...');
  rdkitPromise = (async () => {
    try {
      const mod = await initRDKitModule();
      rdkit = mod;
      rdkitPromise = null;
      console.log(`[MolecularScorer:Server] RDKit ${mod.version()} ready.`);
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
// (Identical to client/src/workers/molecularScorer.js)
// ─────────────────────────────────────────────────────────────────────────────

function estimateLogP(smiles, hbd, hba, _heavyAtoms) {
  const aromaticC = (smiles.match(/c/g) || []).length;
  const aliphaticC = (smiles.match(/C/g) || []).length;
  const nCount = (smiles.match(/[nN]/g) || []).length;
  const oCount = (smiles.match(/[oO]/g) || []).length;
  const sCount = (smiles.match(/[sS](?!e|i)/g) || []).length;
  const fCount = (smiles.match(/F/g) || []).length;
  const clCount = (smiles.match(/Cl/g) || []).length;
  const brCount = (smiles.match(/Br/g) || []).length;
  const pCount = (smiles.match(/P/g) || []).length;
  const seCount = (smiles.match(/Se/g) || []).length;
  const amideCount = (smiles.match(/C\(=O\)N|NC\(=O\)|c\(=O\)n|nc\(=O\)/g) || []).length;

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
  logP += hbd * (-0.45);
  logP += hba * (-0.12);
  logP += amideCount * (-0.65);
  return Math.round(logP * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Druglikeness Score — Lipinski Rule-of-Five (partial credit)
// ─────────────────────────────────────────────────────────────────────────────

function computeDruglikenessScore(mw, logP, hbd, hba) {
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const mwScore   = clamp01(mw   <= 500 ? 1.0 : 1.0 - (mw - 500) / 300);
  const logPScore = clamp01(logP <= 5   ? 1.0 : 1.0 - (logP - 5)  / 5);
  const hbdScore  = clamp01(hbd  <= 5   ? 1.0 : 1.0 - (hbd - 5)   / 5);
  const hbaScore  = clamp01(hba  <= 10  ? 1.0 : 1.0 - (hba - 10)  / 10);
  const score = (mwScore + logPScore + hbdScore + hbaScore) / 4;
  return Math.round(score * 10000) / 10000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pocket Complementarity Score
// ─────────────────────────────────────────────────────────────────────────────

const VDW_VOLUME_PER_HEAVY_ATOM = 18;

function computePocketComplementarityScore(hbd, hba, heavyAtoms, targetConfig) {
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const {
    pocket_hbond_acceptor_count: pocketHBA,
    pocket_hbond_donor_count: pocketHBD,
    pocket_volume_estimate_A3: pocketVol,
  } = targetConfig;

  const hbdComplement = clamp01(1.0 - Math.abs(hbd - pocketHBA) / Math.max(pocketHBA, 1));
  const hbaComplement = clamp01(1.0 - Math.abs(hba - pocketHBD) / Math.max(pocketHBD, 1));

  const molVol = heavyAtoms * VDW_VOLUME_PER_HEAVY_ATOM;
  const fillRatio = molVol / pocketVol;
  let volScore;
  if (fillRatio >= 0.5 && fillRatio <= 0.9) {
    volScore = 1.0;
  } else if (fillRatio < 0.5) {
    volScore = fillRatio / 0.5;
  } else {
    volScore = clamp01(1.0 - (fillRatio - 0.9) / 0.6);
  }

  const score = 0.35 * hbdComplement + 0.35 * hbaComplement + 0.30 * volScore;
  return Math.round(score * 10000) / 10000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite Score Weights
// ─────────────────────────────────────────────────────────────────────────────

const W_DRUGLIKENESS    = 0.40;
const W_COMPLEMENTARITY = 0.60;

// ─────────────────────────────────────────────────────────────────────────────
// Main scoring function (identical output shape to the client scorer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score a molecule against a target pocket configuration (server-side).
 *
 * @param {string} smiles       - SMILES string
 * @param {object} targetConfig - Target pocket config (from target.json)
 * @returns {Promise<object|null>} Scoring result or null for invalid SMILES
 */
async function scoreMolecule(smiles, targetConfig) {
  try {
    const RDKit = await ensureRDKit();

    const mol = RDKit.get_mol(smiles);
    if (!mol || !mol.is_valid()) {
      if (mol) mol.delete();
      return null;
    }

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
    mol.delete();

    const logp = estimateLogP(smiles, hbd, hba, heavyAtoms);
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
    console.error(`[MolecularScorer:Server] Error scoring "${smiles}":`, err?.message || err);
    return null;
  }
}

module.exports = { ensureRDKit, scoreMolecule };
