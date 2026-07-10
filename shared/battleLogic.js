/**
 * The Forge — Battle Logic (deterministic)
 *
 * Pure function: same inputs → same output.
 * Used client-side for display AND server-side for validation.
 *
 * Type advantage cycle:
 *   OVERCLOCK beats COOLANT
 *   COOLANT   beats FIRMWARE
 *   FIRMWARE  beats OVERCLOCK
 *
 * Power = attack + defense.  Winning type matchup → ×1.5 multiplier.
 * Tie in adjusted power → bot wins (slight house edge).
 * Match winner = majority of 4 rounds. 2-2 tie → bot wins.
 */

const TYPE_ADVANTAGE = {
  OVERCLOCK: 'COOLANT',   // overclock beats coolant
  COOLANT:   'FIRMWARE',  // coolant beats firmware
  FIRMWARE:  'OVERCLOCK', // firmware beats overclock
};

/**
 * Check if attackerType has advantage over defenderType.
 * @param {string} attackerType
 * @param {string} defenderType
 * @returns {boolean}
 */
function hasAdvantage(attackerType, defenderType) {
  return TYPE_ADVANTAGE[attackerType] === defenderType;
}

/**
 * Compute adjusted power for a card against an opponent card.
 * @param {{ attack: number, defense: number, type: string }} card
 * @param {{ type: string }} opponentCard
 * @returns {number}
 */
function adjustedPower(card, opponentCard) {
  let power = card.attack + card.defense;
  if (hasAdvantage(card.type, opponentCard.type)) {
    power = Math.floor(power * 1.5);
  }
  return power;
}

/**
 * Simulate a full 4-round battle.
 *
 * @param {Array<{ id: string, attack: number, defense: number, type: string }>} playerDeck - exactly 4 cards
 * @param {Array<{ id: string, attack: number, defense: number, type: string }>} botDeck    - exactly 4 cards
 * @returns {{ rounds: Array<{ round: number, playerCard: object, botCard: object,
 *              playerPower: number, botPower: number, winner: 'player'|'bot' }>,
 *             playerWins: number, botWins: number, winner: 'player'|'bot' }}
 */
function simulateBattle(playerDeck, botDeck) {
  const rounds = [];
  let playerWins = 0;
  let botWins = 0;

  for (let i = 0; i < 4; i++) {
    const playerCard = playerDeck[i];
    const botCard = botDeck[i];

    const playerPower = adjustedPower(playerCard, botCard);
    const botPower = adjustedPower(botCard, playerCard);

    // tie → bot wins (house edge)
    const winner = playerPower > botPower ? 'player' : 'bot';

    if (winner === 'player') playerWins++;
    else botWins++;

    rounds.push({
      round: i + 1,
      playerCard: { id: playerCard.id, type: playerCard.type, attack: playerCard.attack, defense: playerCard.defense },
      botCard:    { id: botCard.id, type: botCard.type, attack: botCard.attack, defense: botCard.defense },
      playerPower,
      botPower,
      winner,
    });
  }

  // 2-2 tie → bot wins
  const matchWinner = playerWins > botWins ? 'player' : 'bot';

  return { rounds, playerWins, botWins, winner: matchWinner };
}

module.exports = { simulateBattle, adjustedPower, hasAdvantage, TYPE_ADVANTAGE };
