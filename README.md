# ComputeQuest 

> Donate your browser's computing power. Earn territory. Dominate the map.

ComputeQuest is a distributed computing platform disguised as a game. Users contribute idle CPU cycles from their browser to a shared compute pool — powering real research tasks and ML inference. In return, they earn in-game credits to expand their territory on a live 2D strategy map.

No downloads. No sign-up friction. Just open a tab and start contributing.

---

## How it works

```
Your browser tab → Web Worker runs compute chunks silently in background
      ↓
WebSocket sends results to coordinator server
      ↓
Server reassembles chunks, verifies results, awards credits
      ↓
Credits unlock territory expansion in the live 2D game
```

Each connected browser is a **compute node**. The server splits heavy tasks (matrix operations, model inference batches) into chunks and distributes them across all online nodes. The more you contribute, the more your territory grows — and the more it glows on everyone else's map.

---

## Features

- **Distributed compute engine** — tasks are chunked server-side and dispatched to browser nodes via WebSocket; results are aggregated and verified automatically
- **Web Worker isolation** — all computation runs in a background thread; your UI stays completely responsive
- **Real-time node dashboard** — see how many nodes are live, tasks/sec throughput, and your personal contribution stats
- **Credit system** — every completed compute chunk earns credits stored server-side with a full audit trail
- **2D territory game** — spend credits to claim and upgrade hex tiles on a shared map; active compute nodes pulse visually on the map
- **Leaderboard** — ranked by total compute contributed (GFlops donated), not just time spent

---

## Tech stack

| Layer | Technology |
|---|---|
| Server | Node.js, Express, Socket.io |
| Client | React, Vite |
| Compute | Web Workers API, SharedArrayBuffer |
| Game | Phaser.js (2D canvas) |
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
│   │   ├── socketHandler.js      # WebSocket events: register node, submit result
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
│   │   ├── workers/
│   │   │   └── computeWorker.js  # Web Worker: receives chunk, computes, posts result
│   │   ├── game/
│   │   │   ├── GameScene.js      # Phaser scene: hex map, territory rendering
│   │   │   └── UIScene.js        # HUD: credits, node status, contribution counter
│   │   └── components/
│   │       ├── NodeStatus.jsx    # "You are contributing" indicator
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

### Task lifecycle

1. A task (e.g. multiply two 1024×1024 matrices) is submitted to the server
2. `taskQueue.js` splits it into N chunks based on connected node count
3. Each chunk is sent to a node via `socket.emit('chunk', { taskId, chunkId, data })`
4. The browser's `computeWorker.js` receives the chunk, computes it inside a Web Worker, and emits `socket.emit('result', { taskId, chunkId, result })`
5. Server collects all chunks for a task, reassembles, and marks it complete
6. Credits are awarded to each contributing node proportional to chunk size

### Compute types (current)

| Type | Description | Use case |
|---|---|---|
| `MATRIX_MULTIPLY` | Chunked matrix multiplication | Linear algebra / research baseline |
| `INFERENCE_BATCH` | Forward pass on a tiny transformer layer | Distributed ML demo |
| `MONTE_CARLO` | Random sampling for numerical integration | Scientific computing demo |

### Credit formula(not final)

```
credits_earned = chunk_flops × difficulty_multiplier × node_reliability_score
```

Reliability score decays if a node frequently disconnects mid-task.

---

## Game mechanics

The 2D hex map is the visual layer on top of real compute activity.

| Action | Cost | Effect |
|---|---|---|
| Claim empty tile | 50 credits | Territory expands |
| Upgrade tile (level 1→2) | 200 credits | Tile glows, earns passive credits |
| Fortify border | 100 credits | Slows neighbouring takeover |
| Challenge tile | 300 credits | Contest an adjacent enemy tile |

**While your node is actively computing**, your tiles pulse with a blue glow on everyone's map. Go offline, and the glow fades. This makes compute contribution immediately visible as a social signal.

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

---

## Roadmap

| Week | Milestone |
|---|---|
| 2 | WebSocket node registration + Web Worker compute + basic server |
| 3 | Task queue: chunk splitting, distribution, result aggregation |
| 4 | Auth, credit system, PostgreSQL, leaderboard API |
| 5 | Phaser.js game map, territory mechanics, real-time updates |
| 6 | Polish, live demo, performance dashboard, deployment |
---
