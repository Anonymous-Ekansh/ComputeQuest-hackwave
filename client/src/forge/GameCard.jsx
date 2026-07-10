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
  onUpgrade,
  className = '',
  showCost = false,
  compact = false,
  upgradesCount = 0,
}) {
  if (!card) return null;

  const stars = getRarityStars(card.rarity);
  const maxStars = 3;
  const glyph = card.glyph || '?';
  const typeColor = TYPE_COLORS[card.type] || '#818cf8';

  if (state === 'facedown') {
    return (
      <div className={`game-card facedown ${className}`} style={{
        background: 'linear-gradient(135deg, #1e293b, #0f172a)',
        border: '1px solid #334155',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <span style={{ fontSize: '2rem', opacity: 0.3 }}>?</span>
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
        <span className="card-cost">{card.cost}</span>
      )}

      <div className="card-character-frame" style={{ '--type-color': typeColor }}>
        <span className="card-character-glyph">{glyph}</span>
      </div>

      <span className="card-name">{card.name}</span>

      <span className="card-type-badge" data-type={card.type}>
        {card.type}
      </span>

      <div className="card-rarity">
        {Array.from({ length: maxStars }, (_, i) => (
          <span key={i} className={`card-rarity-star ${i < stars ? '' : 'dim'}`}>★</span>
        ))}
      </div>

      <div className="card-stats">
        <span className="card-stat attack">ATK: {card.attack}</span>
        <span className="card-stat defense">DEF: {card.defense}</span>
      </div>

      {state === 'owned' && onUpgrade && (
        <div className="card-upgrade-overlay">
          <div className="upgrade-limit-text" style={{ fontSize: '0.7rem', color: '#cbd5e1', marginBottom: '4px' }}>
            {upgradesCount}/10 used
          </div>
          <button 
            className="upgrade-btn"
            onClick={(e) => { e.stopPropagation(); onUpgrade(card.id, 'attack'); }}
            disabled={upgradesCount >= 10}
            style={upgradesCount >= 10 ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
          >
            +1 ATK (10 Crystals)
          </button>
          <button 
            className="upgrade-btn"
            onClick={(e) => { e.stopPropagation(); onUpgrade(card.id, 'defense'); }}
            disabled={upgradesCount >= 10}
            style={upgradesCount >= 10 ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
          >
            +1 DEF (10 Crystals)
          </button>
        </div>
      )}
    </div>
  );
}