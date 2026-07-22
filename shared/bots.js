/**
 * The Forge — Bot Decks
 *
 * Seven predefined decks selected by the player's trophy bracket.
 * The client picks the tier locally; the server re-validates using the
 * same thresholds during battle result confirmation.
 */

const BOT_TIERS = [
  {
    name: 'Scrapyard Bot',
    minTrophies: 0,
    maxTrophies: 9,
    cardIds: ['oc_surge', 'co_cryo', 'fw_patch', 'oc_blitz'],
  },
  {
    name: 'Assembly Bot',
    minTrophies: 10,
    maxTrophies: 24,
    cardIds: ['oc_nova', 'co_flow', 'fw_compile', 'co_cryo'],
  },
  {
    name: 'Factory Bot',
    minTrophies: 25,
    maxTrophies: 44,
    cardIds: ['oc_nova', 'co_glacier', 'fw_kernel', 'co_liquid'],
  },
  {
    name: 'Warden Bot',
    minTrophies: 45,
    maxTrophies: 69,
    cardIds: ['oc_quantum', 'co_glacier', 'fw_compile', 'fw_kernel'],
  },
  {
    name: 'Titan Bot',
    minTrophies: 70,
    maxTrophies: 99,
    cardIds: ['oc_quantum', 'co_absolute', 'fw_genesis', 'oc_hyper'],
  },
  {
    name: 'Overlord Bot',
    minTrophies: 100,
    maxTrophies: 149,
    cardIds: ['oc_quantum', 'co_absolute', 'fw_genesis', 'fw_sentinel'],
  },
  {
    name: 'Apex Bot',
    minTrophies: 150,
    maxTrophies: Infinity,
    cardIds: ['oc_hyper', 'co_absolute', 'fw_sentinel', 'fw_genesis'],
  },
];

/**
 * Returns the bot tier for a given trophy count.
 * @param {number} trophies
 * @returns {{ name: string, minTrophies: number, maxTrophies: number, cardIds: string[] }}
 */
function getBotTier(trophies) {
  for (const tier of BOT_TIERS) {
    if (trophies >= tier.minTrophies && trophies <= tier.maxTrophies) {
      return tier;
    }
  }
  // fallback to hardest tier
  return BOT_TIERS[BOT_TIERS.length - 1];
}

module.exports = { BOT_TIERS, getBotTier };
