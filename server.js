const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';

const transporter = (SMTP_USER && SMTP_PASS) ? nodemailer.createTransport({
  host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
}) : null;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'mixed-messenger-secret-key';
const PORT = process.env.PORT || 3000;

const tursoUrl = process.env.TURSO_DATABASE_URL || 'libsql://mixed-messenger-xexan.aws-eu-west-1.turso.io';
const tursoToken = process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODQwMTE3NzYsImlkIjoiMDE5ZjVmNjEtYjUwMS03MThkLTkwY2MtYzQ0YjI1YzlkNDM1Iiwia2lkIjoiRG5TV0sza3RsNVIzZDNFUW1SblMtdDRjNk4yM0pzd3NtQXVTWmQyY1pkTSIsInJpZCI6ImJiZTkwMTFiLTYwN2EtNGQ4ZS1hMTYxLTBiMmYxZWM2YmJhNyJ9._PUxL8EsMKjw1CoakWlKQlYu38RkXmVNpcobd8YVjdE0mWfvWXGBu4B1qtC65qlSFPP3JQ6Fsc9OvVPJYWfkDg';

const db = createClient({ url: tursoUrl, authToken: tursoToken });

['uploads/images', 'uploads/videos', 'uploads/voices', 'uploads/files'].forEach(dir => {
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
});

async function dbRun(sql, args = []) {
  const result = await db.execute({ sql, args });
  return Number(result.lastInsertRowid);
}

async function dbGet(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows[0] || null;
}

async function dbAll(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows;
}

async function initDB() {
  await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url TEXT,
    is_online INTEGER DEFAULT 0,
    last_seen TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS friendships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    is_group INTEGER DEFAULT 0,
    avatar_url TEXT,
    wallpaper_url TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS conversation_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at TEXT DEFAULT (datetime('now'))
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    content TEXT,
    message_type TEXT DEFAULT 'text',
    media_url TEXT,
    file_name TEXT,
    reply_to_id INTEGER,
    is_read INTEGER DEFAULT 0,
    is_deleted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS verification_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS message_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  try { await db.execute({ sql: 'ALTER TABLE messages ADD COLUMN reply_to_id INTEGER', args: [] }); } catch {}
  try { await db.execute({ sql: 'ALTER TABLE messages ADD COLUMN is_deleted INTEGER DEFAULT 0', args: [] }); } catch {}
  try { await db.execute({ sql: 'ALTER TABLE users ADD COLUMN password_hash TEXT', args: [] }); } catch {}
  try { await db.execute({ sql: 'ALTER TABLE conversations ADD COLUMN wallpaper_url TEXT', args: [] }); } catch {}
  try { await db.execute({ sql: 'ALTER TABLE messages ADD COLUMN is_edited INTEGER DEFAULT 0', args: [] }); } catch {}
  try { await db.execute({ sql: 'ALTER TABLE users ADD COLUMN user_status TEXT DEFAULT NULL', args: [] }); } catch {}

  try { await db.execute('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)', []); } catch {}
  try { await db.execute('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)', []); } catch {}

  await db.execute(`CREATE TABLE IF NOT EXISTS blocked_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blocker_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(blocker_id, blocked_id)
  )`);
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase();
    if (['jpg','jpeg','png','gif','webp'].includes(ext)) cb(null, path.join(__dirname, 'uploads/images'));
    else if (['mp4','webm','mov'].includes(ext)) cb(null, path.join(__dirname, 'uploads/videos'));
    else if (['mp3','ogg','wav','webm'].includes(ext)) cb(null, path.join(__dirname, 'uploads/voices'));
    else cb(null, path.join(__dirname, 'uploads/files'));
  },
  filename: (req, file, cb) => cb(null, `${uuidv4()}.${file.originalname.split('.').pop()}`)
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ detail: 'No token' });
  try { req.userId = jwt.verify(token, JWT_SECRET).userId; next(); }
  catch { res.status(401).json({ detail: 'Invalid token' }); }
}

