import { useState, useEffect, useRef, useCallback } from 'react';
import { CARD_MAP, getBotTier, hasAdvantage } from './cardData';
import GameCard from './GameCard';
import './BattleScreen.css';

// ── Arena constants ──────────────────────────────────────────────────────────
const ARENA_W = 700;
const ARENA_H = 400;
const CHAR_SIZE = 48;
const MOVE_SPEED = 2;          // px per tick (player & bot)
const ATTACK_RANGE = 80;         // px — close enough to hit
const ATTACK_COOLDOWN = 1200;     // ms between attacks
const MANUAL_ATTACK_MULTIPLIER = 1.4;
const MANUAL_ATTACK_COOLDOWN = 500; // ms
const TICK_MS = 16;              // ~60 fps
const HINT_DURATION = 4000;      // control hint stays visible (ms)
const HP_SCALE = 8;              // base HP multiplier (attack + defense) * scale

// Battle flow states
const STATES = { IDLE: 'idle', READY: 'ready', BATTLING: 'battling', RESULT: 'result' };

// ── helpers ──────────────────────────────────────────────────────────────────
function dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function dmg(attacker, defender) {
  let power = attacker.card.attack;
  if (hasAdvantage(attacker.card.type, defender.card.type)) {
    power = Math.floor(power * 1.5);
  }
  // defense reduces damage slightly
  const reduced = Math.max(1, power - Math.floor(defender.card.defense * 0.3));
  return reduced;
}

function buildFighter(card, team, idx, total) {
  const spacing = ARENA_H / (total + 1);
  const x = team === 'player' ? 60 : ARENA_W - 60;
  const y = spacing * (idx + 1);
  const maxHp = (card.attack + card.defense) * HP_SCALE;
  return {
    id: `${team}_${idx}`,
    card,
    team,
    x, y,
    hp: maxHp,
    maxHp,
    alive: true,
    lastAttackAt: 0,
    hitTimer: 0,    // >0 = showing hit flash
    lungeDir: 0,    // lunge offset during attack anim
    floatingDmg: [],
  };
}

// ══════════════════════════════════════════════════════════════════════════════

