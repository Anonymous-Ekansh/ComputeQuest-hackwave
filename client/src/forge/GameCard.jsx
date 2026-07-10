/**
 * GameCard — reusable card component for Shop, Deck Builder, and Battle.
 * Shows the character's glyph prominently as a visual portrait.
 *
 * Props:
 *   card       — { id, name, type, attack, defense, rarity, cost, glyph, description }
 *   state      — 'locked' | 'affordable' | 'owned' | 'battle' | 'facedown'
 *   onClick    — optional click handler
 *   className  — optional extra classes ('winner', 'loser', 'selected')
 *   showCost   — whether to show the crystal cost badge (default: false)
 *   compact    — smaller version for deck slots
 */

const TYPE_COLORS = {
  OVERCLOCK: '#f97316',
  COOLANT: '#06b6d4',
  FIRMWARE: '#a855f7',
};

function getRarityStars(rarity) {
  const map = { common: 1, uncommon: 2, rare: 3 };
  return map[rarity] || 1;
}

export default function GameCard({
  card,
  state = 'owned',
  onClick,
  className = '',
  showCost = false,
  compact = false,
}) {
  if (!card) return null;

  const stars = getRarityStars(card.rarity);
  const maxStars = 3;
  const glyph = card.glyph || '⚒️';
  const typeColor = TYPE_COLORS[card.type] || '#818cf8';

  if (state === 'facedown') {
    return (
      <div className={`game-card facedown ${className}`} style={{
        background: 'linear-gradient(135deg, #1e293b, #0f172a)',
        border: '1px solid #334155',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <span style={{ fontSize: '2rem', opacity: 0.3 }}>⚒️</span>
        <span style={{ fontSize: '0.7rem', color: '#475569', marginTop: 8 }}>???</span>
      </div>
    );
  }

  return (
    <div
      className={`game-card ${state} ${className}`}
      data-type={card.type}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {showCost && (
        <span className="card-cost">💎 {card.cost}</span>
      )}

      {/* Character portrait — the hero visual */}
      <div className="card-character-frame" style={{
        '--type-color': typeColor,
      }}>
        <span className="card-character-glyph">{glyph}</span>
      </div>

      {/* Card name */}
      <span className="card-name">{card.name}</span>

      {/* Type badge */}
      <span className="card-type-badge" data-type={card.type}>
        {card.type}
      </span>

      {/* Rarity stars */}
      <div className="card-rarity">
        {Array.from({ length: maxStars }, (_, i) => (
          <span key={i} className={`card-rarity-star ${i < stars ? '' : 'dim'}`}>★</span>
        ))}
      </div>

      {/* Stats at bottom */}
      <div className="card-stats">
        <span className="card-stat attack">⚔ {card.attack}</span>
        <span className="card-stat defense">🛡 {card.defense}</span>
      </div>
    </div>
  );
}
