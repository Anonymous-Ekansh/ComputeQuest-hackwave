# ComputeQuest 

> Donate your browser's computing power. Earn crystals. Forge your deck. Dominate the bots.

ComputeQuest is a distributed computing platform disguised as a deck-building card game. Users contribute idle CPU cycles from their browser to a shared compute pool — powering real research tasks and ML inference. In return, they earn in-game credits that can be converted into Crystals to buy cards, build a deck, and battle in The Forge.

No downloads. No sign-up friction. Just open a tab and start contributing.

---

## How it works

```
Your browser tab → Web Worker runs compute tasks silently in background
      ↓
WebSocket sends results and streamed text to coordinator server
      ↓
Server routes new tasks to idle nodes, aggregates results, awards credits
      ↓
Credits are converted to Crystals to buy cards and build your deck
```

Each connected browser is a **compute node**. The server distributes heavy tasks (like virtual drug screening) across all online nodes in chunks, and routes full LLM inference prompts to idle, warm nodes (Request-Parallel architecture). The more you contribute, the more credits you earn — allowing you to buy rarer cards and defeat harder bot tiers.

---

## Features

- **Distributed compute engine** — nodes receive batches of candidate drug molecules (SMILES strings), score each one for binding likelihood against a fixed real protein target using RDKit.js descriptors, and results are aggregated into a live-ranked leaderboard of top candidates.
- **Browser-based LLM Inference** — uses WebLLM to run AI models entirely in the browser. The server routes user prompts to idle nodes, which stream the generated text back in real-time.
- **Web Worker isolation** — all computation runs in a background thread; your UI stays completely responsive
- **Real-time node dashboard** — see how many nodes are live, tasks/sec throughput, and your personal contribution stats
- **Credit system** — every completed compute chunk earns credits stored server-side with a full audit trail
- **Card Battler Game (The Forge)** — use your compute credits to buy Crystals, purchase cards from the shop, build a 4-card deck, and battle AI bots in an auto-battler with type-advantage mechanics.
- **Leaderboard** — ranked by total compute contributed (GFlops donated), not just time spent

---

## Tech stack

| Layer | Technology |
|---|---|
| Server | Node.js, Express, Socket.io |
| Client | React, Vite |
| Compute | Web Workers API, WebLLM, WebGPU, SharedArrayBuffer |
| Database | PostgreSQL (SQLite for local dev) |
| Auth | JWT (HTTP-only cookies) |
| Deployment | Railway / Render |

---

## Project structure

```
computequest/
├── server/
│   ├── src/
│   │   ├── index.js              # Express + Socket.io entry point
│   │   ├── taskQueue.js          # Job queue: split, assign, collect chunks
│   │   ├── socketHandler.js      # WebSocket events: routing tasks, streaming inference
│   │   ├── creditEngine.js       # Award and verify credits per completed chunk
│   │   └── routes/
│   │       ├── auth.js           # Register, login, JWT issue
│   │       ├── tasks.js          # Submit tasks, query results
│   │       └── leaderboard.js    # Top contributors endpoint
│   └── package.json
│
├── client/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── WorkerManager.js      # Manages Web Worker lifecycle
│   │   ├── workers/
│   │   │   └── computeWorker.js  # Web Worker: computes chunks, runs WebLLM generation
│   │   ├── forge/                # The Forge card game components
│   │   │   ├── TheForge.jsx      # Main game hub
│   │   │   ├── CardShop.jsx      # Buy cards with Crystals
│   │   │   ├── DeckBuilder.jsx   # Assemble your 4-card deck
│   │   │   ├── BattleScreen.jsx  # Auto-battler UI
│   │   │   └── cardData.js       # Card catalog and battle logic
│   │   └── components/
│   │       ├── Dashboard.jsx     # Live stats: nodes online, tasks/sec
│   │       └── Leaderboard.jsx
│   └── package.json
│
├── shared/
│   └── constants.js              # Chunk size, credit rates, task types
│
├── docker-compose.yml
└── README.md
```

---

## Getting started

### Prerequisites

- Node.js 18+
- PostgreSQL 

### Installation

```bash
# Clone the repo
git clone https://github.com/your-org/computequest.git
cd computequest

# Install server dependencies
cd server && npm install

# Install client dependencies
cd ../client && npm install
```

