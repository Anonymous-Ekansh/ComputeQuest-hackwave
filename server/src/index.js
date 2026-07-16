require('dotenv').config();

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

// static assets
const path = require('path');
app.use('/models', express.static(path.join(__dirname, '..', 'models')));

// health check
app.get('/', (req, res) => {
  res.json({ status: 'ComputeQuest server running' });
});

// set up websocket handling
const { setupSocketHandler, getLeaderboard, getForgemasterLeaderboard } = require('./socketHandler');
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

