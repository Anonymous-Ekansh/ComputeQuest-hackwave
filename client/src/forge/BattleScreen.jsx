import { useState, useEffect, useRef, useCallback } from 'react';
import { CARD_MAP, getBotTier, hasAdvantage } from './cardData';
import GameCard from './GameCard';
import './BattleScreen.css';

// ── Arena constants ──────────────────────────────────────────────────────────
const ARENA_W = 700;
const ARENA_H = 400;
const CHAR_SIZE = 48;
const MOVE_SPEED = 2;          
const ATTACK_RANGE = 80;         
const ATTACK_COOLDOWN = 1200;     
const MANUAL_ATTACK_MULTIPLIER = 1.4;
const MANUAL_ATTACK_COOLDOWN = 500; 
const ULTIMATE_COOLDOWN = 10000;
const POWERUP_SPAWN_RATE = 7000;
const TICK_MS = 16;              
const HINT_DURATION = 4000;      
const HP_SCALE = 8;              

const STATES = { IDLE: 'idle', READY: 'ready', BATTLING: 'battling', RESULT: 'result' };

function dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function dmg(attacker, defender) {
  let power = attacker.card.attack;
  if (hasAdvantage(attacker.card.type, defender.card.type)) {
    power = Math.floor(power * 1.5);
  }
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
    hitTimer: 0,    
    lungeDir: 0,    
    floatingDmg: [],
    lastUltimateAt: 0,
    frozenUntil: 0,
    boostUntil: 0,
  };
}