export default function BattleScreen({
  socket,
  savedDeck,
  trophies,
  ownedCards,
  onEditDeck,
  onVisitShop,
}) {
  const [battleState, setBattleState] = useState(STATES.IDLE);
  const [playerDeck, setPlayerDeck] = useState([]);
  const [botDeck, setBotDeck] = useState([]);
  const [botTier, setBotTier] = useState(null);
  const [fighters, setFighters] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [showHint, setShowHint] = useState(false);
  const [winner, setWinner] = useState(null);           // 'player' | 'bot' | null
  const [serverConfirmed, setServerConfirmed] = useState(false);
  const [confirmedData, setConfirmedData] = useState(null);
  const [toast, setToast] = useState(null);

  const keysRef = useRef(new Set());
  const fightersRef = useRef([]);
  const selectedIdxRef = useRef(0);
  const loopRef = useRef(null);
  const arenaRef = useRef(null);
  const winnerRef = useRef(null);

  const hasDeck = savedDeck && savedDeck.length === 4;

  // Keep refs in sync
  useEffect(() => { fightersRef.current = fighters; }, [fighters]);
  useEffect(() => { selectedIdxRef.current = selectedIdx; }, [selectedIdx]);
  useEffect(() => { winnerRef.current = winner; }, [winner]);

  // ── keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (battleState !== STATES.BATTLING) return;

    function handleKeyDown(e) {
      const k = e.key.toLowerCase();
      keysRef.current.add(k);
      if (k === ' ' && !e.repeat) keysRef.current.spacebarJustPressed = true;

      // number keys → switch selected character
      if (k >= '1' && k <= '4') {
        const idx = parseInt(k) - 1;
        const playerFighters = fightersRef.current.filter(f => f.team === 'player' && f.alive);
        if (idx < playerFighters.length) {
          const realIdx = fightersRef.current.indexOf(playerFighters[idx]);
          setSelectedIdx(realIdx);
        }
      }
    }
    function onUp(e) { keysRef.current.delete(e.key.toLowerCase()); }

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', onUp);
      keysRef.current.clear();
    };
  }, [battleState]);

  // ── click-to-select ────────────────────────────────────────────────────────
  const handleClickFighter = useCallback((idx) => {
    if (fightersRef.current[idx]?.team === 'player' && fightersRef.current[idx]?.alive) {
      setSelectedIdx(idx);
    }
  }, []);

  // ── start battle setup ─────────────────────────────────────────────────────
  const startBattle = useCallback(() => {
    if (!hasDeck) return;
    const pDeck = savedDeck.map(id => CARD_MAP[id]).filter(Boolean);
    if (pDeck.length !== 4) return;
    const tier = getBotTier(trophies || 0);
    const bDeck = tier.cardIds.map(id => CARD_MAP[id]);

    setPlayerDeck(pDeck);
    setBotDeck(bDeck);
    setBotTier(tier);
    setWinner(null);
    setServerConfirmed(false);
    setConfirmedData(null);
    setToast(null);
    setBattleState(STATES.READY);
  }, [hasDeck, savedDeck, trophies]);

  // ── begin the real-time fight ──────────────────────────────────────────────
  const beginFight = useCallback(() => {
    const allFighters = [
      ...playerDeck.map((c, i) => buildFighter(c, 'player', i, playerDeck.length)),
      ...botDeck.map((c, i) => buildFighter(c, 'bot', i, botDeck.length)),
    ];
    setFighters(allFighters);
    fightersRef.current = allFighters;
    setSelectedIdx(0);
    selectedIdxRef.current = 0;
    setShowHint(true);
    setBattleState(STATES.BATTLING);

    // fade out hint
    setTimeout(() => setShowHint(false), HINT_DURATION);
  }, [playerDeck, botDeck]);

  // ── game loop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (battleState !== STATES.BATTLING) return;

    const loop = setInterval(() => {
      const fs = fightersRef.current;
      if (!fs.length || winnerRef.current) return;

      const now = Date.now();
      const updated = fs.map(f => ({ ...f, floatingDmg: [...f.floatingDmg] }));
      const keys = keysRef.current;
      const selIdx = selectedIdxRef.current;

      const spacePressed = keys.spacebarJustPressed;
      keys.spacebarJustPressed = false;

      // ── move selected player character ──
      const sel = updated[selIdx];
      if (sel && sel.team === 'player' && sel.alive) {
        let dx = 0, dy = 0;
        if (keys.has('w') || keys.has('arrowup'))    dy = -MOVE_SPEED;
        if (keys.has('s') || keys.has('arrowdown'))  dy = MOVE_SPEED;
        if (keys.has('a') || keys.has('arrowleft'))  dx = -MOVE_SPEED;
        if (keys.has('d') || keys.has('arrowright')) dx = MOVE_SPEED;
        // normalize diagonal
        if (dx && dy) { dx *= 0.707; dy *= 0.707; }
        sel.x = Math.max(CHAR_SIZE / 2, Math.min(ARENA_W - CHAR_SIZE / 2, sel.x + dx));
        sel.y = Math.max(CHAR_SIZE / 2, Math.min(ARENA_H - CHAR_SIZE / 2, sel.y + dy));
      }

      // ── bot AI: path toward nearest player ──
      for (const bot of updated) {
        if (bot.team !== 'bot' || !bot.alive) continue;
        const targets = updated.filter(f => f.team === 'player' && f.alive);
        if (targets.length === 0) continue;

        // find nearest player
        let nearest = targets[0];
        let nearDist = dist(bot, nearest);
        for (const t of targets) {
          const d = dist(bot, t);
          if (d < nearDist) { nearest = t; nearDist = d; }
        }

        // move toward nearest
        if (nearDist > ATTACK_RANGE * 0.8) {
          const angle = Math.atan2(nearest.y - bot.y, nearest.x - bot.x);
          bot.x += Math.cos(angle) * MOVE_SPEED;
          bot.y += Math.sin(angle) * MOVE_SPEED;
          bot.x = Math.max(CHAR_SIZE / 2, Math.min(ARENA_W - CHAR_SIZE / 2, bot.x));
          bot.y = Math.max(CHAR_SIZE / 2, Math.min(ARENA_H - CHAR_SIZE / 2, bot.y));
        }

        // bot attacks on cooldown when in range
        if (nearDist <= ATTACK_RANGE && now - bot.lastAttackAt >= ATTACK_COOLDOWN) {
          const damage = dmg(bot, nearest);
          nearest.hp = Math.max(0, nearest.hp - damage);
          nearest.hitTimer = now;
          bot.lastAttackAt = now;
          bot.lungeDir = Math.atan2(nearest.y - bot.y, nearest.x - bot.x);
          nearest.floatingDmg.push({ value: damage, id: now + Math.random(), createdAt: now });
          if (nearest.hp <= 0) nearest.alive = false;
        }
      }

      // ── player auto-attacks: if selected character is in range, attack on cooldown ──
      for (let i = 0; i < updated.length; i++) {
        const pf = updated[i];
        if (pf.team !== 'player' || !pf.alive) continue;

        const enemies = updated.filter(f => f.team === 'bot' && f.alive);
        if (enemies.length === 0) continue;

        // find nearest enemy
        let nearest = enemies[0];
        let nearDist = dist(pf, nearest);
        for (const e of enemies) {
          const d = dist(pf, e);
          if (d < nearDist) { nearest = e; nearDist = d; }
        }

        const isSelected = (i === selIdx);
        let manualDidFire = false;

        if (isSelected && spacePressed) {
          if (nearDist <= ATTACK_RANGE && now - (pf.lastManualAttackAt || 0) >= MANUAL_ATTACK_COOLDOWN) {
            // MANUAL ATTACK
            const damage = Math.floor(dmg(pf, nearest) * MANUAL_ATTACK_MULTIPLIER);
            nearest.hp = Math.max(0, nearest.hp - damage);
            nearest.hitTimer = now;
            pf.lastManualAttackAt = now;
            pf.lungeDir = Math.atan2(nearest.y - pf.y, nearest.x - pf.x);
            nearest.floatingDmg.push({ value: damage, id: now + Math.random(), createdAt: now, isManual: true });
            if (nearest.hp <= 0) nearest.alive = false;
            manualDidFire = true;
          } else {
            // WHIFF
            pf.whiffTimer = now;
          }
        }

        // auto-attack on cooldown when in range
        if (!manualDidFire && nearDist <= ATTACK_RANGE && now - pf.lastAttackAt >= ATTACK_COOLDOWN) {
          const damage = dmg(pf, nearest);
          nearest.hp = Math.max(0, nearest.hp - damage);
          nearest.hitTimer = now;
          pf.lastAttackAt = now;
          pf.lungeDir = Math.atan2(nearest.y - pf.y, nearest.x - pf.x);
          nearest.floatingDmg.push({ value: damage, id: now + Math.random(), createdAt: now });
          if (nearest.hp <= 0) nearest.alive = false;
        }
      }

      // ── clean up old floating damage numbers ──
      for (const f of updated) {
        f.floatingDmg = f.floatingDmg.filter(d => now - d.createdAt < 1200);
      }

      // ── decay hit/lunge timers ──
      for (const f of updated) {
        if (f.hitTimer && now - f.hitTimer > 200) f.hitTimer = 0;
        if (f.lastAttackAt && now - f.lastAttackAt > 150) f.lungeDir = 0;
      }

      // ── check win condition ──
      const playersAlive = updated.filter(f => f.team === 'player' && f.alive).length;
      const botsAlive = updated.filter(f => f.team === 'bot' && f.alive).length;

      if (playersAlive === 0 || botsAlive === 0) {
        const w = botsAlive === 0 ? 'player' : 'bot';
        setWinner(w);

        // report to server
        socket.emit('battle:report_result', {
          won: w === 'player',
          trophies: trophies || 0,
        });
        const handler = (data) => {
          setServerConfirmed(true);
          setConfirmedData(data);
          if (data.tierEscalation) {
            setToast(`Alert: The bot is getting tougher — ${data.tierEscalation.newTier} opponents ahead!`);
          }
          socket.off('battle:result_confirmed', handler);
        };
        socket.on('battle:result_confirmed', handler);
      }

      setFighters(updated);
      fightersRef.current = updated;
    }, TICK_MS);

    loopRef.current = loop;
    return () => clearInterval(loop);
  }, [battleState, socket, trophies]);

  // Stop loop when winner is set
  useEffect(() => {
    if (winner && loopRef.current) {
      // give a moment for the last state to render, then transition
      setTimeout(() => {
        clearInterval(loopRef.current);
        loopRef.current = null;
        setBattleState(STATES.RESULT);
      }, 1500);
    }
  }, [winner]);

  // ══════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════════

  // ── IDLE ──
  if (battleState === STATES.IDLE) {
    return (
      <div className="battle-screen">
        <div className="battle-idle">
          <div className="battle-idle-icon">Battle</div>
          <h3>Battle Arena</h3>
          {hasDeck ? (
            <>
              <p>Command your characters in real-time combat!</p>
              <div className="battle-trophy-display">
                <span className="trophy-icon">Trophies:</span>
                <span className="trophy-count">{trophies || 0}</span>
                <span className="trophy-label">Trophies</span>
              </div>
              <div className="battle-bot-preview">
                <span className="bot-label">Opponent: {getBotTier(trophies || 0).name}</span>
              </div>
              <button className="battle-start-btn" onClick={startBattle}>
                Find Opponent
              </button>
            </>
          ) : (
            <>
              <p className="battle-disabled-msg">Build a deck first to enter battle.</p>
              <button className="battle-edit-btn" onClick={onEditDeck}>
                Go to Deck Builder
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── READY ──
  if (battleState === STATES.READY) {
    return (
      <div className="battle-screen">
        <div className="battle-matchup">
          <div className="matchup-header">
            <h3>Battle Ready</h3>
            <p>vs. {botTier?.name}</p>
          </div>
          <div className="matchup-arena">
            <div className="matchup-side player">
              <div className="side-label">You</div>
              <div className="matchup-cards">
                {playerDeck.map((card, i) => (
                  <GameCard key={i} card={card} state="owned" compact />
                ))}
              </div>
            </div>
            <div className="matchup-vs">VS</div>
            <div className="matchup-side bot">
              <div className="side-label">{botTier?.name}</div>
              <div className="matchup-cards">
                {botDeck.map((card, i) => (
                  <GameCard key={i} card={card} state="owned" compact />
                ))}
              </div>
            </div>
          </div>
          <button className="battle-go-btn" onClick={beginFight}>
            Start Battle!
          </button>
        </div>
      </div>
    );
  }

  // ── BATTLING ──
  if (battleState === STATES.BATTLING) {
    const now = Date.now();
    const playerAlive = fighters.filter(f => f.team === 'player' && f.alive);
    const botAlive = fighters.filter(f => f.team === 'bot' && f.alive);

    return (
      <div className="battle-screen battling" tabIndex={0} ref={arenaRef}>
        {/* HUD */}
        <div className="arena-hud">
          <div className="hud-side player-hud">
            <span className="hud-label">YOU</span>
            <span className="hud-count">{playerAlive.length} alive</span>
          </div>
          <div className="hud-side bot-hud">
            <span className="hud-count">{botAlive.length} alive</span>
            <span className="hud-label">{botTier?.name?.toUpperCase()}</span>
          </div>
        </div>

        {/* Arena */}
        <div className="arena" style={{ width: ARENA_W, height: ARENA_H }}>
          {/* Arena ground layers */}
          <div className="arena-floor" />
          <div className="arena-midline" />
          <div className="arena-frame" />

          {/* Fighters */}
          {fighters.map((f, idx) => {
            const isSelected = f.team === 'player' && idx === selectedIdx;
            const isHit = f.hitTimer && now - f.hitTimer < 200;
            const isAutoAttacking = f.lungeDir !== undefined && now - f.lastAttackAt < 150;
            const isManualAttacking = f.lungeDir !== undefined && now - (f.lastManualAttackAt || 0) < 150;
            const isAttacking = isAutoAttacking || isManualAttacking;
            
            const lungeDist = isManualAttacking ? 20 : (isAutoAttacking ? 8 : 0);
            const lungeX = isAttacking ? Math.cos(f.lungeDir) * lungeDist : 0;
            const lungeY = isAttacking ? Math.sin(f.lungeDir) * lungeDist : 0;
            
            const isWhiffing = now - (f.whiffTimer || 0) < 150;
            const hpPct = f.maxHp > 0 ? (f.hp / f.maxHp) * 100 : 0;
            const typeColor = f.card.type === 'OVERCLOCK' ? '#f97316'
              : f.card.type === 'COOLANT' ? '#06b6d4' : '#a855f7';

            // player number label (1-4)
            const playerNum = f.team === 'player'
              ? fighters.filter((ff, fi) => ff.team === 'player' && fi <= idx).length
              : null;

            return (
              <div
                key={f.id}
                className={[
                  'fighter',
                  f.team,
                  f.alive ? '' : 'dead',
                  isSelected ? 'selected' : '',
                  isHit ? 'hit' : '',
                  isWhiffing ? 'whiff' : ''
                ].join(' ')}
                style={{
                  left: f.x - CHAR_SIZE / 2 + lungeX,
                  top: f.y - CHAR_SIZE / 2 + lungeY,
                  width: CHAR_SIZE,
                  height: CHAR_SIZE,
                  '--type-color': typeColor,
                }}
                onClick={() => handleClickFighter(idx)}
              >
                {/* Selection ring */}
                {isSelected && f.alive && <div className="select-ring" />}

                {/* Character glyph */}
                <span className="fighter-glyph">{f.card.glyph || '?'}</span>

                {/* Player number */}
                {playerNum && f.alive && (
                  <span className="fighter-num">{playerNum}</span>
                )}

                {/* HP bar */}
                {f.alive && (
                  <div className="hp-bar-container">
                    <div
                      className="hp-bar-fill"
                      style={{
                        width: `${hpPct}%`,
                        background: hpPct > 50 ? '#22c55e' : hpPct > 25 ? '#f59e0b' : '#ef4444',
                      }}
                    />
                  </div>
                )}

                {/* Floating damage numbers */}
                {f.floatingDmg.map(d => {
                  const age = now - d.createdAt;
                  const opacity = Math.max(0, 1 - age / 1200);
                  const yOff = -20 - (age / 1200) * 30;
                  return (
                    <span
                      key={d.id}
                      className={`floating-dmg ${d.isManual ? 'manual' : ''}`}
                      style={{
                        opacity,
                        transform: `translateY(${yOff}px)`,
                      }}
                    >
                      -{d.value}{d.isManual ? '!' : ''}
                    </span>
                  );
                })}
              </div>
            );
          })}

          {/* Victory/Defeat overlay */}
          {winner && (
            <div className={`arena-overlay ${winner === 'player' ? 'victory' : 'defeat'}`}>
              <span className="overlay-text">
                {winner === 'player' ? 'VICTORY' : 'DEFEAT'}
              </span>
            </div>
          )}
        </div>

        {/* Control hint */}
        {showHint && (
          <div className="control-hint">
            <span>WASD to move</span>
            <span className="hint-sep">·</span>
            <span>Spacebar to attack</span>
            <span className="hint-sep">·</span>
            <span>1/2/3/4 switch character</span>
            <span className="hint-sep">·</span>
            <span>Click to select</span>
          </div>
        )}

        {/* Character selection bar */}
        <div className="char-select-bar">
          {fighters.filter(f => f.team === 'player').map((f, pIdx) => {
            const realIdx = fighters.indexOf(f);
            const isActive = realIdx === selectedIdx;
            const hpPct = f.maxHp > 0 ? (f.hp / f.maxHp) * 100 : 0;
            return (
              <button
                key={f.id}
                className={`char-select-btn ${isActive ? 'active' : ''} ${!f.alive ? 'dead' : ''}`}
                onClick={() => f.alive && setSelectedIdx(realIdx)}
              >
                <span className="csb-num">{pIdx + 1}</span>
                <span className="csb-glyph">{f.card.glyph}</span>
                <span className="csb-name">{f.card.name}</span>
                <div className="csb-hp">
                  <div className="csb-hp-fill" style={{
                    width: `${hpPct}%`,
                    background: hpPct > 50 ? '#22c55e' : hpPct > 25 ? '#f59e0b' : '#ef4444',
                  }} />
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ── RESULT ──
  if (battleState === STATES.RESULT && winner) {
    const won = winner === 'player';
    const delta = confirmedData?.delta;

    return (
      <div className="battle-screen">
        <div className={`battle-result ${won ? 'victory' : 'defeat'}`}>
          <div className="result-banner">
            <span className="result-icon">{won ? 'WIN' : 'LOSS'}</span>
            <h2>{won ? 'Victory!' : 'Defeat'}</h2>
          </div>

          <div className="trophy-change">
            <span className="trophy-icon-large">Trophies:</span>
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

          {toast && <div className="battle-toast">{toast}</div>}

          <div className="result-actions">
            <button className="battle-again-btn" onClick={startBattle}>
              Battle Again
            </button>
            <button className="result-nav-btn" onClick={onEditDeck}>
              Edit Deck
            </button>
            <button className="result-nav-btn" onClick={onVisitShop}>
              Visit Shop
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
