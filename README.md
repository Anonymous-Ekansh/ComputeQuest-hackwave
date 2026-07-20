# ComputeQuest 

> Donate your browser's computing power. Earn crystals. Forge your deck. Dominate the bots.

ComputeQuest is a distributed computing platform disguised as a deck-building card game. Users contribute idle CPU cycles from their browser to a shared compute pool — powering real ML-based drug screening and AI inference. In return, they earn in-game credits that can be converted into Crystals to buy cards, build a deck, and battle in The Forge.

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

- **Distributed ML drug screening** — nodes receive batches of candidate drug molecules, embed them via a ChemBERTa-77M-MTR chemistry transformer (Transformers.js), and score each by cosine similarity to known reference antibiotics — all entirely in-browser. Results are consensus-verified across multiple independent nodes before being accepted.
- **Consensus verification** — every molecule chunk is assigned to 3 independent nodes. Scores are only accepted when at least 2 of 3 nodes agree within tolerance. No single node's result counts on its own.
- **Browser-based LLM Inference** — uses WebLLM to run AI models entirely in the browser. The server routes user prompts to idle nodes, which stream the generated text back in real-time.
- **Web Worker isolation** — all computation runs in a background thread; your UI stays completely responsive
- **Real-time screening dashboard** — see consensus-verified screening progress, top candidate molecules, and your personal contribution stats
- **Credit system** — credits are only awarded for verified compute (chunks that reached consensus), with a full audit trail
- **Card Battler Game (The Forge)** — use your compute credits to buy Crystals, purchase cards from the shop, build a 4-card deck, and battle AI bots in an auto-battler with type-advantage mechanics.
- **Leaderboard** — ranked by verified compute contributed, not raw submission count

---

## Tech stack

| Layer | Technology |
|---|---|
| Server | Node.js, Express, Socket.io |
| Client | React, Vite |
| Compute | Web Workers API, Transformers.js (ChemBERTa), WebLLM, WebGPU |
| Database | Supabase (PostgreSQL) |
| Auth | Google OAuth (JWT) |
| Deployment | Railway / Render |

---

## Project structure

```
computequest/
├── server/
│   ├── src/
│   │   ├── index.js              # Express + Socket.io entry point
│   │   ├── taskQueue.js          # Job queue: k=3 redundant chunk assignment, consensus state machine
│   │   ├── socketHandler.js      # WebSocket events: routing tasks, consensus checking, credit gating
│   │   ├── consensus.js          # Agreement checking, timing validation, reputation tracking
│   │   ├── modelRegistry.js      # Active model version tracking, serves model info to clients
│   │   └── routes/
│   │       ├── auth.js           # Register, login, JWT issue
│   │       ├── tasks.js          # Submit tasks, query results
│   │       └── leaderboard.js    # Top contributors endpoint
│   ├── models/
│   │   ├── antibacterial_screen_v1.onnx  # Trained ML model (ECFP4 + GBM)
│   │   └── model_validation.json         # Published validation metrics
│   ├── data/
│   │   └── library/                      # ZINC drug-like molecule chunks
│   └── package.json
│
├── client/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── WorkerManager.js      # Manages Web Worker lifecycle
│   │   ├── workers/
│   │   │   ├── computeWorker.js  # Web Worker: ONNX inference, RDKit fingerprints, WebLLM generation
│   │   │   └── molecularScorer.js # RDKit.js ECFP4 fingerprinting + ONNX Runtime inference
│   │   ├── forge/                # The Forge card game components
│   │   │   ├── TheForge.jsx      # Main game hub
│   │   │   ├── CardShop.jsx      # Buy cards with Crystals
│   │   │   ├── DeckBuilder.jsx   # Assemble your 4-card deck
│   │   │   ├── BattleScreen.jsx  # Auto-battler UI
│   │   │   └── cardData.js       # Card catalog and battle logic
│   │   └── components/
│   │       ├── ScreeningProgress.jsx  # Network-level screening dashboard
│   │       ├── TopCandidates.jsx      # Ranked candidate list + CSV export
│   │       ├── Leaderboard.jsx        # Contributors + Forgemasters + Your Contribution
│   │       └── Dashboard.jsx          # Live stats: nodes online, tasks/sec
│   └── package.json
│
├── shared/
│   └── constants.js              # Chunk size, consensus params, credit rates
│
├── supabase/
│   └── migrations/
│       ├── 01_molecule_scores.sql
│       └── 02_consensus_screening.sql  # chunks, chunk_results, node_reputation, credit_events
│
└── README.md
```