export default function BattleScreen({
  socket,
  savedDeck,
  trophies,
  ownedCards,
  localUpgrades = {}, // Now receives upgrades
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
  const [winner, setWinner] = useState(null);           
  const [serverConfirmed, setServerConfirmed] = useState(false);
  const [confirmedData, setConfirmedData] = useState(null);
  const [toast, setToast] = useState(null);

  const [powerups, setPowerups] = useState([]);
  const keysRef = useRef(new Set());
  const fightersRef = useRef([]);
  const powerupsRef = useRef([]);
  const lastPowerupTimeRef = useRef(0);
  const selectedIdxRef = useRef(0);
  const loopRef = useRef(null);
  const arenaRef = useRef(null);
  const winnerRef = useRef(null);

  const hasDeck = savedDeck && savedDeck.length === 4;

  useEffect(() => { fightersRef.current = fighters; }, [fighters]);
  useEffect(() => { powerupsRef.current = powerups; }, [powerups]);
  useEffect(() => { selectedIdxRef.current = selectedIdx; }, [selectedIdx]);
  useEffect(() => { winnerRef.current = winner; }, [winner]);

  useEffect(() => {
    if (battleState !== STATES.BATTLING) return;

    function handleKeyDown(e) {
      const k = e.key.toLowerCase();
      keysRef.current.add(k);
      if (k === 'shift' && !e.repeat) {
        keysRef.current.shiftJustPressed = true;
        e.preventDefault();
      }
      if (k === ' ' && !e.repeat) {
        keysRef.current.spacebarJustPressed = true;
        e.preventDefault();
      }

      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        e.preventDefault();
      }

      if (k >= '1' && k <= '4') {
        const idx = parseInt(k) - 1;
        const allPlayerFighters = fightersRef.current.filter(f => f.team === 'player');
        if (idx < allPlayerFighters.length && allPlayerFighters[idx].alive) {
          const realIdx = fightersRef.current.indexOf(allPlayerFighters[idx]);
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

  const handleClickFighter = useCallback((idx) => {
    if (fightersRef.current[idx]?.team === 'player' && fightersRef.current[idx]?.alive) {
      setSelectedIdx(idx);
    }
  }, []);

  const startBattle = useCallback(() => {
    if (!hasDeck) return;
    
    // Build the player deck WITH the new upgrades applied
    const pDeck = savedDeck.map(id => {
      const baseCard = CARD_MAP[id];
      if (!baseCard) return null;
      
      const upg = localUpgrades[id] || { attack: 0, defense: 0 };
      return {
        ...baseCard,
        attack: baseCard.attack + upg.attack,
        defense: baseCard.defense + upg.defense
      };
    }).filter(Boolean);
    
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
  }, [hasDeck, savedDeck, trophies, localUpgrades]);

  const beginFight = useCallback(() => {
    const allFighters = [
      ...playerDeck.map((c, i) => buildFighter(c, 'player', i, playerDeck.length)),
      ...botDeck.map((c, i) => buildFighter(c, 'bot', i, botDeck.length)),
    ];
    setFighters(allFighters);
    fightersRef.current = allFighters;
    setSelectedIdx(0);
    selectedIdxRef.current = 0;
    setPowerups([]);
    powerupsRef.current = [];
    lastPowerupTimeRef.current = Date.now();
    setShowHint(true);
    setBattleState(STATES.BATTLING);

    setTimeout(() => setShowHint(false), HINT_DURATION);
  }, [playerDeck, botDeck]);

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
      const shiftPressed = keys.shiftJustPressed;
      keys.shiftJustPressed = false;

      // Spawn Powerups
      let currentPowerups = [...powerupsRef.current];
      if (now - lastPowerupTimeRef.current >= POWERUP_SPAWN_RATE) {
        lastPowerupTimeRef.current = now;
        currentPowerups.push({
          id: now,
          x: 50 + Math.random() * (ARENA_W - 100),
          y: 50 + Math.random() * (ARENA_H - 100),
          type: Math.random() > 0.5 ? 'health' : 'attack_boost'
        });
      }

      const sel = updated[selIdx];
      if (sel && sel.team === 'player' && sel.alive) {
        let dx = 0, dy = 0;
        if (keys.has('w') || keys.has('arrowup'))    dy = -MOVE_SPEED;
        if (keys.has('s') || keys.has('arrowdown'))  dy = MOVE_SPEED;
        if (keys.has('a') || keys.has('arrowleft'))  dx = -MOVE_SPEED;
        if (keys.has('d') || keys.has('arrowright')) dx = MOVE_SPEED;
        if (dx && dy) { dx *= 0.707; dy *= 0.707; }
        sel.x = Math.max(CHAR_SIZE / 2, Math.min(ARENA_W - CHAR_SIZE / 2, sel.x + dx));
        sel.y = Math.max(CHAR_SIZE / 2, Math.min(ARENA_H - CHAR_SIZE / 2, sel.y + dy));

        // Ultimate Ability
        if (shiftPressed && now - (sel.lastUltimateAt || 0) >= ULTIMATE_COOLDOWN) {
           sel.lastUltimateAt = now;
           const type = sel.card.type;
           if (type === 'OVERCLOCK') {
             // Blink forward
             const blinkDist = 120;
             const dirX = dx === 0 && dy === 0 ? 1 : dx; // default right if idle
             const dirY = dx === 0 && dy === 0 ? 0 : dy;
             const mag = Math.sqrt(dirX*dirX + dirY*dirY);
             sel.x = Math.max(CHAR_SIZE / 2, Math.min(ARENA_W - CHAR_SIZE / 2, sel.x + (dirX/mag)*blinkDist));
             sel.y = Math.max(CHAR_SIZE / 2, Math.min(ARENA_H - CHAR_SIZE / 2, sel.y + (dirY/mag)*blinkDist));
             sel.floatingDmg.push({ value: 'BLINK!', id: now + Math.random(), createdAt: now, isUltimate: true });
           } else if (type === 'COOLANT') {
             // Freeze bots
             updated.forEach(f => {
               if (f.team === 'bot' && dist(sel, f) <= 120) {
                 f.frozenUntil = now + 3000;
               }
             });
             sel.floatingDmg.push({ value: 'FREEZE!', id: now + Math.random(), createdAt: now, isUltimate: true });
           } else if (type === 'FIRMWARE') {
             // Heal
             sel.hp = Math.min(sel.maxHp, sel.hp + (sel.maxHp * 0.3));
             sel.floatingDmg.push({ value: 'HEAL!', id: now + Math.random(), createdAt: now, isUltimate: true });
           }
        }

        // Powerup collision
        let i = currentPowerups.length;
        while (i--) {
          const p = currentPowerups[i];
          if (dist(sel, p) < CHAR_SIZE) {
            if (p.type === 'health') {
              sel.hp = Math.min(sel.maxHp, sel.hp + (sel.maxHp * 0.2));
              sel.floatingDmg.push({ value: '+HP', id: now + Math.random(), createdAt: now, isUltimate: true });
            } else if (p.type === 'attack_boost') {
              sel.boostUntil = now + 5000;
              sel.floatingDmg.push({ value: 'ATK+', id: now + Math.random(), createdAt: now, isUltimate: true });
            }
            currentPowerups.splice(i, 1);
          }
        }
      }

      for (const bot of updated) {
        if (bot.team !== 'bot' || !bot.alive || now < bot.frozenUntil) continue;
        const targets = updated.filter(f => f.team === 'player' && f.alive);
        if (targets.length === 0) continue;

        let nearest = targets[0];
        let nearDist = dist(bot, nearest);
        for (const t of targets) {
          const d = dist(bot, t);
          if (d < nearDist) { nearest = t; nearDist = d; }
        }

        if (nearDist > ATTACK_RANGE * 0.8) {
          const angle = Math.atan2(nearest.y - bot.y, nearest.x - bot.x);
          bot.x += Math.cos(angle) * MOVE_SPEED;
          bot.y += Math.sin(angle) * MOVE_SPEED;
          bot.x = Math.max(CHAR_SIZE / 2, Math.min(ARENA_W - CHAR_SIZE / 2, bot.x));
          bot.y = Math.max(CHAR_SIZE / 2, Math.min(ARENA_H - CHAR_SIZE / 2, bot.y));
        }

        if (nearDist <= ATTACK_RANGE && now - bot.lastAttackAt >= ATTACK_COOLDOWN) {
          const damage = dmg(bot, nearest);
          const isAdv = hasAdvantage(bot.card.type, nearest.card.type);
          nearest.hp = Math.max(0, nearest.hp - damage);
          nearest.hitTimer = now;
          bot.lastAttackAt = now;
          bot.lungeDir = Math.atan2(nearest.y - bot.y, nearest.x - bot.x);
          nearest.floatingDmg.push({ value: damage, id: now + Math.random(), createdAt: now, isCrit: isAdv });
          if (nearest.hp <= 0) nearest.alive = false;
        }
      }

      for (let i = 0; i < updated.length; i++) {
        const pf = updated[i];
        if (pf.team !== 'player' || !pf.alive) continue;

        const enemies = updated.filter(f => f.team === 'bot' && f.alive);
        if (enemies.length === 0) continue;

        let nearest = enemies[0];
        let nearDist = dist(pf, nearest);
        for (const e of enemies) {
          const d = dist(pf, e);
          if (d < nearDist) { nearest = e; nearDist = d; }
        }

        const isSelected = (i === selIdx);

        if (isSelected && spacePressed) {
          if (nearDist <= ATTACK_RANGE && now - (pf.lastManualAttackAt || 0) >= MANUAL_ATTACK_COOLDOWN) {
            let damage = Math.floor(dmg(pf, nearest) * MANUAL_ATTACK_MULTIPLIER);
            if (now < pf.boostUntil) damage = Math.floor(damage * 1.5);
            const isAdv = hasAdvantage(pf.card.type, nearest.card.type);
            
            nearest.hp = Math.max(0, nearest.hp - damage);
            nearest.hitTimer = now;
            pf.lastManualAttackAt = now;
            pf.lungeDir = Math.atan2(nearest.y - pf.y, nearest.x - pf.x);
            nearest.floatingDmg.push({ value: damage, id: now + Math.random(), createdAt: now, isManual: true, isCrit: isAdv });
            if (nearest.hp <= 0) nearest.alive = false;
          } else {
            pf.whiffTimer = now;
          }
        }
      }

      for (const f of updated) {
        f.floatingDmg = f.floatingDmg.filter(d => now - d.createdAt < 1200);
      }

      for (const f of updated) {
        if (f.hitTimer && now - f.hitTimer > 200) f.hitTimer = 0;
        if (f.lastAttackAt && now - f.lastAttackAt > 150) f.lungeDir = 0;
      }

      const playersAlive = updated.filter(f => f.team === 'player' && f.alive).length;
      const botsAlive = updated.filter(f => f.team === 'bot' && f.alive).length;

      if (playersAlive === 0 || botsAlive === 0) {
        const w = botsAlive === 0 ? 'player' : 'bot';
        setWinner(w);

        socket.emit('battle:report_result', {
          won: w === 'player',
          trophies: trophies || 0,
        });
        const handler = (data) => {
          clearTimeout(timeoutId);
          setServerConfirmed(true);
          setConfirmedData(data);
          if (data.tierEscalation) {
            setToast(`Alert: The bot is getting tougher — ${data.tierEscalation.newTier} opponents ahead!`);
          }
          socket.off('battle:result_confirmed', handler);
        };
        
        const timeoutId = setTimeout(() => {
          setServerConfirmed(true);
          setConfirmedData({ success: false, reason: 'Network timeout. Check connection.' });
          socket.off('battle:result_confirmed', handler);
        }, 8000);

        socket.on('battle:result_confirmed', handler);
      }

      setPowerups(currentPowerups);
      powerupsRef.current = currentPowerups;
      setFighters(updated);
      fightersRef.current = updated;
    }, TICK_MS);

    loopRef.current = loop;
    return () => clearInterval(loop);
  }, [battleState, socket, trophies]);

  useEffect(() => {
    if (winner && loopRef.current) {
      setTimeout(() => {
        clearInterval(loopRef.current);
        loopRef.current = null;
        setBattleState(STATES.RESULT);
      }, 1500);
    }
  }, [winner]);

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
              <div className="battle-instructions" style={{ marginTop: '20px', fontSize: '0.9em', color: '#888', maxWidth: '400px', margin: '20px auto 0' }}>
                <h4>Controls & Mechanics</h4>
                <p><strong>WASD:</strong> Move &nbsp; | &nbsp; <strong>Spacebar:</strong> Manual Attack (1.4x DMG)</p>
                <p><strong>1 2 3 4:</strong> Switch Character</p>
                <p><strong>Shift:</strong> Ultimate Ability (10s Cooldown)</p>
                <ul style={{ textAlign: 'left', marginTop: '10px', fontSize: '0.85em', background: 'rgba(0,0,0,0.2)', padding: '10px 20px', borderRadius: '4px' }}>
                  <li><span style={{color: '#ffaa00'}}>Type Advantage:</span> Attacking a weaker type deals 1.5x DMG! (Overclock &gt; Coolant &gt; Firmware &gt; Overclock)</li>
                  <li><span style={{color: '#00f0ff'}}>Ultimates:</span> Overclock Blinks, Coolant Freezes, Firmware Heals.</li>
                  <li><span style={{color: '#22c55e'}}>Power-ups:</span> Collect drops on the floor to heal or boost your attack!</li>
                </ul>
              </div>
              <div className="battle-advantage-diagram">
                <h4>Element Advantage (+50% DMG)</h4>
                <div className="advantage-circle">
                  <svg width="160" height="160" className="advantage-arrows" style={{position: 'absolute', top: 0, left: 0}}>
                    <defs>
                      <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                        <polygon points="0 0, 10 3.5, 0 7" fill="#666" />
                      </marker>
                    </defs>
                    {/* OC to Coolant */}
                    <line x1="100" y1="50" x2="130" y2="100" stroke="#666" strokeWidth="2" markerEnd="url(#arrowhead)" />
                    {/* Coolant to Firmware */}
                    <line x1="110" y1="135" x2="50" y2="135" stroke="#666" strokeWidth="2" markerEnd="url(#arrowhead)" />
                    {/* Firmware to OC */}
                    <line x1="30" y1="100" x2="60" y2="50" stroke="#666" strokeWidth="2" markerEnd="url(#arrowhead)" />
                  </svg>
                  <div className="adv-node overclock">
                    <span className="glyph">⚡</span>
                    <span>Overclock</span>
                  </div>
                  <div className="adv-node coolant">
                    <span className="glyph">❄</span>
                    <span>Coolant</span>
                  </div>
                  <div className="adv-node firmware">
                    <span className="glyph">⚙</span>
                    <span>Firmware</span>
                  </div>
                </div>
              </div>
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

  if (battleState === STATES.BATTLING) {
    const now = Date.now();
    const playerAlive = fighters.filter(f => f.team === 'player' && f.alive);
    const botAlive = fighters.filter(f => f.team === 'bot' && f.alive);

    return (
      <div className="battle-screen battling" tabIndex={0} ref={arenaRef}>
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

        <div className="arena" style={{ width: ARENA_W, height: ARENA_H }}>
          <div className="arena-floor" />
          <div className="arena-midline" />
          <div className="arena-frame" />

          {powerups.map(p => (
            <div key={p.id} className={`powerup ${p.type}`} style={{ left: p.x - 10, top: p.y - 10, width: 20, height: 20 }}>
              {p.type === 'health' ? '♥' : '⚡'}
            </div>
          ))}

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
                  isWhiffing ? 'whiff' : '',
                  now < (f.frozenUntil || 0) ? 'frozen' : ''
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
                {isSelected && f.alive && <div className="select-ring" />}
                <span className="fighter-glyph">{f.card.glyph || '?'}</span>
                {playerNum && f.alive && <span className="fighter-num">{playerNum}</span>}

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

                {f.floatingDmg.map(d => {
                  const age = now - d.createdAt;
                  const opacity = Math.max(0, 1 - age / 1200);
                  const yOff = -20 - (age / 1200) * 30;
                  return (
                    <span
                      key={d.id}
                      className={`floating-dmg ${d.isManual ? 'manual' : ''} ${d.isCrit ? 'crit' : ''} ${d.isUltimate ? 'ultimate' : ''}`}
                      style={{ opacity, transform: `translateY(${yOff}px)` }}
                    >
                      {typeof d.value === 'number' ? `-${d.value}` : d.value}{d.isCrit && typeof d.value === 'number' ? ' CRIT!' : ''}{d.isManual && !d.isCrit && typeof d.value === 'number' ? '!' : ''}
                    </span>
                  );
                })}
              </div>
            );
          })}

          {winner && (
            <div className={`arena-overlay ${winner === 'player' ? 'victory' : 'defeat'}`}>
              <span className="overlay-text">
                {winner === 'player' ? 'VICTORY' : 'DEFEAT'}
              </span>
            </div>
          )}
        </div>

        {showHint && (
          <div className="control-hint">
            <span>WASD to move</span>
            <span className="hint-sep">·</span>
            <span>Spacebar to attack</span>
            <span className="hint-sep">·</span>
            <span>Shift for Ultimate</span>
            <span className="hint-sep">·</span>
            <span>1-4 switch</span>
          </div>
        )}

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
            {serverConfirmed ? (
              confirmedData?.success ? (
                <div className="trophy-delta">
                  <span className={`delta-number ${delta > 0 ? 'positive' : 'negative'}`}>
                    {delta > 0 ? `+${delta}` : delta}
                  </span>
                  <span className="new-trophy-count">{confirmedData.trophies} trophies</span>
                </div>
              ) : (
                <div className="trophy-error">
                  <span className="error-text">Result failed: {confirmedData?.reason}</span>
                </div>
              )
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