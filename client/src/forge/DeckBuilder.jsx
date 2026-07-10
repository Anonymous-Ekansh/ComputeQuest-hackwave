import { useState, useEffect } from 'react';
import { CARD_MAP } from './cardData';
import GameCard from './GameCard';
import './DeckBuilder.css';

const DECK_SIZE = 4;

export default function DeckBuilder({ socket, ownedCards, savedDeck, onBattle }) {
  const [deckSlots, setDeckSlots] = useState([null, null, null, null]);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState(null);

  const ownedSet = new Set(ownedCards || []);
  const ownedCardObjects = (ownedCards || []).map(id => CARD_MAP[id]).filter(Boolean);

  // Load saved deck on mount / when savedDeck changes
  useEffect(() => {
    if (savedDeck && savedDeck.length === DECK_SIZE) {
      setDeckSlots(savedDeck.map(id => CARD_MAP[id] || null));
    }
  }, [savedDeck]);

  // Cards in deck (by id)
  const deckCardIds = new Set(deckSlots.filter(Boolean).map(c => c.id));

  function addToDeck(card) {
    const emptyIdx = deckSlots.findIndex(s => s === null);
    if (emptyIdx === -1) return; // deck full
    if (deckCardIds.has(card.id)) return; // already in deck
    const newSlots = [...deckSlots];
    newSlots[emptyIdx] = card;
    setDeckSlots(newSlots);
  }

  function removeFromDeck(idx) {
    const newSlots = [...deckSlots];
    newSlots[idx] = null;
    setDeckSlots(newSlots);
  }

  function handleSave() {
    const ids = deckSlots.filter(Boolean).map(c => c.id);
    if (ids.length !== DECK_SIZE) return;

    setSaving(true);
    setSaveMessage(null);

    socket.emit('deck:save', { cardIds: ids });

    const handler = (result) => {
      setSaving(false);
      if (result.success) {
        setSaveMessage({ type: 'success', text: 'Deck saved!' });
      } else {
        setSaveMessage({ type: 'error', text: result.reason || 'Failed to save deck' });
      }
      setTimeout(() => setSaveMessage(null), 3000);
      socket.off('deck:save_result', handler);
    };
    socket.on('deck:save_result', handler);

    setTimeout(() => {
      socket.off('deck:save_result', handler);
      setSaving(false);
    }, 10000);
  }

  const deckComplete = deckSlots.every(s => s !== null);
  const hasEnoughCards = ownedCardObjects.length >= DECK_SIZE;

  if (!hasEnoughCards) {
    return (
      <div className="deck-builder">
        <div className="deck-empty-state">
          <div className="empty-icon">Empty</div>
          <h3>Unlock at least 4 cards to build a deck</h3>
          <p>Visit the Card Shop to unlock cards with your earned crystals.</p>
          <div className="empty-progress">
            <div className="empty-progress-track">
              <div
                className="empty-progress-fill"
                style={{ width: `${(ownedCardObjects.length / DECK_SIZE) * 100}%` }}
              />
            </div>
            <span>{ownedCardObjects.length} / {DECK_SIZE} cards</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="deck-builder">
      <div className="deck-header">
        <h3>Deck Builder</h3>
        <p className="deck-subtitle">Select 4 cards for your battle deck</p>
      </div>

      {/* Deck slots */}
      <div className="deck-slots">
        <div className="deck-slots-label">Your Deck</div>
        <div className="deck-slots-grid">
          {deckSlots.map((card, idx) => (
            <div
              key={idx}
              className={`deck-slot ${card ? 'filled' : 'empty'}`}
              onClick={() => card && removeFromDeck(idx)}
              title={card ? `Click to remove ${card.name}` : `Slot ${idx + 1} — empty`}
            >
              {card ? (
                <GameCard card={card} state="owned" compact />
              ) : (
                <div className="deck-slot-placeholder">
                  <span className="slot-number">{idx + 1}</span>
                  <span className="slot-hint">Empty</span>
                </div>
              )}
              {card && <span className="slot-remove">✕</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="deck-actions">
        <button
          className="deck-save-btn"
          onClick={handleSave}
          disabled={!deckComplete || saving}
        >
          {saving ? 'Saving…' : 'Save Deck'}
        </button>
        {deckComplete && savedDeck && savedDeck.length === DECK_SIZE && (
          <button className="deck-battle-btn" onClick={onBattle}>
            Go to Battle
          </button>
        )}
      </div>

      {/* Save message */}
      {saveMessage && (
        <div className={`deck-message ${saveMessage.type}`}>
          {saveMessage.type === 'success' ? 'Success:' : 'Error:'} {saveMessage.text}
        </div>
      )}

      {/* Available cards */}
      <div className="deck-available">
        <div className="deck-available-label">
          Your Cards ({ownedCardObjects.length})
        </div>
        <div className="deck-available-grid">
          {ownedCardObjects.map(card => {
            const inDeck = deckCardIds.has(card.id);
            return (
              <div key={card.id} className={`deck-card-wrapper ${inDeck ? 'in-deck' : ''}`}>
                <GameCard
                  card={card}
                  state="owned"
                  className={inDeck ? 'dimmed' : ''}
                  onClick={!inDeck ? () => addToDeck(card) : undefined}
                />
                {inDeck && <span className="in-deck-badge">In Deck</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
