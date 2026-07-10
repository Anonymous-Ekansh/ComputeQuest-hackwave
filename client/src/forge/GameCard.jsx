/**
 * GameCard — reusable card component for Shop, Deck Builder, and Battle.
 *
 * Props:
 *   card       — { id, name, type, attack, defense, rarity, cost, description }
 *   state      — 'locked' | 'affordable' | 'owned' | 'battle' | 'facedown'
 *   onClick    — optional click handler
 *   className  — optional extra classes ('winner', 'loser', 'selected')
 *   showCost   — whether to show the crystal cost badge (default: false)
 *   flipped    — whether the card is flipped (for battle reveal)
 *   compact    — smaller version for deck slots
 */

const TYPE_ICONS = {
  OVERCLOCK: '⚡',
  COOLANT: '❄️',
  FIRMWARE: '🔧',
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
  flipped = false,
  compact = false,
}) {
  if (!card) return null;

  const stars = getRarityStars(card.rarity);
  const maxStars = 3;

  if (flipped) {
    return (
      <div className={`card-flip-container ${compact ? 'compact' : ''}`}>
        <div className="card-flip-inner flipped">
          <div
            className={`game-card ${state} ${className}`}
            data-type={card.type}
          >
            <span className="card-type-badge" data-type={card.type}>
              {card.type}
            </span>
            <span className="card-icon">{TYPE_ICONS[card.type]}</span>
            <span className="card-name">{card.name}</span>
            <div className="card-rarity">
              {Array.from({ length: maxStars }, (_, i) => (
                <span key={i} className={`card-rarity-star ${i < stars ? '' : 'dim'}`}>★</span>
              ))}
            </div>
            <div className="card-stats">
              <span className="card-stat attack">⚔ {card.attack}</span>
              <span className="card-stat defense">🛡 {card.defense}</span>
            </div>
          </div>
          <div className="card-back">
            <span className="card-back-pattern">⚒️</span>
          </div>
        </div>
      </div>
    );
  }

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
      <span className="card-type-badge" data-type={card.type}>
        {card.type}
      </span>
      <span className="card-icon">{TYPE_ICONS[card.type]}</span>
      <span className="card-name">{card.name}</span>
      <div className="card-rarity">
        {Array.from({ length: maxStars }, (_, i) => (
          <span key={i} className={`card-rarity-star ${i < stars ? '' : 'dim'}`}>★</span>
        ))}
      </div>
      <div className="card-stats">
        <span className="card-stat attack">⚔ {card.attack}</span>
        <span className="card-stat defense">🛡 {card.defense}</span>
      </div>
    </div>
  );
}