async function getConversationId(userA, userB) {
  const existing = await dbGet(`
    SELECT cm1.conversation_id FROM conversation_members cm1
    JOIN conversation_members cm2 ON cm1.conversation_id = cm2.conversation_id
    JOIN conversations c ON c.id = cm1.conversation_id
    WHERE cm1.user_id = ? AND cm2.user_id = ? AND c.is_group = 0
  `, [userA, userB]);
  if (existing) return existing.conversation_id;
  const id = await dbRun('INSERT INTO conversations (is_group) VALUES (0)', []);
  await dbRun('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [id, userA]);
  await dbRun('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [id, userB]);
  return id;
}

// AUTH
app.post('/api/auth/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ detail: 'Email required' });
  if (await dbGet('SELECT id FROM users WHERE email = ?', [email]))
    return res.status(400).json({ detail: 'Email already registered' });
  if (!transporter) return res.status(500).json({ detail: 'Email not configured on server' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await db.execute({ sql: 'DELETE FROM verification_codes WHERE email = ?', args: [email] });
  await dbRun('INSERT INTO verification_codes (email, code, expires_at) VALUES (?, ?, ?)', [email, code, expires]);
  try {
    await transporter.sendMail({
      from: `"Mixed Messenger" <${SMTP_USER}>`,
      to: email,
      subject: 'Код подтверждения',
      text: `Ваш код: ${code}. Действителен 10 минут.`,
      html: `<h2>Mixed Messenger</h2><p>Ваш код подтверждения: <b>${code}</b></p><p>Действителен 10 минут.</p>`
    });
    res.json({ message: 'Code sent' });
  } catch (e) {
    console.error('Email error:', e);
    res.status(500).json({ detail: 'Failed to send email' });
  }
});

app.post('/api/auth/verify-code', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ detail: 'Email and code required' });
  const v = await dbGet("SELECT * FROM verification_codes WHERE email = ? AND code = ? AND used = 0 AND expires_at > datetime('now')", [email, code]);
  if (!v) return res.status(400).json({ detail: 'Invalid or expired code' });
  await db.execute({ sql: 'UPDATE verification_codes SET used = 1 WHERE id = ?', args: [v.id] });
  res.json({ message: 'Email verified' });
});

app.post('/api/auth/register', async (req, res) => {
  const { email, username, password } = req.body;
  if (!email || !username || !password) return res.status(400).json({ detail: 'All fields required' });
  if (await dbGet('SELECT id FROM users WHERE email = ?', [email]) || await dbGet('SELECT id FROM users WHERE username = ?', [username]))
    return res.status(400).json({ detail: 'Email or username already taken' });
  const hash = bcrypt.hashSync(password, 10);
  const id = await dbRun('INSERT INTO users (email, username, password_hash) VALUES (?, ?, ?)', [email, username, hash]);
  const access_token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '7d' });
  const refresh_token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ access_token, refresh_token, token_type: 'bearer', user: { id, email, username, avatar_url: null, is_online: 1, last_seen: new Date().toISOString(), created_at: new Date().toISOString() } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ detail: 'Email and password required' });
  const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ detail: 'Invalid credentials' });
  await db.execute({ sql: "UPDATE users SET last_seen = datetime('now'), is_online = 1 WHERE id = ?", args: [user.id] });
  const access_token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
  const refresh_token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ access_token, refresh_token, token_type: 'bearer', user: { id: user.id, email: user.email, username: user.username, avatar_url: user.avatar_url, is_online: 1, last_seen: new Date().toISOString(), created_at: user.created_at } });
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const d = jwt.verify(req.body.refresh_token, JWT_SECRET);
    const access_token = jwt.sign({ userId: d.userId }, JWT_SECRET, { expiresIn: '7d' });
    const refresh_token = jwt.sign({ userId: d.userId }, JWT_SECRET, { expiresIn: '30d' });
    const user = await dbGet('SELECT id, email, username, avatar_url, is_online, last_seen, created_at FROM users WHERE id = ?', [d.userId]);
    res.json({ access_token, refresh_token, token_type: 'bearer', user });
  } catch { res.status(401).json({ detail: 'Invalid refresh token' }); }
});

// USERS
app.get('/api/users/me', auth, async (req, res) => {
  const u = await dbGet('SELECT id, email, username, avatar_url, is_online, last_seen, created_at FROM users WHERE id = ?', [req.userId]);
  u ? res.json(u) : res.status(404).json({ detail: 'User not found' });
});