---

## Getting started

### Prerequisites

- Node.js 18+
- Supabase project (or local PostgreSQL)

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

### Distributed Drug Screening (Consensus-Verified)

```
[Server, once, tiny]
Embed ~10 known reference antibiotics → store as static JSON → ship to all nodes

[Live system]
Molecule library (chunked)
        │
        ▼
  Server: Task Orchestrator ── assigns chunk to 3 nodes ──▶ Node A, Node B, Node C
        │                                                         │
        │◀──── each node: ChemBERTa embedding + cosine similarity ─┘
        ▼
  Server: Consensus Check (2-of-3 agreement within ±0.02)
        ▼
  Server: Credit Ledger (pay only for verified, agreed work)
        ▼
  Dashboard: Screening Progress + Top Candidates + CSV Export
```

#### Task lifecycle
1. The server loads a library of candidate drug molecules.
2. `taskQueue.js` splits the library into chunks (~30 molecules each) and assigns each chunk to **3 independent nodes** (k=3 redundancy).
3. Each node's `computeWorker.js` receives the chunk plus reference antibiotic data, embeds each SMILES string via ChemBERTa-77M-MTR (Transformers.js), and scores by cosine similarity to reference antibiotic embeddings — all in-browser.
4. Each node returns: `{ scores, wall_clock_ms, model_version, chunk_id }`.
5. `consensus.js` checks agreement: for each molecule, accepts if ≥2 of 3 node scores are within ±0.02 of each other. Rejects implausibly fast results.
6. **Credits are only awarded after consensus passes.** Nodes whose scores didn't agree get no credit for that chunk.
7. Consensus-accepted results are merged into the master ranked list — the actual scientific output of the network.
8. If consensus fails, the chunk is requeued to 3 *different* nodes.

#### Credit formula
```
credit_awarded(node) =
    base_rate
    × verified_compute_seconds
    × agreement_bonus (1.0 if agreed, 0 if not)
    × reputation_multiplier (tracks historical agreement rate)
```

### AI Inference (Request-Parallel)
1. A user submits a prompt to the AI assistant
2. The server identifies an idle node that is "warm" (already has the model loaded in WebLLM)
3. The prompt is routed to the assigned node
4. The node's `computeWorker.js` generates the response locally using WebGPU and WebLLM, streaming tokens back to the server in real-time
5. The server relays the streamed tokens to the requesting user

---

## What we're screening

ComputeQuest nodes screen a library of candidate drug molecules for **structural similarity to known antibiotics** using a pretrained chemistry transformer.

### The model
- **Architecture:** DeepChem/ChemBERTa-77M-MTR — a small pretrained RoBERTa transformer trained on molecular property prediction tasks
- **Method:** Embed candidate SMILES strings into 384-dimensional vectors, then score by cosine similarity to 10 reference antibiotic embeddings
- **Output:** Similarity score (0–1) — how structurally similar a candidate is to known antibiotics
- **Runtime:** Transformers.js — runs entirely in-browser, cached after first download

### Reference antibiotics
The system compares candidates against 10 known antibiotics from diverse classes: Penicillin G, Amoxicillin, Ciprofloxacin, Tetracycline, Erythromycin, Trimethoprim, Vancomycin, Halicin (the AI-discovered one), Metronidazole, and Doxycycline.

> **Caveat:** This is a structural-similarity proxy for bioactivity, not a trained antibacterial classifier. It's an honest, deployable v1 that captures molecular structure/property patterns. A supervised model trained on real bioactivity labels (ChEMBL) is the natural next step. Confirming any candidate requires laboratory testing.

### Dashboard views

1. **Screening Progress** — Consensus-verified molecules screened / total library. Only advances when independent nodes agree.
2. **Top Candidates** — Ranked by consensus-verified predicted antibacterial activity. Exportable as CSV.
3. **Your Contribution** — Personal verified chunks, agreement rate, credits earned from consensus work.

---

## Game mechanics: The Forge

The Forge is a card battler layered on top of the real compute activity. 

### Economy
As your node processes compute tasks and your results pass consensus verification, you earn **Credits**. These credits can be converted into **Crystals** (100 credits = 1 Crystal) to spend in the Card Shop. 

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
