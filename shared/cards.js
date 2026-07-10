/**
 * The Forge — Card Catalog
 * 15 cards: 5 common (10cr), 5 uncommon (25cr), 5 rare (50cr)
 *
 * Type advantage cycle:
 *   OVERCLOCK → COOLANT → FIRMWARE → OVERCLOCK  (×1.5 multiplier)
 *
 * Shared between client (display) and server (validation / re-simulation).
 */

const CARD_CATALOG = [
  // ── Common (cost 10 crystals) ──
  { id: 'oc_surge', name: 'Surge Protocol', type: 'OVERCLOCK', attack: 7, defense: 3, rarity: 'common', cost: 10, glyph: '🗲', description: 'A quick burst of raw processing power.' },
  { id: 'oc_blitz', name: 'Blitz Core', type: 'OVERCLOCK', attack: 8, defense: 2, rarity: 'common', cost: 10, glyph: '⚡', description: 'Overclocked core running at dangerous speeds.' },
  { id: 'co_cryo', name: 'Cryogenic Sink', type: 'COOLANT', attack: 4, defense: 6, rarity: 'common', cost: 10, glyph: '❄', description: 'Sub-zero cooling keeps systems stable.' },
  { id: 'co_flow', name: 'Flow Regulator', type: 'COOLANT', attack: 3, defense: 7, rarity: 'common', cost: 10, glyph: '💧', description: 'Precision thermal management under pressure.' },
  { id: 'fw_patch', name: 'Hotfix Patch', type: 'FIRMWARE', attack: 5, defense: 5, rarity: 'common', cost: 10, glyph: '🔩', description: 'Emergency firmware update—fast and balanced.' },

  // ── Uncommon (cost 25 crystals) ──
  { id: 'oc_nova', name: 'Nova Burst', type: 'OVERCLOCK', attack: 9, defense: 4, rarity: 'uncommon', cost: 25, glyph: '☀', description: 'Explosive clock-speed spike that overwhelms defenses.' },
  { id: 'co_glacier', name: 'Glacier Shield', type: 'COOLANT', attack: 5, defense: 9, rarity: 'uncommon', cost: 25, glyph: '🛡', description: 'An impenetrable wall of crystallized coolant.' },
  { id: 'fw_compile', name: 'Deep Compile', type: 'FIRMWARE', attack: 7, defense: 7, rarity: 'uncommon', cost: 25, glyph: '⚙', description: 'Full recompilation—optimized for any scenario.' },
  { id: 'fw_kernel', name: 'Kernel Rewrite', type: 'FIRMWARE', attack: 8, defense: 6, rarity: 'uncommon', cost: 25, glyph: '🧬', description: 'A deep OS-level rewrite that shifts the balance.' },
  { id: 'co_liquid', name: 'Liquid Nitrogen', type: 'COOLANT', attack: 6, defense: 8, rarity: 'uncommon', cost: 25, glyph: '🧊', description: 'Extreme sub-zero coolant for maximum stability.' },

  // ── Rare (cost 50 crystals) ──
  { id: 'oc_quantum', name: 'Quantum Overclock', type: 'OVERCLOCK', attack: 10, defense: 5, rarity: 'rare', cost: 50, glyph: '⚛', description: 'Harnesses quantum tunneling for impossible clock speeds.' },
  { id: 'co_absolute', name: 'Absolute Zero', type: 'COOLANT', attack: 6, defense: 10, rarity: 'rare', cost: 50, glyph: '💠', description: 'Thermodynamic perfection—nothing gets through.' },
  { id: 'fw_genesis', name: 'Genesis Firmware', type: 'FIRMWARE', attack: 9, defense: 8, rarity: 'rare', cost: 50, glyph: '🜲', description: 'The original code reborn—powerful and resilient.' },
  { id: 'oc_hyper', name: 'Hyperthreader', type: 'OVERCLOCK', attack: 11, defense: 3, rarity: 'rare', cost: 50, glyph: '🔥', description: 'Maximum parallel execution at the cost of all defense.' },
  { id: 'fw_sentinel', name: 'Sentinel OS', type: 'FIRMWARE', attack: 8, defense: 9, rarity: 'rare', cost: 50, glyph: '👁', description: 'A self-healing operating system that adapts to threats.' },
];

// Quick lookup by ID
const CARD_MAP = {};
for (const card of CARD_CATALOG) {
  CARD_MAP[card.id] = card;
}

module.exports = { CARD_CATALOG, CARD_MAP };
