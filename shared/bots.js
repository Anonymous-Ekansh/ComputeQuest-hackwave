/**
 * The Forge — Bot Decks
 *
 * Three predefined decks selected by the player's trophy bracket.
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
    name: 'Factory Bot',
    minTrophies: 10,
    maxTrophies: 29,
    cardIds: ['oc_nova', 'co_flow', 'fw_compile', 'co_cryo'],
  },
  {
    name: 'Overlord Bot',
    minTrophies: 30,
    maxTrophies: Infinity,
    cardIds: ['oc_quantum', 'co_absolute', 'fw_genesis', 'fw_kernel'],
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
