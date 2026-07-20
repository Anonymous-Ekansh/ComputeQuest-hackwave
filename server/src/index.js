const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');



const app = express();
const server = http.createServer(app);

const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const io = new Server(server, {
  cors: {
    origin: clientOrigin,
    methods: ['GET', 'POST'],
  },
});

// middleware
app.use(cors({ origin: clientOrigin }));
app.use(express.json());

// health check
app.get('/', (req, res) => {
  res.json({ status: 'ComputeQuest server running' });
});

// set up websocket handling
const { setupSocketHandler, getLeaderboard, getForgemasterLeaderboard, getMoleculeLeaderboard, getScreeningProgress } = require('./socketHandler');
setupSocketHandler(io);

app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaderboard = await getLeaderboard();
    res.json(leaderboard);
  } catch (err) {
    console.error('Leaderboard fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

app.get('/api/leaderboard/molecules', async (req, res) => {
  try {
    const topMolecules = getMoleculeLeaderboard();
    const progress = getScreeningProgress();

    res.json({ topMolecules, progress });
  } catch (err) {
    console.error('Molecule leaderboard fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch molecule leaderboard' });
  }
});

// New: screening progress endpoint
app.get('/api/screening/progress', (req, res) => {
  try {
    res.json(getScreeningProgress());
  } catch (err) {
    console.error('Screening progress fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch screening progress' });
  }
});

// New: export top candidates as CSV
app.get('/api/screening/export', (req, res) => {
  try {
    const topMolecules = getMoleculeLeaderboard();
    const progress = getScreeningProgress();

    // Build CSV
    const header = 'rank,smiles,binding_affinity,model_version\n';
    const rows = topMolecules.map((mol, idx) =>
      `${idx + 1},"${mol.smiles}",${mol.affinity?.toFixed(2) || 'N/A'},${mol.modelVersion || 'Webina-1.0'}`
    ).join('\n');

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="computequest_docking_results_${date}.csv"`);
    res.send(
      `# ComputeQuest Distributed Webina Docking Results\n` +
      `# Date: ${new Date().toISOString()}\n` +
      `# Target: 1PWC (Penicillin-Binding Protein)\n` +
      `# Molecules screened: ${progress.moleculesVerified} / ${progress.totalMolecules}\n` +
      `#\n` +
      header + rows
    );
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Failed to export' });
  }
});

app.get('/api/leaderboard/forgemasters', async (req, res) => {
  try {
    const leaderboard = await getForgemasterLeaderboard();
    res.json(leaderboard);
  } catch (err) {
    console.error('Forgemaster leaderboard fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch forgemaster leaderboard' });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`ComputeQuest server running on port ${PORT}`);
});
