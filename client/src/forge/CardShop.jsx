import { useState } from 'react';
import { CARD_CATALOG } from './cardData';
import GameCard from './GameCard';
import './CardShop.css';

const RARITY_FILTERS = ['all', 'common', 'uncommon', 'rare'];

export default function CardShop({ socket, crystals, ownedCards, localUpgrades, onUpgrade }) {
  const [filter, setFilter] = useState('all');
  const [unlocking, setUnlocking] = useState(null); 
  const [error, setError] = useState(null);

  const ownedSet = new Set(ownedCards || []);

  const filteredCards = filter === 'all'
    ? CARD_CATALOG
    : CARD_CATALOG.filter(c => c.rarity === filter);

  const getUpgradedCard = (baseCard) => {
    if (!baseCard) return null;
    const upg = localUpgrades[baseCard.id] || { attack: 0, defense: 0 };
    return { 
      ...baseCard, 
      attack: baseCard.attack + upg.attack, 
      defense: baseCard.defense + upg.defense 
    };
  };

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

      {error && (
        <div className="shop-error">
          <span>Error: {error}</span>
        </div>
      )}

      <div className="shop-grid">
        {filteredCards.map(baseCard => {
          const state = getCardState(baseCard);
          const isUnlocking = unlocking === baseCard.id;
          const displayCard = getUpgradedCard(baseCard);

          return (
            <div key={baseCard.id} className={`shop-card-wrapper ${isUnlocking ? 'unlocking' : ''}`}>
              <GameCard
                card={displayCard}
                state={state}
                showCost={!ownedSet.has(baseCard.id)}
                onUpgrade={onUpgrade}
                onClick={state === 'affordable' ? () => handleUnlock(baseCard) : undefined}
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

      <div className="shop-footer">
        <span>{ownedSet.size} / {CARD_CATALOG.length} cards unlocked</span>
      </div>
    </div>
  );
}