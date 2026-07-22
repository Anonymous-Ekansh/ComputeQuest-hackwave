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
  const [roundHistory, setRoundHistory] = useState([]); // post-battle breakdown
  const keysRef = useRef(new Set());
  const fightersRef = useRef([]);
  const powerupsRef = useRef([]);
  const lastPowerupTimeRef = useRef(0);
  const selectedIdxRef = useRef(0);
  const loopRef = useRef(null);
  const arenaRef = useRef(null);
  const winnerRef = useRef(null);
  const roundHistoryRef = useRef([]);

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
    setRoundHistory([]);
    roundHistoryRef.current = [];
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

      // Spawn Powerups (5 types)
      let currentPowerups = [...powerupsRef.current];
      if (now - lastPowerupTimeRef.current >= POWERUP_SPAWN_RATE) {
        lastPowerupTimeRef.current = now;
        const POWERUP_TYPES = ['health', 'attack_boost', 'speed_boost', 'shield', 'type_switch'];
        currentPowerups.push({
          id: now,
          x: 50 + Math.random() * (ARENA_W - 100),
          y: 50 + Math.random() * (ARENA_H - 100),
          type: POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)]
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

        // Powerup collision (player)
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
            } else if (p.type === 'speed_boost') {
              sel.speedBoostUntil = now + 4000;
              sel.floatingDmg.push({ value: 'SPD+', id: now + Math.random(), createdAt: now, isUltimate: true });
            } else if (p.type === 'shield') {
              sel.shieldUntil = now + 3000;
              sel.floatingDmg.push({ value: 'SHIELD!', id: now + Math.random(), createdAt: now, isUltimate: true });
            } else if (p.type === 'type_switch') {
              const types = ['OVERCLOCK', 'COOLANT', 'FIRMWARE'];
              sel.card = { ...sel.card, type: types[Math.floor(Math.random() * types.length)] };
              sel.floatingDmg.push({ value: '⚗ TYPE!', id: now + Math.random(), createdAt: now, isUltimate: true });
            }
            currentPowerups.splice(i, 1);
          }
        }
      }

      for (const bot of updated) {
        if (bot.team !== 'bot' || !bot.alive || now < bot.frozenUntil) continue;
        const targets = updated.filter(f => f.team === 'player' && f.alive);
        if (targets.length === 0) continue;

        // Type-aware targeting: prefer targets the bot has type advantage over
        const advantageTargets = targets.filter(t => hasAdvantage(bot.card.type, t.card.type));
        const preferredTargets = advantageTargets.length > 0 ? advantageTargets : targets;

        let nearest = preferredTargets[0];
        let nearDist = dist(bot, nearest);
        let targetIsPowerup = false;
        
        for (const t of preferredTargets) {
          const d = dist(bot, t);
          if (d < nearDist) { nearest = t; nearDist = d; targetIsPowerup = false; }
        }
        
        for (const p of currentPowerups) {
          const d = dist(bot, p);
          if (d < nearDist && d < 200) { nearest = p; nearDist = d; targetIsPowerup = true; }
        }

        if (nearDist > (targetIsPowerup ? 10 : ATTACK_RANGE * 0.8)) {
          const angle = Math.atan2(nearest.y - bot.y, nearest.x - bot.x);
          bot.x += Math.cos(angle) * MOVE_SPEED;
          bot.y += Math.sin(angle) * MOVE_SPEED;
          bot.x = Math.max(CHAR_SIZE / 2, Math.min(ARENA_W - CHAR_SIZE / 2, bot.x));
          bot.y = Math.max(CHAR_SIZE / 2, Math.min(ARENA_H - CHAR_SIZE / 2, bot.y));
        }

        if (now - (bot.lastUltimateAt || 0) >= ULTIMATE_COOLDOWN && Math.random() < 0.05) {
           const type = bot.card.type;
           let used = false;
           
           if (type === 'OVERCLOCK' && nearDist > ATTACK_RANGE && !targetIsPowerup) {
             const blinkDist = 120;
             const angle = Math.atan2(nearest.y - bot.y, nearest.x - bot.x);
             bot.x = Math.max(CHAR_SIZE / 2, Math.min(ARENA_W - CHAR_SIZE / 2, bot.x + Math.cos(angle)*blinkDist));
             bot.y = Math.max(CHAR_SIZE / 2, Math.min(ARENA_H - CHAR_SIZE / 2, bot.y + Math.sin(angle)*blinkDist));
             used = true;
           } else if (type === 'COOLANT' && nearDist <= 120 && !targetIsPowerup) {
             updated.forEach(f => {
               if (f.team === 'player' && dist(bot, f) <= 120) {
                 f.frozenUntil = now + 3000;
               }
             });
             used = true;
           } else if (type === 'FIRMWARE' && bot.hp < bot.maxHp * 0.5) {
             bot.hp = Math.min(bot.maxHp, bot.hp + (bot.maxHp * 0.3));
             used = true;
           }
           
           if (used) {
             bot.lastUltimateAt = now;
             const ultText = type === 'OVERCLOCK' ? 'BLINK!' : type === 'COOLANT' ? 'FREEZE!' : 'HEAL!';
             bot.floatingDmg.push({ value: ultText, id: now + Math.random(), createdAt: now, isUltimate: true });
           }
        }

        let j = currentPowerups.length;
        while (j--) {
          const p = currentPowerups[j];
          if (dist(bot, p) < CHAR_SIZE) {
            if (p.type === 'health') {
              bot.hp = Math.min(bot.maxHp, bot.hp + (bot.maxHp * 0.2));
              bot.floatingDmg.push({ value: '+HP', id: now + Math.random(), createdAt: now, isUltimate: true });
            } else if (p.type === 'attack_boost') {
              bot.boostUntil = now + 5000;
              bot.floatingDmg.push({ value: 'ATK+', id: now + Math.random(), createdAt: now, isUltimate: true });
            } else if (p.type === 'speed_boost') {
              bot.speedBoostUntil = now + 4000;
              bot.floatingDmg.push({ value: 'SPD+', id: now + Math.random(), createdAt: now, isUltimate: true });
            } else if (p.type === 'shield') {
              bot.shieldUntil = now + 3000;
              bot.floatingDmg.push({ value: 'SHIELD!', id: now + Math.random(), createdAt: now, isUltimate: true });
            }
            currentPowerups.splice(j, 1);
          }
        }

        if (!targetIsPowerup && nearDist <= ATTACK_RANGE && now - bot.lastAttackAt >= ATTACK_COOLDOWN) {
          // Shield absorbs one attack
          if (now < (nearest.shieldUntil || 0)) {
            nearest.shieldUntil = 0;
            nearest.floatingDmg.push({ value: 'BLOCKED!', id: now + Math.random(), createdAt: now, isUltimate: true });
            bot.lastAttackAt = now;
          } else {
            let damage = dmg(bot, nearest);
            if (now < (bot.boostUntil || 0)) damage = Math.floor(damage * 1.5);
            const isAdv = hasAdvantage(bot.card.type, nearest.card.type);
            nearest.hp = Math.max(0, nearest.hp - damage);
            nearest.hitTimer = now;
            bot.lastAttackAt = now;
            bot.lungeDir = Math.atan2(nearest.y - bot.y, nearest.x - bot.x);
            nearest.floatingDmg.push({ value: damage, id: now + Math.random(), createdAt: now, isCrit: isAdv });
            if (nearest.hp <= 0) nearest.alive = false;
          }
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
        // Apply speed boost to movement (already applied above via MOVE_SPEED — boost handled at move time)

        if (isSelected && spacePressed) {
          if (nearDist <= ATTACK_RANGE && now - (pf.lastManualAttackAt || 0) >= MANUAL_ATTACK_COOLDOWN) {
            // Shield absorbs one attack
            if (now < (nearest.shieldUntil || 0)) {
              nearest.shieldUntil = 0;
              nearest.floatingDmg.push({ value: 'BLOCKED!', id: now + Math.random(), createdAt: now, isUltimate: true });
              pf.lastManualAttackAt = now;
            } else {
              let damage = Math.floor(dmg(pf, nearest) * MANUAL_ATTACK_MULTIPLIER);
              if (now < pf.boostUntil) damage = Math.floor(damage * 1.5);
              const isAdv = hasAdvantage(pf.card.type, nearest.card.type);
              nearest.hp = Math.max(0, nearest.hp - damage);
              nearest.hitTimer = now;
              pf.lastManualAttackAt = now;
              pf.lungeDir = Math.atan2(nearest.y - pf.y, nearest.x - pf.x);
              nearest.floatingDmg.push({ value: damage, id: now + Math.random(), createdAt: now, isManual: true, isCrit: isAdv });
              if (nearest.hp <= 0) nearest.alive = false;
            }
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

        // Build round breakdown from final fighter states
        const playerFighters = updated.filter(f => f.team === 'player');
        const botFighters = updated.filter(f => f.team === 'bot');
        const history = playerFighters.map((pf, i) => {
          const bf = botFighters[i] || botFighters[0];
          const playerHpPct = Math.round((pf.hp / pf.maxHp) * 100);
          const botHpPct = bf ? Math.round((bf.hp / bf.maxHp) * 100) : 0;
          return {
            round: i + 1,
            playerCard: pf.card.name,
            playerType: pf.card.type,
            playerHpPct,
            botCard: bf ? bf.card.name : '—',
            botType: bf ? bf.card.type : '—',
            botHpPct,
            survived: pf.alive,
          };
        });
        roundHistoryRef.current = history;
        setRoundHistory(history);

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
              <div className="premium-instructions">
                <h4>Controls & Mechanics</h4>
                
                <div className="instructions-grid">
                  <div className="instruction-item">
                    <span className="instruction-label">Movement</span>
                    <span className="instruction-desc">Use <span className="instruction-highlight">W A S D</span> to navigate the arena</span>
                  </div>
                  <div className="instruction-item">
                    <span className="instruction-label">Attack</span>
                    <span className="instruction-desc">Press <span className="instruction-highlight">Spacebar</span> for a 1.4x DMG manual strike</span>
                  </div>
                  <div className="instruction-item">
                    <span className="instruction-label">Swap Character</span>
                    <span className="instruction-desc">Press <span className="instruction-highlight">1 2 3 4</span> to change your active card</span>
                  </div>
                  <div className="instruction-item">
                    <span className="instruction-label">Ultimate Ability</span>
                    <span className="instruction-desc">Press <span className="instruction-highlight">Shift</span> (10s cooldown)</span>
                  </div>
                </div>

                <ul className="mechanics-list">
                  <li className="mech-type">
                    <span className="mech-title">Type Advantage (1.5x DMG)</span>
                    Exploit weaknesses for CRIT damage! (Overclock &gt; Coolant &gt; Firmware &gt; Overclock)
                  </li>
                  <li className="mech-ult">
                    <span className="mech-title">Unique Ultimates</span>
                    <strong>Overclock:</strong> Blinks forward. <strong>Coolant:</strong> Freezes enemies. <strong>Firmware:</strong> Instantly heals.
                  </li>
                  <li className="mech-pow">
                    <span className="mech-title">Arena Power-ups</span>
                    Run over drops to collect them. <strong>♥ Health</strong> restores HP, <strong>⚡ Energy</strong> boosts attack 1.5x, <strong>💨 Speed</strong> boosts movement, <strong>🛡 Shield</strong> blocks the next hit, <strong>⚗ Type</strong> randomly changes your card's type!
                  </li>
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
              {p.type === 'health' ? '♥' : p.type === 'attack_boost' ? '⚡' : p.type === 'speed_boost' ? '💨' : p.type === 'shield' ? '🛡' : '⚗'}
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

          {/* Round-by-round breakdown */}
          {roundHistory.length > 0 && (
            <div style={{ margin: '16px 0', padding: '12px 16px', background: 'rgba(255,255,255,0.04)', borderRadius: '12px', border: '1px solid #334155' }}>
              <p style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#64748b', marginBottom: '10px' }}>Card Breakdown</p>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', color: '#cbd5e1' }}>
                <thead>
                  <tr style={{ color: '#475569', borderBottom: '1px solid #1e293b' }}>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>#</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Your Card</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>HP Left</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px', paddingLeft: '16px' }}>Bot Card</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>HP Left</th>
                    <th style={{ textAlign: 'center', padding: '4px 6px' }}>Survived</th>
                  </tr>
                </thead>
                <tbody>
                  {roundHistory.map(r => (
                    <tr key={r.round} style={{ borderBottom: '1px solid #1e293b' }}>
                      <td style={{ padding: '5px 6px', color: '#475569' }}>{r.round}</td>
                      <td style={{ padding: '5px 6px' }}>
                        <span style={{ color: r.playerType === 'OVERCLOCK' ? '#f97316' : r.playerType === 'COOLANT' ? '#06b6d4' : '#a855f7' }}>●</span> {r.playerCard}
                      </td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', color: r.playerHpPct > 50 ? '#22c55e' : r.playerHpPct > 20 ? '#f59e0b' : '#ef4444' }}>{r.playerHpPct}%</td>
                      <td style={{ padding: '5px 6px', paddingLeft: '16px' }}>
                        <span style={{ color: r.botType === 'OVERCLOCK' ? '#f97316' : r.botType === 'COOLANT' ? '#06b6d4' : '#a855f7' }}>●</span> {r.botCard}
                      </td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', color: r.botHpPct > 50 ? '#22c55e' : r.botHpPct > 20 ? '#f59e0b' : '#ef4444' }}>{r.botHpPct}%</td>
                      <td style={{ textAlign: 'center', padding: '5px 6px' }}>{r.survived ? '✓' : '✗'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

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