### Run locally

```bash
# Terminal 1 — server
cd server && npm run dev

# Terminal 2 — client
cd client && npm run dev
```

Open `http://localhost:5173`. Open a second tab — you'll see both register as nodes on the dashboard.

---

## How the distributed compute works

### Task lifecycle: Virtual Drug Screening (Chunked)
1. The server loads a library of ~1000 candidate drug molecules and a fixed protein target.
2. `taskQueue.js` splits the library into uniform batches (e.g. 30 molecules).
3. A batch is dispatched to an idle node via `socket.emit('molecule_batch', { taskId, batchId, molecules, target })`.
4. The browser's `computeWorker.js` receives the batch, parses the SMILES strings, and scores them locally via RDKit.js descriptors (MW, LogP, HBD/HBA).
5. The node returns the scores via `socket.emit('molecule_batch_result', { taskId, batchId, results })`.
6. The server merges the results into a global leaderboard and awards credits proportional to the batch size.
7. The server runs a spot-check verification, randomly re-scoring one molecule per batch to ensure node honesty.

### Task lifecycle: AI Inference (Request-Parallel)
1. A user submits a prompt to the AI assistant
2. The server identifies an idle node that is "warm" (already has the model loaded in WebLLM)
3. The prompt is routed to the assigned node
4. The node's `computeWorker.js` generates the response locally using WebGPU and WebLLM, streaming tokens back to the server in real-time
5. The server relays the streamed tokens to the requesting user

### Compute types (current)

| Type | Description | Use case |
|---|---|---|
| `MOLECULE_SCREEN` | Distributed virtual drug screening via molecular descriptor scoring | Real early-stage drug discovery triage, same pattern as Folding@home / [email protected] |
| `LLM_INFERENCE` | Request-parallel LLM generation via WebLLM | Distributed AI assistant |
| `MONTE_CARLO` | Random sampling for numerical integration | Scientific computing demo |

---

## What we're screening

Currently, ComputeQuest nodes are evaluating a library of ~1000 real drug-like molecules against **SARS-CoV-2 Main Protease (Mpro / 3CLpro)** (PDB: **6LU7**). 

**Caveat:** This is a simplified descriptor-based scoring function (matching H-bond donors/acceptors and molecular volume to the binding pocket), not full physics-based docking. It represents a real-world high-throughput triage step designed to rapidly filter millions of compounds, but is not a final computational answer.

---

## Game mechanics: The Forge

The Forge is a card battler layered on top of the real compute activity. 

### Economy
As your node processes compute tasks, you earn **Credits**. These credits can be converted into **Crystals** (100 credits = 1 Crystal) to spend in the Card Shop. 

### Cards & Deck Building
You can purchase cards of varying rarities (Common, Uncommon, Rare) and assemble a 4-card deck. Each card has:
- **Type**: OVERCLOCK, COOLANT, or FIRMWARE
- **Attack** & **Defense**: Used to calculate total power
- **Cost**: Crystal price

### Battles
When you enter a battle, your 4-card deck faces off against a bot's deck in a 4-round auto-battler. The winner of each round is determined by total power (Attack + Defense), modified by type advantage.

**Type Advantage (1.5x Power Multiplier):**
- **OVERCLOCK** beats **COOLANT**
- **COOLANT** beats **FIRMWARE**
- **FIRMWARE** beats **OVERCLOCK**

Win battles to earn Trophies and face harder bot tiers!

---

## Contributing

We use a branch-per-feature workflow. All merges to `main` require one PR review.

```bash
# Create your feature branch
git checkout -b feat/your-feature-name

# Work, commit often
git commit -m "feat: add chunk verification to taskQueue"

# Push and open a PR against dev
git push origin feat/your-feature-name
```

### Commit message format

```
feat: add WebSocket reconnection with exponential backoff
fix: chunk reassembly fails when nodes disconnect mid-task
chore: add eslint + prettier config
docs: update architecture diagram in README
```

### Branch structure

| Branch | Purpose |
|---|---|
| `main` | Always deployable, demo-ready |
| `dev` | Integration — merge features here first |
| `feat/*` | Individual features |
| `fix/*` | Bug fixes |
