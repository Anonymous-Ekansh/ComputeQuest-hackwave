import { useState } from 'react';
import CardShop from './CardShop';
import DeckBuilder from './DeckBuilder';
import BattleScreen from './BattleScreen';
import { CREDITS_PER_CRYSTAL } from './cardData';
import './TheForge.css';

const TABS = [
  { id: 'shop', label: 'Card Shop' },
  { id: 'deck', label: 'Deck' },
  { id: 'battle', label: 'Battle' },
];

export default function TheForge({ socket, userInfo, isAuthenticated }) {
  const [activeTab, setActiveTab] = useState('shop');
  
  const currentCredits = userInfo?.credits || 0;
  
  const crystals = Math.floor(currentCredits / CREDITS_PER_CRYSTAL);
  const creditsToNext = currentCredits % CREDITS_PER_CRYSTAL;
  const trophies = userInfo?.trophies || 0;
  const ownedCards = userInfo?.ownedCards || [];
  const savedDeck = userInfo?.savedDeck || [];
  const upgrades = userInfo?.upgrades || {};

  const handleUpgrade = (cardId, statType) => {
    socket.emit('card:upgrade', { cardId, statType });
  };

  if (!isAuthenticated) {
    return (
      <div className="forge-locked">
        <div className="forge-locked-content">
          <div className="forge-locked-icon">Locked</div>
          <h2>The Forge</h2>
          <p>Sign in and start computing to unlock The Forge.</p>
          <div className="forge-locked-preview">
            <div className="preview-card"></div>
            <div className="preview-card"></div>
            <div className="preview-card"></div>
            <div className="preview-card"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="forge">
      <div className="forge-header">
        <div className="forge-title">
          <span className="forge-logo"></span>
          <h2>The Forge</h2>
        </div>
        <div className="forge-stats">
          <div className="forge-stat crystals">
            <span className="stat-icon"></span>
            <div className="crystal-display" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.1 }}>
              <span className="stat-value">{crystals} crystals</span>
              <span style={{ fontSize: '0.6rem', color: '#94a3b8', fontWeight: 'normal' }}>
                {creditsToNext}/{CREDITS_PER_CRYSTAL} credits
              </span>
            </div>
          </div>
          <div className="forge-stat trophies">
            <span className="stat-icon"></span>
            <span className="stat-value">{trophies}</span>
            <span className="stat-label">Trophies</span>
          </div>
        </div>
      </div>

      <div className="forge-tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`forge-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.icon && <span className="tab-icon">{tab.icon}</span>}
            <span className="tab-label">{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="forge-content">
        {activeTab === 'shop' && (
          <CardShop
            socket={socket}
            crystals={crystals}
            ownedCards={ownedCards}
            localUpgrades={upgrades}
          />
        )}
        {activeTab === 'deck' && (
          <DeckBuilder
            socket={socket}
            ownedCards={ownedCards}
            savedDeck={savedDeck}
            localUpgrades={upgrades}
            isEligibleForUpgrade={userInfo?.isEligibleForUpgrade}
            onUpgrade={handleUpgrade}
            onBattle={() => setActiveTab('battle')}
          />
        )}
        {activeTab === 'battle' && (
          <BattleScreen
            socket={socket}
            savedDeck={savedDeck}
            trophies={trophies}
            ownedCards={ownedCards}
            localUpgrades={upgrades} 
            onEditDeck={() => setActiveTab('deck')}
            onVisitShop={() => setActiveTab('shop')}
          />
        )}
      </div>
    </div>
  );
}