app.put('/api/users/me', auth, async (req, res) => {
  const { username, avatar_url } = req.body;
  if (username) {
    if (await dbGet('SELECT id FROM users WHERE username = ? AND id != ?', [username, req.userId]))
      return res.status(400).json({ detail: 'Username already taken' });
    await db.execute({ sql: 'UPDATE users SET username = ? WHERE id = ?', args: [username, req.userId] });
  }
  if (avatar_url !== undefined) await db.execute({ sql: 'UPDATE users SET avatar_url = ? WHERE id = ?', args: [avatar_url, req.userId] });
  res.json(await dbGet('SELECT id, email, username, avatar_url, is_online, last_seen, created_at FROM users WHERE id = ?', [req.userId]));
});

app.put('/api/users/me/password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ detail: 'Current and new password required' });
  if (new_password.length < 6) return res.status(400).json({ detail: 'Password must be at least 6 characters' });
  const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.userId]);
  if (!await bcrypt.compare(current_password, user.password_hash)) return res.status(400).json({ detail: 'Current password is incorrect' });
  await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [await bcrypt.hash(new_password, 10), req.userId] });
  res.json({ message: 'Password changed' });
});

app.get('/api/users/search', auth, async (req, res) => {
  const q = req.query.query || '';
  res.json(await dbAll('SELECT id, email, username, avatar_url, is_online, last_seen, created_at FROM users WHERE (username LIKE ? OR email LIKE ?) AND id != ?', [`%${q}%`, `%${q}%`, req.userId]));
});

// USER PROFILE (must be before /:id route)
app.get('/api/users/:id/profile', auth, async (req, res) => {
  const u = await dbGet('SELECT id, username, avatar_url, last_seen, is_online, created_at FROM users WHERE id = ?', [parseInt(req.params.id)]);
  u ? res.json(u) : res.status(404).json({ detail: 'User not found' });
});

app.get('/api/users/:id', auth, async (req, res) => {
  const u = await dbGet('SELECT id, email, username, avatar_url, is_online, last_seen, created_at FROM users WHERE id = ?', [parseInt(req.params.id)]);
  u ? res.json(u) : res.status(404).json({ detail: 'User not found' });
});

// FRIENDS
app.post('/api/friends/request', auth, async (req, res) => {
  const { username } = req.body;
  const r = await dbGet('SELECT id FROM users WHERE username = ?', [username]);
  if (!r) return res.status(400).json({ detail: 'User not found' });
  if (r.id === req.userId) return res.status(400).json({ detail: 'Cannot add yourself' });
  if (await dbGet('SELECT id FROM friendships WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)', [req.userId, r.id, r.id, req.userId]))
    return res.status(400).json({ detail: 'Friend request already exists' });
  await dbRun('INSERT INTO friendships (sender_id, receiver_id) VALUES (?, ?)', [req.userId, r.id]);
  res.json({ message: 'Friend request sent' });
});

app.put('/api/friends/respond/:id', auth, async (req, res) => {
  const { status } = req.body;
  const f = await dbGet("SELECT * FROM friendships WHERE id = ? AND receiver_id = ? AND status = 'pending'", [parseInt(req.params.id), req.userId]);
  if (!f) return res.status(400).json({ detail: 'Request not found' });
  await db.execute({ sql: 'UPDATE friendships SET status = ? WHERE id = ?', args: [status, req.params.id] });
  if (status === 'accepted') await getConversationId(f.sender_id, f.receiver_id);
  res.json({ message: `Friend request ${status}` });
});

app.get('/api/friends/', auth, async (req, res) => {
  const f = await dbAll("SELECT * FROM friendships WHERE status = 'accepted' AND (sender_id = ? OR receiver_id = ?)", [req.userId, req.userId]);
  const ids = f.map(x => x.sender_id === req.userId ? x.receiver_id : x.sender_id);
  if (!ids.length) return res.json([]);
  res.json(await dbAll(`SELECT id, email, username, avatar_url, is_online, last_seen, created_at FROM users WHERE id IN (${ids.join(',')})`));
});

app.get('/api/friends/pending', auth, async (req, res) => {
  res.json(await dbAll("SELECT f.*, u.username as sender_username, u.avatar_url as sender_avatar FROM friendships f JOIN users u ON f.sender_id = u.id WHERE f.receiver_id = ? AND f.status = 'pending'", [req.userId]));
});

app.delete('/api/friends/:id', auth, async (req, res) => {
  const friendId = parseInt(req.params.id);
  await db.execute({ sql: "DELETE FROM friendships WHERE status = 'accepted' AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))", args: [req.userId, friendId, friendId, req.userId] });
  res.json({ message: 'Friend removed' });
});

