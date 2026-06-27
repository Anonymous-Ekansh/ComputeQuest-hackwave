const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const usersFilePath = path.join(__dirname, '..', '..', 'data', 'users.json');

function loadUsers() {
  try {
    if (fs.existsSync(usersFilePath)) {
      const data = fs.readFileSync(usersFilePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Failed to load users:', err);
  }
  return [];
}

function saveUsers(usersData) {
  try {
    fs.writeFileSync(usersFilePath, JSON.stringify(usersData, null, 2));
  } catch (err) {
    console.error('Failed to save users:', err);
  }
}

// file-based user store (will be replaced with PostgreSQL later)
let users = loadUsers();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL ERROR: JWT_SECRET environment variable is not defined in production!');
}
const jwtSecretKey = JWT_SECRET || 'computequest-dev-secret-change-me';

// generate a JWT for a user
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    jwtSecretKey,
    { expiresIn: '24h' }
  );
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // check if username is taken
    if (users.find(u => u.username === username)) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = {
      id: Date.now().toString(),
      username,
      password: hashedPassword,
    };
    users.push(user);
    saveUsers(users);

    const token = signToken(user);
    res.status(201).json({ token, username: user.username });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = users.find(u => u.username === username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(user);
    res.json({ token, username: user.username });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

module.exports = router;
