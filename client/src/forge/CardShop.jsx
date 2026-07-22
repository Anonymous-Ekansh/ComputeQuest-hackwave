import { useState } from 'react';
import { CARD_CATALOG } from './cardData';
import GameCard from './GameCard';
import './CardShop.css';

const RARITY_FILTERS = ['all', 'common', 'uncommon', 'rare'];

export default function CardShop({ socket, crystals, ownedCards, localUpgrades, onUpgrade }) {
  const [filter, setFilter] = useState('all');
  const [unlocking, setUnlocking] = useState(null); 
  const [error, setError] = useState(null);
  const [pendingCard, setPendingCard] = useState(null); // card awaiting confirmation

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
    setPendingCard(null);

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
      {/* ── Confirmation Modal ── */}
      {pendingCard && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setPendingCard(null)}
        >
          <div
            style={{
              background: 'linear-gradient(135deg, #1e293b, #0f172a)',
              border: '1px solid #334155',
              borderRadius: '16px',
              padding: '32px',
              minWidth: '300px',
              textAlign: 'center',
              color: '#f1f5f9',
              boxShadow: '0 25px 50px rgba(0,0,0,0.8)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              Confirm Purchase
            </p>
            <h3 style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: '4px' }}>
              {pendingCard.name}
            </h3>
            <p style={{ color: '#06b6d4', fontSize: '1rem', marginBottom: '20px' }}>
              {pendingCard.cost} Crystals
            </p>
            <p style={{ color: '#64748b', fontSize: '0.8rem', marginBottom: '24px' }}>
              You have <strong style={{ color: '#f1f5f9' }}>{crystals}</strong> crystals. You will have <strong style={{ color: crystals - pendingCard.cost >= 0 ? '#22c55e' : '#ef4444' }}>{crystals - pendingCard.cost}</strong> left.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={() => setPendingCard(null)}
                style={{
                  padding: '10px 24px', borderRadius: '8px',
                  background: 'transparent', border: '1px solid #475569',
                  color: '#94a3b8', cursor: 'pointer', fontSize: '0.9rem',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleUnlock(pendingCard)}
                style={{
                  padding: '10px 24px', borderRadius: '8px',
                  background: 'linear-gradient(135deg, #06b6d4, #0891b2)',
                  border: 'none', color: '#fff', cursor: 'pointer',
                  fontSize: '0.9rem', fontWeight: 700,
                }}
              >
                Confirm Buy
              </button>
            </div>
          </div>
        </div>
      )}

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
                {f === 'common' ? '10 CRYSTALS' : f === 'uncommon' ? '25 CRYSTALS' : '50 CRYSTALS'}
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
                onClick={state === 'affordable' ? () => setPendingCard(baseCard) : undefined}
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