// CONVERSATIONS & MESSAGES
app.get('/api/conversations', auth, async (req, res) => {
  const convos = await dbAll(`
    SELECT c.* FROM conversations c
    JOIN conversation_members cm ON c.id = cm.conversation_id
    WHERE cm.user_id = ?
  `, [req.userId]);

  const result = [];
  for (const conv of convos) {
    const members = await dbAll(`
      SELECT u.id, u.username, u.avatar_url, u.is_online FROM users u
      JOIN conversation_members cm ON u.id = cm.user_id
      WHERE cm.conversation_id = ?
    `, [conv.id]);

    const lastMsg = await dbGet(`
      SELECT m.*, u.username as sender_username FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at DESC LIMIT 1
    `, [conv.id]);

    const unread = await dbGet(`
      SELECT COUNT(*) as count FROM messages
      WHERE conversation_id = ? AND sender_id != ? AND is_read = 0
    `, [conv.id, req.userId]);

    const otherMember = !conv.is_group ? members.find(m => m.id !== req.userId) : null;

    result.push({
      id: conv.id,
      name: conv.is_group ? conv.name : (otherMember?.username || 'Unknown'),
      avatar_url: conv.is_group ? conv.avatar_url : (otherMember?.avatar_url || null),
      wallpaper_url: conv.wallpaper_url || null,
      is_group: conv.is_group,
      members,
      last_message: lastMsg ? (lastMsg.content || `[${lastMsg.message_type}]`) : null,
      last_message_time: lastMsg?.created_at || null,
      unread_count: unread?.count || 0,
      other_user_id: otherMember?.id || null,
      is_online: otherMember?.is_online || '0',
    });
  }

  result.sort((a, b) => {
    if (!a.last_message_time) return 1;
    if (!b.last_message_time) return -1;
    return new Date(b.last_message_time).getTime() - new Date(a.last_message_time).getTime();
  });

  res.json(result);
});

