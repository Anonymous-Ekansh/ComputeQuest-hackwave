/**
 * Client-side card catalog (ES module).
 * Mirrors shared/cards.js but exported as ESM for Vite.
 */

export const CARD_CATALOG = [
  // ── Common (cost 10) ──
  { id: 'oc_surge', name: 'Surge Protocol', type: 'OVERCLOCK', attack: 7, defense: 3, rarity: 'common', cost: 10, description: 'A quick burst of raw processing power.' },
  { id: 'oc_blitz', name: 'Blitz Core', type: 'OVERCLOCK', attack: 8, defense: 2, rarity: 'common', cost: 10, description: 'Overclocked core running at dangerous speeds.' },
  { id: 'co_cryo', name: 'Cryogenic Sink', type: 'COOLANT', attack: 4, defense: 6, rarity: 'common', cost: 10, description: 'Sub-zero cooling keeps systems stable.' },
  { id: 'co_flow', name: 'Flow Regulator', type: 'COOLANT', attack: 3, defense: 7, rarity: 'common', cost: 10, description: 'Precision thermal management under pressure.' },
  { id: 'fw_patch', name: 'Hotfix Patch', type: 'FIRMWARE', attack: 5, defense: 5, rarity: 'common', cost: 10, description: 'Emergency firmware update—fast and balanced.' },

  // ── Uncommon (cost 25) ──
  { id: 'oc_nova', name: 'Nova Burst', type: 'OVERCLOCK', attack: 9, defense: 4, rarity: 'uncommon', cost: 25, description: 'Explosive clock-speed spike that overwhelms defenses.' },
  { id: 'co_glacier', name: 'Glacier Shield', type: 'COOLANT', attack: 5, defense: 9, rarity: 'uncommon', cost: 25, description: 'An impenetrable wall of crystallized coolant.' },
  { id: 'fw_compile', name: 'Deep Compile', type: 'FIRMWARE', attack: 7, defense: 7, rarity: 'uncommon', cost: 25, description: 'Full recompilation—optimized for any scenario.' },
  { id: 'fw_kernel', name: 'Kernel Rewrite', type: 'FIRMWARE', attack: 8, defense: 6, rarity: 'uncommon', cost: 25, description: 'A deep OS-level rewrite that shifts the balance.' },
  { id: 'co_liquid', name: 'Liquid Nitrogen', type: 'COOLANT', attack: 6, defense: 8, rarity: 'uncommon', cost: 25, description: 'Extreme sub-zero coolant for maximum stability.' },

  // ── Rare (cost 50) ──
  { id: 'oc_quantum', name: 'Quantum Overclock', type: 'OVERCLOCK', attack: 10, defense: 5, rarity: 'rare', cost: 50, description: 'Harnesses quantum tunneling for impossible clock speeds.' },
  { id: 'co_absolute', name: 'Absolute Zero', type: 'COOLANT', attack: 6, defense: 10, rarity: 'rare', cost: 50, description: 'Thermodynamic perfection—nothing gets through.' },
  { id: 'fw_genesis', name: 'Genesis Firmware', type: 'FIRMWARE', attack: 9, defense: 8, rarity: 'rare', cost: 50, description: 'The original code reborn—powerful and resilient.' },
  { id: 'oc_hyper', name: 'Hyperthreader', type: 'OVERCLOCK', attack: 11, defense: 3, rarity: 'rare', cost: 50, description: 'Maximum parallel execution at the cost of all defense.' },
  { id: 'fw_sentinel', name: 'Sentinel OS', type: 'FIRMWARE', attack: 8, defense: 9, rarity: 'rare', cost: 50, description: 'A self-healing operating system that adapts to threats.' },
];

export const CARD_MAP = {};
for (const card of CARD_CATALOG) {
  CARD_MAP[card.id] = card;
}

// Type advantage: OVERCLOCK → COOLANT → FIRMWARE → OVERCLOCK
export const TYPE_ADVANTAGE = {
  OVERCLOCK: 'COOLANT',
  COOLANT: 'FIRMWARE',
  FIRMWARE: 'OVERCLOCK',
};

export function hasAdvantage(attackerType, defenderType) {
  return TYPE_ADVANTAGE[attackerType] === defenderType;
}

export function adjustedPower(card, opponentCard) {
  let power = card.attack + card.defense;
  if (hasAdvantage(card.type, opponentCard.type)) {
    power = Math.floor(power * 1.5);
  }
  return power;
}

export function simulateBattle(playerDeck, botDeck) {
  const rounds = [];
  let playerWins = 0;
  let botWins = 0;

  for (let i = 0; i < 4; i++) {
    const playerCard = playerDeck[i];
    const botCard = botDeck[i];
    const playerPower = adjustedPower(playerCard, botCard);
    const botPower = adjustedPower(botCard, playerCard);
    const winner = playerPower > botPower ? 'player' : 'bot';
    if (winner === 'player') playerWins++;
    else botWins++;
    rounds.push({
      round: i + 1,
      playerCard: { id: playerCard.id, type: playerCard.type, attack: playerCard.attack, defense: playerCard.defense },
      botCard: { id: botCard.id, type: botCard.type, attack: botCard.attack, defense: botCard.defense },
      playerPower,
      botPower,
      winner,
    });
  }

  const matchWinner = playerWins > botWins ? 'player' : 'bot';
  return { rounds, playerWins, botWins, winner: matchWinner };
}

// Bot tiers
export const BOT_TIERS = [
  { name: 'Scrapyard Bot', minTrophies: 0, maxTrophies: 9, cardIds: ['oc_surge', 'co_cryo', 'fw_patch', 'oc_blitz'] },
  { name: 'Factory Bot', minTrophies: 10, maxTrophies: 29, cardIds: ['oc_nova', 'co_flow', 'fw_compile', 'co_cryo'] },
  { name: 'Overlord Bot', minTrophies: 30, maxTrophies: Infinity, cardIds: ['oc_quantum', 'co_absolute', 'fw_genesis', 'fw_kernel'] },
];

export function getBotTier(trophies) {
  for (const tier of BOT_TIERS) {
    if (trophies >= tier.minTrophies && trophies <= tier.maxTrophies) return tier;
  }
  return BOT_TIERS[BOT_TIERS.length - 1];
}
