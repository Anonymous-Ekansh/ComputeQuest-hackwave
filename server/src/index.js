require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const setupSocketHandler = require('./socketHandler');

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

// routes
app.use('/api/auth', authRoutes);

// health check
app.get('/', (req, res) => {
  res.json({ status: 'ComputeQuest server running' });
});

// set up websocket handling
setupSocketHandler(io);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`ComputeQuest server running on port ${PORT}`);
});
