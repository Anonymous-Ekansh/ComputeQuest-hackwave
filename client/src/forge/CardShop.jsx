import { useState } from 'react';
import { CARD_CATALOG } from './cardData';
import GameCard from './GameCard';
import './CardShop.css';

const RARITY_FILTERS = ['all', 'common', 'uncommon', 'rare'];

export default function CardShop({ socket, crystals, ownedCards }) {
  const [filter, setFilter] = useState('all');
  const [unlocking, setUnlocking] = useState(null); // cardId being unlocked
  const [error, setError] = useState(null);

  const ownedSet = new Set(ownedCards || []);

  const filteredCards = filter === 'all'
    ? CARD_CATALOG
    : CARD_CATALOG.filter(c => c.rarity === filter);

  function getCardState(card) {
    if (ownedSet.has(card.id)) return 'owned';
    if (crystals >= card.cost) return 'affordable';
    return 'locked';
  }

  function handleUnlock(card) {
    if (unlocking) return;
    if (ownedSet.has(card.id)) return;
    if (crystals < card.cost) return;

    setUnlocking(card.id);
    setError(null);

    socket.emit('shop:unlock_card', { cardId: card.id });

    // Listen for result
    const handler = (result) => {
      setUnlocking(null);
      if (!result.success) {
        setError(result.reason === 'insufficient_crystals'
          ? 'Not enough crystals!'
          : result.reason === 'already_owned'
            ? 'Card already owned!'
            : 'Failed to unlock card.');
        setTimeout(() => setError(null), 3000);
      }
      socket.off('shop:unlock_result', handler);
    };
    socket.on('shop:unlock_result', handler);

    // Timeout safety
    setTimeout(() => {
      socket.off('shop:unlock_result', handler);
      setUnlocking(null);
    }, 10000);
  }

  return (
    <div className="card-shop">
      <div className="shop-header">
        <h3>Card Shop</h3>
        <p className="shop-subtitle">Spend crystals earned from computing to unlock cards</p>
      </div>

      {/* Rarity filter */}
      <div className="shop-filters">
        {RARITY_FILTERS.map(f => (
          <button
            key={f}
            className={`filter-btn ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            {f !== 'all' && (
              <span className="filter-cost">
                {f === 'common' ? '10' : f === 'uncommon' ? '25' : '50'}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Error toast */}
      {error && (
        <div className="shop-error">
          <span>Error: {error}</span>
        </div>
      )}

      {/* Card grid */}
      <div className="shop-grid">
        {filteredCards.map(card => {
          const state = getCardState(card);
          const isUnlocking = unlocking === card.id;

          return (
            <div key={card.id} className={`shop-card-wrapper ${isUnlocking ? 'unlocking' : ''}`}>
              <GameCard
                card={card}
                state={state}
                showCost={!ownedSet.has(card.id)}
                onClick={state === 'affordable' ? () => handleUnlock(card) : undefined}
              />
              {isUnlocking && (
                <div className="unlock-spinner">
                  <div className="spinner"></div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Stats */}
      <div className="shop-footer">
        <span>{ownedSet.size} / {CARD_CATALOG.length} cards unlocked</span>
      </div>
    </div>
  );
}
