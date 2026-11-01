require('dotenv').config();
const express = require('express');
const session = require('cookie-session');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();

// Initialize Turso cloud database (or fallback to local file if developing locally)
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:desync.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  name: 'desync_session',
  keys: [process.env.SESSION_SECRET || 'dev_secret'],
  maxAge: 7 * 24 * 60 * 60 * 1000
}));

// Initialize Database Tables asynchronously
async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      avatar TEXT,
      role TEXT DEFAULT 'member',
      credits INTEGER DEFAULT 500,
      bio TEXT DEFAULT '',
      signature TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS invite_keys (
      code TEXT PRIMARY KEY,
      created_by TEXT,
      used INTEGER DEFAULT 0
    );
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      game TEXT NOT NULL,
      price INTEGER NOT NULL,
      description TEXT NOT NULL,
      download_url TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      seller_name TEXT NOT NULL,
      purchases INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Insert default invite key if empty
  const res = await db.execute('SELECT * FROM invite_keys LIMIT 1');
  if (res.rows.length === 0) {
    await db.execute({
      sql: 'INSERT INTO invite_keys (code, created_by) VALUES (?, ?)',
      args: ['DSYNC-WELCOME-2026', 'system']
    });
  }
}
initDb();

// Middleware: Require Auth
async function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE discord_id = ?',
    args: [req.session.userId]
  });
  if (result.rows.length === 0) return res.status(401).json({ error: 'user not found' });
  req.user = result.rows[0];
  next();
}

// Session Check Route
app.get('/api/session', async (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ loggedIn: false });
  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE discord_id = ?',
    args: [req.session.userId]
  });
  if (result.rows.length === 0) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user: result.rows[0] });
});

// Discord OAuth Route
app.get('/api/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.join'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

// Discord OAuth Callback
app.get('/api/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect('/?error=token_failed');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const discordUser = await userRes.json();

    // Auto-join guild via Bot
    if (process.env.DISCORD_GUILD_ID && process.env.DISCORD_BOT_TOKEN) {
      await fetch(`https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${discordUser.id}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ access_token: tokenData.access_token })
      }).catch(() => {});
    }

    const existing = await db.execute({
      sql: 'SELECT * FROM users WHERE discord_id = ?',
      args: [discordUser.id]
    });

    if (existing.rows.length === 0) {
      req.session.pendingDiscord = {
        discord_id: discordUser.id,
        username: discordUser.username,
        avatar: `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      };
      return res.redirect('/#register-invite');
    }

    req.session.userId = existing.rows[0].discord_id;
    res.redirect('/');
  } catch (err) {
    res.redirect('/?error=server_error');
  }
});

// Register with Invite Key
app.post('/api/auth/register-invite', async (req, res) => {
  const { invite_code } = req.body;
  const pending = req.session.pendingDiscord;
  if (!pending) return res.status(400).json({ error: 'no pending discord user' });

  const inviteCheck = await db.execute({
    sql: 'SELECT * FROM invite_keys WHERE code = ? AND used = 0',
    args: [invite_code]
  });
  if (inviteCheck.rows.length === 0) return res.status(400).json({ error: 'invalid or used invite key' });

  await db.execute({
    sql: 'UPDATE invite_keys SET used = 1 WHERE code = ?',
    args: [invite_code]
  });

  await db.execute({
    sql: 'INSERT INTO users (discord_id, username, avatar, role, credits) VALUES (?, ?, ?, ?, ?)',
    args: [pending.discord_id, pending.username, pending.avatar, 'member', 500]
  });

  req.session.userId = pending.discord_id;
  delete req.session.pendingDiscord;
  res.json({ success: true });
});

// Roulette Spin API
app.post('/api/roulette/spin', requireAuth, async (req, res) => {
  const { bet, option } = req.body;
  if (!bet || bet <= 0 || req.user.credits < bet) {
    return res.status(400).json({ error: 'insufficient credits or invalid bet' });
  }

  await db.execute({
    sql: 'UPDATE users SET credits = credits - ? WHERE discord_id = ?',
    args: [bet, req.user.discord_id]
  });

  const roll = Math.random() * 100;
  let multiplier = 0;
  let resultName = 'lost';

  if (roll < 48) {
    resultName = 'void';
    if (option === 'void') multiplier = 2;
  } else if (roll < 83) {
    resultName = 'cobalt';
    if (option === 'cobalt') multiplier = 2;
  } else {
    resultName = 'desync';
    if (option === 'desync') multiplier = 14;
  }

  const winnings = bet * multiplier;
  if (winnings > 0) {
    await db.execute({
      sql: 'UPDATE users SET credits = credits + ? WHERE discord_id = ?',
      args: [winnings, req.user.discord_id]
    });
  }

  const updatedUser = await db.execute({
    sql: 'SELECT credits FROM users WHERE discord_id = ?',
    args: [req.user.discord_id]
  });

  res.json({ result: resultName, winnings, credits: updatedUser.rows[0].credits });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Desync backend running on port ${PORT}`);
});