app.post('/api/conversations', auth, async (req, res) => {
  const { name, member_ids } = req.body;
  if (!member_ids || !member_ids.length) return res.status(400).json({ detail: 'Members required' });

  if (member_ids.length === 1 && !name) {
    const existing = await dbGet(`
      SELECT c.id FROM conversations c
      JOIN conversation_members cm1 ON c.id = cm1.conversation_id AND cm1.user_id = ?
      JOIN conversation_members cm2 ON c.id = cm2.conversation_id AND cm2.user_id = ?
      WHERE c.is_group = 0
    `, [req.userId, member_ids[0]]);
    if (existing) return res.json({ id: existing.id });
  }

  const isGroup = member_ids.length > 1 || !!name;
  const id = await dbRun('INSERT INTO conversations (name, is_group, created_by) VALUES (?, ?, ?)', [name || null, isGroup ? 1 : 0, req.userId]);
  await dbRun('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [id, req.userId]);
  for (const mid of member_ids) {
    if (mid !== req.userId) await dbRun('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [id, mid]);
  }
  res.json({ id, name, is_group: isGroup });
});

app.put('/api/conversations/:id/wallpaper', auth, upload.single('file'), async (req, res) => {
  const convId = parseInt(req.params.id);
  if (!req.file) {
    await db.execute({ sql: 'UPDATE conversations SET wallpaper_url = NULL WHERE id = ?', args: [convId] });
    return res.json({ wallpaper_url: null });
  }
  const ext = req.file.originalname.split('.').pop().toLowerCase();
  let type = 'images';
  const url = `/uploads/${type}/${req.file.filename}`;
  await db.execute({ sql: 'UPDATE conversations SET wallpaper_url = ? WHERE id = ?', args: [url, convId] });
  res.json({ wallpaper_url: url });
});

app.get('/api/conversations/:id/messages', auth, async (req, res) => {
  const convId = parseInt(req.params.id);
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const before = req.query.before;
  const unread = await dbAll('SELECT id, sender_id FROM messages WHERE conversation_id = ? AND sender_id != ? AND is_read = 0', [convId, req.userId]);
  await db.execute({ sql: 'UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_id != ? AND is_read = 0', args: [convId, req.userId] });
  if (unread.length > 0) {
    const senderIds = [...new Set(unread.map(m => m.sender_id))];
    for (const senderId of senderIds) {
      const conn = connections.get(senderId);
      if (conn && conn.readyState === 1) {
        conn.send(JSON.stringify({ type: 'message_read', data: { conversation_id: convId, message_ids: unread.filter(m => m.sender_id === senderId).map(m => m.id) } }));
      }
    }
  }
  let query = `
    SELECT m.*, u.username as sender_username, u.avatar_url as sender_avatar
    FROM messages m JOIN users u ON m.sender_id = u.id
    WHERE m.conversation_id = ?
  `;
  const params = [convId];
  if (before) {
    query += ` AND m.id < ?`;
    params.push(parseInt(before));
  }
  query += ` ORDER BY m.created_at DESC LIMIT ?`;
  params.push(limit);
  let messages = await dbAll(query, params);
  messages.reverse();
  for (const msg of messages) {
    if (msg.reply_to_id) {
      msg.reply_to = await dbGet(`
        SELECT m.id, m.content, m.message_type, m.file_name, u.username as sender_username
        FROM messages m JOIN users u ON m.sender_id = u.id
        WHERE m.id = ?
      `, [msg.reply_to_id]);
    }
    msg.reactions = await dbAll(`
      SELECT mr.id, mr.user_id, mr.emoji, mr.created_at, u.username
      FROM message_reactions mr JOIN users u ON mr.user_id = u.id
      WHERE mr.message_id = ?
    `, [msg.id]);
  }
  res.json(messages);
});

app.post('/api/messages', auth, async (req, res) => {
  const { conversation_id, receiver_id, content, message_type, media_url, file_name, reply_to_id } = req.body;
  let convId = conversation_id;
  if (!convId && receiver_id) convId = await getConversationId(req.userId, receiver_id);
  if (!convId) return res.status(400).json({ detail: 'conversation_id or receiver_id required' });
  const id = await dbRun('INSERT INTO messages (conversation_id, sender_id, content, message_type, media_url, file_name, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [convId, req.userId, content || null, message_type || 'text', media_url || null, file_name || null, reply_to_id || null]);
  const u = await dbGet('SELECT username, avatar_url FROM users WHERE id = ?', [req.userId]);
  const members = await dbAll('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [convId]);
  let replyTo = null;
  if (reply_to_id) {
    replyTo = await dbGet('SELECT m.id, m.content, m.message_type, m.file_name, u.username as sender_username FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?', [reply_to_id]);
  }
  const msg = { id, conversation_id: convId, sender_id: req.userId, content, message_type: message_type || 'text', media_url, file_name, reply_to_id: reply_to_id || null, reply_to: replyTo, is_read: 0, created_at: new Date().toISOString(), sender_username: u.username, sender_avatar: u.avatar_url };
  for (const m of members) {
    if (m.user_id !== req.userId) {
      const conn = connections.get(m.user_id);
      if (conn && conn.readyState === 1) conn.send(JSON.stringify({ type: 'new_message', data: msg }));
    }
  }
  res.json(msg);
});

// DELETE MESSAGE
app.delete('/api/messages/:id', auth, async (req, res) => {
  const msgId = parseInt(req.params.id);
  const msg = await dbGet('SELECT * FROM messages WHERE id = ?', [msgId]);
  if (!msg) return res.status(404).json({ detail: 'Message not found' });
  if (msg.sender_id !== req.userId) return res.status(403).json({ detail: 'Can only delete your own messages' });
  await db.execute({ sql: 'UPDATE messages SET is_deleted = 1, content = NULL, media_url = NULL, file_name = NULL WHERE id = ?', args: [msgId] });
  const members = await dbAll('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [msg.conversation_id]);
  const out = JSON.stringify({ type: 'message_deleted', data: { id: msgId, conversation_id: msg.conversation_id } });
  for (const m of members) {
    const conn = connections.get(m.user_id);
    if (conn && conn.readyState === 1) conn.send(out);
  }
  res.json({ message: 'Deleted' });
});

// REACTIONS
app.post('/api/messages/:id/reactions', auth, async (req, res) => {
  const msgId = parseInt(req.params.id);
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ detail: 'emoji required' });
  const msg = await dbGet('SELECT * FROM messages WHERE id = ?', [msgId]);
  if (!msg) return res.status(404).json({ detail: 'Message not found' });
  const existing = await dbGet('SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [msgId, req.userId, emoji]);
  if (existing) return res.json({ id: existing.id, emoji });
  const id = await dbRun('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', [msgId, req.userId, emoji]);
  const members = await dbAll('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [msg.conversation_id]);
  const out = JSON.stringify({ type: 'message_reaction', data: { message_id: msgId, user_id: req.userId, emoji, action: 'add' } });
  for (const m of members) {
    const conn = connections.get(m.user_id);
    if (conn && conn.readyState === 1) conn.send(out);
  }
  res.json({ id, emoji });
});

app.delete('/api/messages/:id/reactions', auth, async (req, res) => {
  const msgId = parseInt(req.params.id);
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ detail: 'emoji required' });
  const msg = await dbGet('SELECT * FROM messages WHERE id = ?', [msgId]);
  if (!msg) return res.status(404).json({ detail: 'Message not found' });
  await db.execute({ sql: 'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', args: [msgId, req.userId, emoji] });
  const members = await dbAll('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [msg.conversation_id]);
  const out = JSON.stringify({ type: 'message_reaction', data: { message_id: msgId, user_id: req.userId, emoji, action: 'remove' } });
  for (const m of members) {
    const conn = connections.get(m.user_id);
    if (conn && conn.readyState === 1) conn.send(out);
  }
  res.json({ message: 'Reaction removed' });
});

// FORWARD MESSAGE
app.post('/api/messages/:id/forward', auth, async (req, res) => {
  const msgId = parseInt(req.params.id);
  const { conversation_id } = req.body;
  if (!conversation_id) return res.status(400).json({ detail: 'conversation_id required' });
  const orig = await dbGet('SELECT * FROM messages WHERE id = ?', [msgId]);
  if (!orig) return res.status(404).json({ detail: 'Message not found' });
  const member = await dbGet('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [conversation_id, req.userId]);
  if (!member) return res.status(403).json({ detail: 'Not a member of this conversation' });
  const id = await dbRun(
    'INSERT INTO messages (conversation_id, sender_id, content, message_type, media_url, file_name, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [conversation_id, req.userId, orig.content, orig.message_type, orig.media_url, orig.file_name, null]
  );
  const u = await dbGet('SELECT username, avatar_url FROM users WHERE id = ?', [req.userId]);
  const msg = { id, conversation_id, sender_id: req.userId, content: orig.content, message_type: orig.message_type, media_url: orig.media_url, file_name: orig.file_name, reply_to_id: null, is_read: 0, created_at: new Date().toISOString(), sender_username: u.username, sender_avatar: u.avatar_url, forwarded_from: orig.id };
  const members = await dbAll('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [conversation_id]);
  const out = JSON.stringify({ type: 'new_message', data: msg });
  for (const m of members) {
    const conn = connections.get(m.user_id);
    if (conn && conn.readyState === 1) conn.send(out);
  }
  res.json(msg);
});

// EDIT MESSAGE
app.put('/api/messages/:id/edit', auth, async (req, res) => {
  const msgId = parseInt(req.params.id);
  const { content } = req.body;
  if (!content) return res.status(400).json({ detail: 'Content required' });
  const msg = await dbGet('SELECT * FROM messages WHERE id = ?', [msgId]);
  if (!msg) return res.status(404).json({ detail: 'Message not found' });
  if (msg.sender_id !== req.userId) return res.status(403).json({ detail: 'Can only edit your own messages' });
  await db.execute({ sql: 'UPDATE messages SET content = ?, is_edited = 1 WHERE id = ?', args: [content, msgId] });
  const u = await dbGet('SELECT username, avatar_url FROM users WHERE id = ?', [req.userId]);
  const members = await dbAll('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [msg.conversation_id]);
  const outData = { id: msgId, conversation_id: msg.conversation_id, sender_id: req.userId, content, is_edited: 1, sender_username: u.username, sender_avatar: u.avatar_url };
  const out = JSON.stringify({ type: 'message_edited', data: outData });
  for (const m of members) {
    const conn = connections.get(m.user_id);
    if (conn && conn.readyState === 1) conn.send(out);
  }
  res.json(outData);
});

// SEARCH MESSAGES
app.get('/api/messages/search', auth, async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.status(400).json({ detail: 'Query must be at least 2 characters' });
  const messages = await dbAll(`
    SELECT m.*, u.username as sender_username, u.avatar_url as sender_avatar, c.name as conv_name, c.is_group
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    JOIN conversations c ON m.conversation_id = c.id
    JOIN conversation_members cm ON m.conversation_id = cm.conversation_id
    WHERE cm.user_id = ? AND m.content LIKE ? AND m.is_deleted = 0
    ORDER BY m.created_at DESC LIMIT 50
  `, [req.userId, `%${q}%`]);
  res.json(messages);
});

// BLOCK USER
app.get('/api/users/blocked', auth, async (req, res) => {
  const blocked = await dbAll(`
    SELECT u.id, u.username, u.avatar_url FROM blocked_users b
    JOIN users u ON b.blocked_id = u.id
    WHERE b.blocker_id = ?
  `, [req.userId]);
  res.json(blocked);
});

app.post('/api/users/block/:id', auth, async (req, res) => {
  const blockedId = parseInt(req.params.id);
  if (blockedId === req.userId) return res.status(400).json({ detail: 'Cannot block yourself' });
  const user = await dbGet('SELECT id FROM users WHERE id = ?', [blockedId]);
  if (!user) return res.status(404).json({ detail: 'User not found' });
  try {
    await dbRun('INSERT INTO blocked_users (blocker_id, blocked_id) VALUES (?, ?)', [req.userId, blockedId]);
  } catch {}
  res.json({ message: 'User blocked' });
});

app.delete('/api/users/block/:id', auth, async (req, res) => {
  const blockedId = parseInt(req.params.id);
  await db.execute({ sql: 'DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?', args: [req.userId, blockedId] });
  res.json({ message: 'User unblocked' });
});

// USER STATUS
app.put('/api/users/me/status', auth, async (req, res) => {
  const { status } = req.body;
  await db.execute({ sql: 'UPDATE users SET user_status = ? WHERE id = ?', args: [status || null, req.userId] });
  res.json({ user_status: status || null });
});

// UPLOAD
app.post('/api/upload/avatar', auth, async (req, res) => {
  const { avatar_base64 } = req.body;
  if (!avatar_base64) return res.status(400).json({ detail: 'No avatar data' });
  await db.execute({ sql: 'UPDATE users SET avatar_url = ? WHERE id = ?', args: [avatar_base64, req.userId] });
  res.json({ url: avatar_base64 });
});

app.post('/api/upload/media', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ detail: 'No file' });
  const ext = req.file.originalname.split('.').pop().toLowerCase();
  let type = 'files';
  if (['jpg','jpeg','png','gif','webp'].includes(ext)) type = 'images';
  else if (['mp4','webm','mov'].includes(ext)) type = 'videos';
  else if (['mp3','ogg','wav'].includes(ext)) type = 'voices';
  res.json({ url: `/uploads/${type}/${req.file.filename}`, file_name: req.file.originalname });
});

// WEBSOCKET
const connections = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  let userId;
  try { userId = jwt.verify(token, JWT_SECRET).userId; } catch { ws.close(); return; }

  connections.set(userId, ws);
  db.execute({ sql: "UPDATE users SET is_online = 1, last_seen = datetime('now') WHERE id = ?", args: [userId] });

  broadcastOnlineStatus(userId, '1');

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'message') {
        let convId = msg.conversation_id;
        if (!convId && msg.receiver_id) convId = await getConversationId(userId, msg.receiver_id);
        if (!convId) return;
        const id = await dbRun('INSERT INTO messages (conversation_id, sender_id, content, message_type, media_url, file_name, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [convId, userId, msg.content || null, msg.message_type || 'text', msg.media_url || null, msg.file_name || null, msg.reply_to_id || null]);
        const u = await dbGet('SELECT username, avatar_url FROM users WHERE id = ?', [userId]);
        let replyTo = null;
        if (msg.reply_to_id) {
          replyTo = await dbGet('SELECT m.id, m.content, m.message_type, m.file_name, u.username as sender_username FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?', [msg.reply_to_id]);
        }
        const msgData = { id, conversation_id: convId, sender_id: userId, receiver_id: msg.receiver_id, content: msg.content, message_type: msg.message_type || 'text', media_url: msg.media_url, file_name: msg.file_name, reply_to_id: msg.reply_to_id || null, reply_to: replyTo, created_at: new Date().toISOString(), sender_username: u.username, sender_avatar: u.avatar_url };
        const out = JSON.stringify({ type: 'new_message', data: msgData });
        ws.send(out);
        const members = await dbAll('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [convId]);
        for (const m of members) {
          if (m.user_id !== userId) {
            const conn = connections.get(m.user_id);
            if (conn && conn.readyState === 1) conn.send(out);
          }
        }
      } else if (msg.type === 'message_deleted') {
        const members = await dbAll('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [msg.conversation_id]);
        const out = JSON.stringify({ type: 'message_deleted', data: { id: msg.id, conversation_id: msg.conversation_id } });
        for (const m of members) {
          const conn = connections.get(m.user_id);
          if (conn && conn.readyState === 1) conn.send(out);
        }
      } else if (msg.type === 'typing') {
        const members = await dbAll('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [msg.conversation_id]);
        const u = await dbGet('SELECT username FROM users WHERE id = ?', [userId]);
        for (const m of members) {
          if (m.user_id !== userId) {
            const conn = connections.get(m.user_id);
            if (conn && conn.readyState === 1) conn.send(JSON.stringify({ type: 'typing', data: { conversation_id: msg.conversation_id, user_id: userId, username: u.username } }));
          }
        }
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (['call_offer', 'call_answer', 'call_ice', 'call_end'].includes(msg.type)) {
        const r = connections.get(msg.receiver_id);
        if (r && r.readyState === 1) {
          const { type, receiver_id, ...rest } = msg;
          r.send(JSON.stringify({ type: msg.type, data: { ...rest, caller_id: userId } }));
        }
      } else if (msg.type === 'message_edited') {
        const members = await dbAll('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [msg.conversation_id]);
        const out = JSON.stringify({ type: 'message_edited', data: { id: msg.id, conversation_id: msg.conversation_id, content: msg.content } });
        for (const m of members) {
          const conn = connections.get(m.user_id);
          if (conn && conn.readyState === 1) conn.send(out);
        }
      }
    } catch (e) { console.error('WS error:', e); }
  });

  ws.on('close', () => {
    connections.delete(userId);
    db.execute({ sql: "UPDATE users SET is_online = 0, last_seen = datetime('now') WHERE id = ?", args: [userId] });
    broadcastOnlineStatus(userId, '0');
  });
});

async function broadcastOnlineStatus(userId, status) {
  const friends = await dbAll("SELECT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as friend_id FROM friendships WHERE status = 'accepted' AND (sender_id = ? OR receiver_id = ?)", [userId, userId, userId]);
  const u = await dbGet('SELECT username, avatar_url, last_seen FROM users WHERE id = ?', [userId]);
  for (const f of friends) {
    const conn = connections.get(f.friend_id);
    if (conn && conn.readyState === 1) {
      conn.send(JSON.stringify({ type: 'online_status', data: { user_id: userId, is_online: status, username: u.username, avatar_url: u.avatar_url, last_seen: u.last_seen } }));
    }
  }
}

// KEEP-ALIVE PING
app.get('/api/ping', (req, res) => res.json({ status: 'ok' }));

// RESET DATABASE
app.post('/api/reset', async (req, res) => {
  if (req.headers['x-reset-key'] !== 'mixed-messenger-reset-2026') return res.status(403).json({ detail: 'Forbidden' });
  await db.execute({ sql: 'DROP TABLE IF EXISTS message_read_status', args: [] });
  await db.execute({ sql: 'DROP TABLE IF EXISTS message_reactions', args: [] });
  await db.execute({ sql: 'DROP TABLE IF EXISTS messages', args: [] });
  await db.execute({ sql: 'DROP TABLE IF EXISTS conversation_members', args: [] });
  await db.execute({ sql: 'DROP TABLE IF EXISTS conversations', args: [] });
  await db.execute({ sql: 'DROP TABLE IF EXISTS friendships', args: [] });
  await db.execute({ sql: 'DROP TABLE IF EXISTS verification_codes', args: [] });
  await db.execute({ sql: 'DROP TABLE IF EXISTS blocked_users', args: [] });
  await db.execute({ sql: 'DROP TABLE IF EXISTS users', args: [] });
  await initDB();
  res.json({ message: 'Database reset completely' });
});

initDB().then(() => {
  server.listen(PORT, () => console.log(`Mixed Messenger API running on port ${PORT}`));
});
