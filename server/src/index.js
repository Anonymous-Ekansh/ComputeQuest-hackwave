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
const hfCache = new Map();

app.get('/models/*', async (req, res) => {
  const filePath = req.params[0];
  
  if (hfCache.has(filePath)) {
    const cached = hfCache.get(filePath);
    res.set('Content-Type', cached.contentType);
    return res.send(cached.buffer);
  }

  const sanitizedPath = filePath.replace(/^\/+/, '');
  const hfUrl = `https://huggingface.co/datasets/iamekansh/hackwave/resolve/main/${sanitizedPath}`;
  
  try {
    const hfRes = await fetch(hfUrl);
    
    if (!hfRes.ok) {
      return res.status(hfRes.status).json({ error: `Failed to fetch from Hugging Face: ${hfRes.statusText}` });
    }
    
    const contentType = hfRes.headers.get('content-type') || 'application/octet-stream';
    const arrayBuffer = await hfRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    hfCache.set(filePath, { contentType, buffer });
    
    res.set('Content-Type', contentType);
    res.send(buffer);
  } catch (err) {
    console.error(`[proxy] Error fetching ${hfUrl}:`, err);
    res.status(500).json({ error: 'Internal server error during HF proxy fetch' });
  }
});

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

