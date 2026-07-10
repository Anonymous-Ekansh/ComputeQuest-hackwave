import { useState, useEffect, useRef, useCallback } from 'react';
import { CARD_MAP, getBotTier, simulateBattle } from './cardData';
import GameCard from './GameCard';
import './BattleScreen.css';

// Battle flow states
const STATES = {
  IDLE: 'idle',
  READY: 'ready',
  BATTLING: 'battling',
  RESULT: 'result',
};

const ROUND_DELAY = 1800; // ms between rounds
const REVEAL_DELAY = 600; // ms for card reveal

export default function BattleScreen({
  socket,
  savedDeck,
  trophies,
  ownedCards,
  onEditDeck,
  onVisitShop,
}) {
  const [battleState, setBattleState] = useState(STATES.IDLE);
  const [currentRound, setCurrentRound] = useState(0); // 0-based index
  const [revealedRounds, setRevealedRounds] = useState([]); // rounds that have been revealed
  const [battleResult, setBattleResult] = useState(null);
  const [serverConfirmed, setServerConfirmed] = useState(false);
  const [confirmedData, setConfirmedData] = useState(null);
  const [botTier, setBotTier] = useState(null);
  const [botDeck, setBotDeck] = useState([]);
  const [playerDeck, setPlayerDeck] = useState([]);
  const [toast, setToast] = useState(null);

  const timerRef = useRef(null);

  const hasDeck = savedDeck && savedDeck.length === 4;

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const startBattle = useCallback(() => {
    if (!hasDeck) return;

    // Resolve decks
    const pDeck = savedDeck.map(id => CARD_MAP[id]).filter(Boolean);
    if (pDeck.length !== 4) return;

    const tier = getBotTier(trophies || 0);
    const bDeck = tier.cardIds.map(id => CARD_MAP[id]);

    setPlayerDeck(pDeck);
    setBotDeck(bDeck);
    setBotTier(tier);
    setCurrentRound(0);
    setRevealedRounds([]);
    setBattleResult(null);
    setServerConfirmed(false);
    setConfirmedData(null);
    setToast(null);
    setBattleState(STATES.READY);
  }, [hasDeck, savedDeck, trophies]);

  const beginRounds = useCallback(() => {
    setBattleState(STATES.BATTLING);

    // Run the deterministic simulation
    const result = simulateBattle(playerDeck, botDeck);
    setBattleResult(result);

    // Reveal rounds sequentially
    let roundIdx = 0;
    function revealNext() {
      if (roundIdx >= 4) {
        // All rounds done — show result
        timerRef.current = setTimeout(() => {
          setBattleState(STATES.RESULT);

          // Report to server
          socket.emit('battle:report_result', {
            won: result.winner === 'player',
            trophies: trophies || 0,
          });

          // Listen for confirmation
          const handler = (data) => {
            setServerConfirmed(true);
            setConfirmedData(data);
            if (data.tierEscalation) {
              setToast(`⚠️ The bot is getting tougher — ${data.tierEscalation.newTier} opponents ahead!`);
            }
            socket.off('battle:result_confirmed', handler);
          };
          socket.on('battle:result_confirmed', handler);
        }, ROUND_DELAY);
        return;
      }

      setCurrentRound(roundIdx);
      setRevealedRounds(prev => [...prev, result.rounds[roundIdx]]);
      roundIdx++;

      timerRef.current = setTimeout(revealNext, ROUND_DELAY);
    }

    // Start first reveal after a brief pause
    timerRef.current = setTimeout(revealNext, REVEAL_DELAY);
  }, [playerDeck, botDeck, socket, trophies]);

  // Score from revealed rounds
  const playerScore = revealedRounds.filter(r => r.winner === 'player').length;
  const botScore = revealedRounds.filter(r => r.winner === 'bot').length;

  // ── IDLE STATE ──
  if (battleState === STATES.IDLE) {
    return (
      <div className="battle-screen">
        <div className="battle-idle">
          <div className="battle-idle-icon">⚔️</div>
          <h3>Battle Arena</h3>
          {hasDeck ? (
            <>
              <p>Challenge a bot opponent with your deck of 4 cards!</p>
              <div className="battle-trophy-display">
                <span className="trophy-icon">🏆</span>
                <span className="trophy-count">{trophies || 0}</span>
                <span className="trophy-label">Trophies</span>
              </div>
              <div className="battle-bot-preview">
                <span className="bot-label">Opponent: {getBotTier(trophies || 0).name}</span>
              </div>
              <button className="battle-start-btn" onClick={startBattle}>
                ⚔️ Find Opponent
              </button>
            </>
          ) : (
            <>
              <p className="battle-disabled-msg">Build a deck first to enter battle.</p>
              <button className="battle-edit-btn" onClick={onEditDeck}>
                🃏 Go to Deck Builder
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── READY STATE ──
  if (battleState === STATES.READY) {
    return (
      <div className="battle-screen">
        <div className="battle-matchup">
          <div className="matchup-header">
            <h3>Battle Ready</h3>
            <p>vs. {botTier?.name}</p>
          </div>

          <div className="matchup-arena">
            {/* Player side */}
            <div className="matchup-side player">
              <div className="side-label">You</div>
              <div className="matchup-cards">
                {playerDeck.map((card, i) => (
                  <GameCard key={i} card={card} state="owned" compact />
                ))}
              </div>
            </div>

            <div className="matchup-vs">VS</div>

            {/* Bot side */}
            <div className="matchup-side bot">
              <div className="side-label">{botTier?.name}</div>
              <div className="matchup-cards">
                {botDeck.map((_, i) => (
                  <GameCard key={i} card={botDeck[i]} state="facedown" compact />
                ))}
              </div>
            </div>
          </div>

          <button className="battle-go-btn" onClick={beginRounds}>
            ⚔️ Start Battle!
          </button>
        </div>
      </div>
    );
  }

  // ── BATTLING STATE ──
  if (battleState === STATES.BATTLING) {
    return (
      <div className="battle-screen">
        <div className="battle-arena">
          <div className="battle-scoreboard">
            <span className="score-player">You: {playerScore}</span>
            <span className="score-divider">—</span>
            <span className="score-bot">Bot: {botScore}</span>
          </div>

          <div className="battle-rounds">
            {[0, 1, 2, 3].map(i => {
              const revealed = revealedRounds[i];
              const isCurrent = i === currentRound && revealedRounds.length - 1 === i;

              return (
                <div
                  key={i}
                  className={`battle-round ${revealed ? 'revealed' : 'pending'} ${isCurrent ? 'current' : ''}`}
                >
                  <div className="round-label">Round {i + 1}</div>
                  <div className="round-cards">
                    <div className={`round-card-slot ${revealed ? (revealed.winner === 'player' ? 'winner' : 'loser') : ''}`}>
                      {revealed ? (
                        <GameCard
                          card={CARD_MAP[revealed.playerCard.id]}
                          state="battle"
                          className={revealed.winner === 'player' ? 'winner' : 'loser'}
                          compact
                        />
                      ) : (
                        <GameCard card={playerDeck[i]} state="facedown" compact />
                      )}
                      {revealed && (
                        <div className="round-power">{revealed.playerPower}</div>
                      )}
                    </div>

                    <div className="round-vs">⚡</div>

                    <div className={`round-card-slot ${revealed ? (revealed.winner === 'bot' ? 'winner' : 'loser') : ''}`}>
                      {revealed ? (
                        <GameCard
                          card={CARD_MAP[revealed.botCard.id]}
                          state="battle"
                          className={revealed.winner === 'bot' ? 'winner' : 'loser'}
                          compact
                        />
                      ) : (
                        <GameCard card={botDeck[i]} state="facedown" compact />
                      )}
                      {revealed && (
                        <div className="round-power">{revealed.botPower}</div>
                      )}
                    </div>
                  </div>
                  {revealed && (
                    <div className={`round-result ${revealed.winner}`}>
                      {revealed.winner === 'player' ? '✓ You win!' : '✗ Bot wins'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // ── RESULT STATE ──
  if (battleState === STATES.RESULT && battleResult) {
    const won = battleResult.winner === 'player';
    const delta = confirmedData?.delta;

    return (
      <div className="battle-screen">
        <div className={`battle-result ${won ? 'victory' : 'defeat'}`}>
          <div className="result-banner">
            <span className="result-icon">{won ? '🎉' : '💔'}</span>
            <h2>{won ? 'Victory!' : 'Defeat'}</h2>
            <div className="result-score">
              {battleResult.playerWins} — {battleResult.botWins}
            </div>
          </div>

          {/* Trophy change */}
          <div className="trophy-change">
            <span className="trophy-icon-large">🏆</span>
            {serverConfirmed && confirmedData?.success ? (
              <div className="trophy-delta">
                <span className={`delta-number ${delta > 0 ? 'positive' : 'negative'}`}>
                  {delta > 0 ? `+${delta}` : delta}
                </span>
                <span className="new-trophy-count">{confirmedData.trophies} trophies</span>
              </div>
            ) : (
              <div className="trophy-pending">
                <span className="spinner small"></span>
                <span>Confirming...</span>
              </div>
            )}
          </div>

          {/* Toast for tier escalation */}
          {toast && (
            <div className="battle-toast">
              {toast}
            </div>
          )}

          {/* Round recap */}
          <div className="result-rounds">
            {battleResult.rounds.map((r, i) => (
              <div key={i} className={`result-round-row ${r.winner}`}>
                <span className="result-round-label">R{r.round}</span>
                <span className="result-round-card">{CARD_MAP[r.playerCard.id]?.name}</span>
                <span className="result-round-power">{r.playerPower}</span>
                <span className="result-round-vs">vs</span>
                <span className="result-round-power">{r.botPower}</span>
                <span className="result-round-card">{CARD_MAP[r.botCard.id]?.name}</span>
                <span className={`result-round-winner ${r.winner}`}>
                  {r.winner === 'player' ? '✓' : '✗'}
                </span>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="result-actions">
            <button className="battle-again-btn" onClick={startBattle}>
              ⚔️ Battle Again
            </button>
            <button className="result-nav-btn" onClick={onEditDeck}>
              🃏 Edit Deck
            </button>
            <button className="result-nav-btn" onClick={onVisitShop}>
              🏪 Visit Shop
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
