require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const rateLimit= require('express-rate-limit');
const path     = require('path');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { Pool } = require('pg');
const multer   = require('multer');
const crypto   = require('crypto');
const fs       = require('fs');

// ── DB ───────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
const db = (text, params) => pool.query(text, params);

// ── APP ──────────────────────────────────────────────────────
const app = express();

// Railway / Vercel passent par un proxy — obligatoire pour que rate-limit fonctionne
app.set('trust proxy', 1);

app.use(cors({ origin: true, credentials: true }));
app.options('*', cors());
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(rateLimit({ windowMs: 15*60*1000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Uploads
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(path.resolve(uploadDir)));
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + path.extname(file.originalname))
  }),
  fileFilter: (req, file, cb) => {
    const ok = ['.jpg','.jpeg','.png','.webp'].includes(path.extname(file.originalname).toLowerCase());
    cb(null, ok);
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ── HELPERS ──────────────────────────────────────────────────
function makeToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET || 'dev_secret_change_me', { expiresIn: '7d' });
}
function safe(u) { const { password_hash, ...r } = u; return r; }

async function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requis' });
  try {
    const d = jwt.verify(h.slice(7), process.env.JWT_SECRET || 'dev_secret_change_me');
    const { rows } = await db('SELECT * FROM users WHERE id=$1', [d.id]);
    if (!rows.length || rows[0].is_banned) return res.status(401).json({ error: 'Non autorisé' });
    req.user = rows[0]; next();
  } catch { res.status(401).json({ error: 'Token invalide' }); }
}
async function optionalAuth(req, res, next) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    try {
      const d = jwt.verify(h.slice(7), process.env.JWT_SECRET || 'dev_secret_change_me');
      const { rows } = await db('SELECT * FROM users WHERE id=$1', [d.id]);
      if (rows.length && !rows[0].is_banned) req.user = rows[0];
    } catch {}
  }
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  next();
}
async function awardCoins(userId, amount, type, desc, refId = null) {
  if (amount <= 0) return;
  await db('UPDATE users SET coins=coins+$1 WHERE id=$2', [amount, userId]);
  await db('INSERT INTO coin_transactions(user_id,type,amount,description,reference_id) VALUES($1,$2,$3,$4,$5)',
    [userId, type, amount, desc, refId]);
}
async function updateBadge(userId) {
  const { rows } = await db('SELECT coins FROM users WHERE id=$1', [userId]);
  if (!rows.length) return;
  const c = rows[0].coins;
  const badge = c>=5000?'Légende':c>=2000?'Héros':c>=1000?'Expert':c>=500?'Actif':c>=200?'Engagé':'Membre';
  await db('UPDATE users SET badge=$1 WHERE id=$2', [badge, userId]);
}

// ══════════════════════════════════════
//  ROUTES AUTH
// ══════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  try {
    const { fullName, email, password } = req.body;
    if (!fullName||!email||!password) return res.status(400).json({ error: 'Tous les champs sont requis' });
    if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (min 8 caractères)' });
    const exists = await db('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(409).json({ error: 'Email déjà utilisé' });
    const hash = await bcrypt.hash(password, 12);
    const isAdmin = email.toLowerCase() === (process.env.ADMIN_EMAIL||'').toLowerCase();
    const { rows } = await db(
      `INSERT INTO users(full_name,email,password_hash,role,coins) VALUES($1,$2,$3,$4,0) RETURNING *`,
      [fullName.trim(), email.toLowerCase(), hash, isAdmin?'admin':'user']
    );
    const welcomeCoins = parseInt(process.env.COINS_WELCOME)||100;
    await awardCoins(rows[0].id, welcomeCoins, 'welcome', 'Bonus de bienvenue');
    await updateBadge(rows[0].id);
    const { rows: u } = await db('SELECT * FROM users WHERE id=$1', [rows[0].id]);
    res.status(201).json({ token: makeToken(u[0]), user: safe(u[0]) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email||!password) return res.status(400).json({ error: 'Email et mot de passe requis' });
    const { rows } = await db('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Identifiants incorrects' });
    if (rows[0].is_banned) return res.status(403).json({ error: 'Compte banni' });
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Identifiants incorrects' });
    res.json({ token: makeToken(rows[0]), user: safe(rows[0]) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const { rows } = await db('SELECT * FROM users WHERE id=$1', [req.user.id]);
  res.json({ user: safe(rows[0]) });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const { rows } = await db('SELECT * FROM users WHERE email=$1', [email?.toLowerCase()]);
    if (!rows.length) return res.json({ message: 'Si cet email existe, un lien a été envoyé.' });
    const token = crypto.randomBytes(32).toString('hex');
    await db(`INSERT INTO password_resets(user_id,token,expires_at) VALUES($1,$2,$3)`,
      [rows[0].id, token, new Date(Date.now()+3600000)]);
    // Email optionnel
    res.json({ message: 'Si cet email existe, un lien a été envoyé.' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token||!password||password.length<8) return res.status(400).json({ error: 'Données invalides' });
    const { rows } = await db(`SELECT * FROM password_resets WHERE token=$1 AND expires_at>NOW() AND used=false`, [token]);
    if (!rows.length) return res.status(400).json({ error: 'Lien invalide ou expiré' });
    const hash = await bcrypt.hash(password, 12);
    await db('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, rows[0].user_id]);
    await db('UPDATE password_resets SET used=true WHERE id=$1', [rows[0].id]);
    res.json({ message: 'Mot de passe mis à jour.' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════
//  ROUTES POSTS
// ══════════════════════════════════════
app.get('/api/posts', optionalAuth, async (req, res) => {
  try {
    const { page=1, limit=10, status, urgency, search, userId } = req.query;
    const offset = (page-1)*limit;
    const conds = ['p.is_active=true'], params = [];
    let i = 1;
    if (status)  { conds.push(`p.status=$${i++}`);   params.push(status); }
    if (urgency) { conds.push(`p.urgency=$${i++}`);  params.push(urgency); }
    if (userId)  { conds.push(`p.user_id=$${i++}`);  params.push(userId); }
    if (search)  { conds.push(`(p.person_name ILIKE $${i} OR p.last_seen ILIKE $${i} OR p.description ILIKE $${i})`); params.push(`%${search}%`); i++; }
    const where = conds.join(' AND ');
    const uid = req.user?.id;
    const total = parseInt((await db(`SELECT COUNT(*) FROM posts p WHERE ${where}`, params)).rows[0].count);
    const { rows } = await db(`
      SELECT p.*, u.full_name AS poster_name, u.avatar_url AS poster_avatar, u.city AS poster_city, u.id AS poster_id, u.badge AS poster_badge,
        ${uid?`(SELECT COUNT(*)>0 FROM likes WHERE user_id='${uid}' AND post_id=p.id) AS user_liked,
               (SELECT COUNT(*)>0 FROM reposts WHERE user_id='${uid}' AND post_id=p.id) AS user_reposted,`
             :'false AS user_liked, false AS user_reposted,'}
        p.reward_coins
      FROM posts p JOIN users u ON p.user_id=u.id
      WHERE ${where} ORDER BY p.created_at DESC LIMIT $${i} OFFSET $${i+1}
    `, [...params, limit, offset]);
    res.json({ posts: rows, total, pages: Math.ceil(total/limit), page: parseInt(page) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/posts/:id', optionalAuth, async (req, res) => {
  try {
    const uid = req.user?.id;
    const { rows } = await db(`
      SELECT p.*, u.full_name AS poster_name, u.avatar_url AS poster_avatar, u.city AS poster_city, u.id AS poster_id, u.badge AS poster_badge,
        ${uid?`(SELECT COUNT(*)>0 FROM likes WHERE user_id='${uid}' AND post_id=p.id) AS user_liked,
               (SELECT COUNT(*)>0 FROM reposts WHERE user_id='${uid}' AND post_id=p.id) AS user_reposted,`
             :'false AS user_liked, false AS user_reposted,'}
        p.reward_coins
      FROM posts p JOIN users u ON p.user_id=u.id WHERE p.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Publication introuvable' });
    await db('UPDATE posts SET views_count=views_count+1 WHERE id=$1', [req.params.id]);
    res.json({ post: rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/posts', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { personName, personAge, personGender, lastSeen, lastSeenDate, description, contactPhone, contactEmail, urgency, rewardCoins } = req.body;
    if (!personName||!lastSeen||!description) return res.status(400).json({ error: 'Nom, localisation et description requis' });
    const base = process.env.BACKEND_URL || `https://${req.headers.host}`;
    const photoUrl = req.file ? `${base}/uploads/${req.file.filename}` : null;
    const reward = Math.max(0, parseInt(rewardCoins)||0);
    if (reward > 0) {
      const { rows: u } = await db('SELECT coins FROM users WHERE id=$1', [req.user.id]);
      if (!u.length||u[0].coins<reward) return res.status(400).json({ error: 'Coins insuffisants' });
      await db('UPDATE users SET coins=coins-$1 WHERE id=$2', [reward, req.user.id]);
    }
    const { rows } = await db(
      `INSERT INTO posts(user_id,person_name,person_age,person_gender,last_seen,last_seen_date,description,photo_url,contact_phone,contact_email,urgency,reward_coins)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.user.id, personName.trim(), personAge||null, personGender||null, lastSeen, lastSeenDate||null, description, photoUrl, contactPhone||null, contactEmail||null, urgency||'normal', reward]
    );
    const coinsEarned = parseInt(process.env.COINS_PER_POST)||20;
    await awardCoins(req.user.id, coinsEarned, 'post_created', `Publication: ${personName}`, rows[0].id);
    await updateBadge(req.user.id);
    res.status(201).json({ post: rows[0], coinsEarned });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/posts/:id', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { rows } = await db('SELECT * FROM posts WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Introuvable' });
    if (rows[0].user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Non autorisé' });
    const p = rows[0];
    const { personName, personAge, personGender, lastSeen, lastSeenDate, description, contactPhone, contactEmail, urgency, status } = req.body;
    const base2 = process.env.BACKEND_URL || `https://${req.headers.host}`;
    const photoUrl = req.file ? `${base2}/uploads/${req.file.filename}` : p.photo_url;
    if (status === 'found' && p.status !== 'found' && p.reward_coins > 0) {
      await awardCoins(p.user_id, p.reward_coins, 'found_reward', `${p.person_name} retrouvé(e)`, p.id);
      await updateBadge(p.user_id);
      const { rows: sharers } = await db('SELECT DISTINCT user_id FROM reposts WHERE post_id=$1 AND user_id!=$2', [p.id, p.user_id]);
      for (const s of sharers) { await awardCoins(s.user_id, Math.floor(p.reward_coins/2), 'found_reward_sharer', `Aide pour ${p.person_name}`, p.id); }
    }
    const { rows: updated } = await db(
      `UPDATE posts SET person_name=COALESCE($1,person_name), person_age=$2, person_gender=$3,
        last_seen=COALESCE($4,last_seen), last_seen_date=$5, description=COALESCE($6,description),
        photo_url=$7, contact_phone=$8, contact_email=$9, urgency=COALESCE($10,urgency),
        status=COALESCE($11,status), updated_at=NOW() WHERE id=$12 RETURNING *`,
      [personName, personAge||null, personGender||null, lastSeen, lastSeenDate||null, description, photoUrl, contactPhone||null, contactEmail||null, urgency, status, req.params.id]
    );
    res.json({ post: updated[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/posts/:id', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db('SELECT * FROM posts WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Introuvable' });
    if (rows[0].user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Non autorisé' });
    await db('DELETE FROM posts WHERE id=$1', [req.params.id]);
    res.json({ message: 'Supprimé' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/posts/:id/like', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db('SELECT id FROM likes WHERE user_id=$1 AND post_id=$2', [req.user.id, req.params.id]);
    if (rows.length) {
      await db('DELETE FROM likes WHERE user_id=$1 AND post_id=$2', [req.user.id, req.params.id]);
      await db('UPDATE posts SET likes_count=GREATEST(0,likes_count-1) WHERE id=$1', [req.params.id]);
      res.json({ liked: false });
    } else {
      await db('INSERT INTO likes(user_id,post_id) VALUES($1,$2)', [req.user.id, req.params.id]);
      await db('UPDATE posts SET likes_count=likes_count+1 WHERE id=$1', [req.params.id]);
      res.json({ liked: true });
    }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/posts/:id/repost', authMiddleware, async (req, res) => {
  try {
    const { rows: pRows } = await db('SELECT * FROM posts WHERE id=$1', [req.params.id]);
    if (!pRows.length) return res.status(404).json({ error: 'Introuvable' });
    const post = pRows[0];
    if (post.user_id === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas repartager votre propre publication' });
    const originalPostId = post.original_post_id || post.id;
    const existing = await db('SELECT id FROM reposts WHERE user_id=$1 AND post_id=$2', [req.user.id, req.params.id]);
    if (existing.rows.length) {
      await db('DELETE FROM reposts WHERE user_id=$1 AND post_id=$2', [req.user.id, req.params.id]);
      await db('UPDATE posts SET reposts_count=GREATEST(0,reposts_count-1) WHERE id=$1', [req.params.id]);
      return res.json({ reposted: false });
    }
    await db('INSERT INTO reposts(user_id,post_id,original_post_id) VALUES($1,$2,$3)', [req.user.id, req.params.id, originalPostId]);
    await db('UPDATE posts SET reposts_count=reposts_count+1 WHERE id=$1', [req.params.id]);
    const coins = parseInt(process.env.COINS_PER_REPOST)||10;
    await awardCoins(req.user.id, coins, 'repost', `Repartage: ${post.person_name}`, req.params.id);
    await updateBadge(req.user.id);
    res.json({ reposted: true, coinsEarned: coins, originalPostId });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/posts/:id/share', authMiddleware, async (req, res) => {
  try {
    const { platform } = req.body;
    const { rows } = await db('SELECT person_name FROM posts WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Introuvable' });
    await db('INSERT INTO shares(user_id,post_id,platform) VALUES($1,$2,$3)', [req.user.id, req.params.id, platform||'external']);
    await db('UPDATE posts SET shares_count=shares_count+1 WHERE id=$1', [req.params.id]);
    const coins = parseInt(process.env.COINS_PER_SHARE)||5;
    await awardCoins(req.user.id, coins, 'share', `Partage: ${rows[0].person_name}`, req.params.id);
    res.json({ coinsEarned: coins });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/posts/:id/found', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db('SELECT * FROM posts WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Introuvable' });
    if (rows[0].user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Non autorisé' });
    if (rows[0].status === 'found') return res.status(400).json({ error: 'Déjà retrouvé' });
    await db(`UPDATE posts SET status='found', is_active=false, updated_at=NOW() WHERE id=$1`, [req.params.id]);
    const coins = parseInt(process.env.COINS_PER_FOUND)||200;
    await awardCoins(rows[0].user_id, coins, 'found_reward', `${rows[0].person_name} retrouvé(e)`, rows[0].id);
    const { rows: sharers } = await db('SELECT DISTINCT user_id FROM reposts WHERE post_id=$1 AND user_id!=$2', [rows[0].id, rows[0].user_id]);
    for (const s of sharers) { await awardCoins(s.user_id, Math.floor(coins/2), 'found_reward_sharer', `Aide: ${rows[0].person_name}`, rows[0].id); }
    res.json({ message: 'Marqué comme retrouvé' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════
//  ROUTES USERS
// ══════════════════════════════════════
app.get('/api/users/admin/list', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db(`SELECT id,full_name,email,phone,city,role,coins,badge,is_verified,is_banned,ban_reason,created_at FROM users ORDER BY created_at DESC LIMIT 100`);
    res.json({ users: rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/users/admin/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { fullName, email, role, city, isBanned, banReason } = req.body;
    await db(`UPDATE users SET full_name=COALESCE($1,full_name), role=COALESCE($2,role), city=$3, is_banned=$4, ban_reason=$5, updated_at=NOW() WHERE id=$6`,
      [fullName, role, city, isBanned||false, banReason||null, req.params.id]);
    res.json({ message: 'Mis à jour' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/admin/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer son propre compte admin' });
    await db('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ message: 'Supprimé' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/users/me/coins', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db('SELECT * FROM coin_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    const { rows: u } = await db('SELECT coins FROM users WHERE id=$1', [req.user.id]);
    res.json({ transactions: rows, balance: u[0]?.coins||0 });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/users/me', authMiddleware, upload.single('avatar'), async (req, res) => {
  try {
    const { fullName, city, bio } = req.body;
    const baseAv = process.env.BACKEND_URL || `https://${req.headers.host}`;
    const avatarUrl = req.file ? `${baseAv}/uploads/${req.file.filename}` : undefined;
    const sets = ['updated_at=NOW()'], params = [];
    let i = 1;
    if (fullName)            { sets.push(`full_name=$${i++}`);  params.push(fullName.trim()); }
    if (city !== undefined)  { sets.push(`city=$${i++}`);       params.push(city); }
    if (bio !== undefined)   { sets.push(`bio=$${i++}`);        params.push(bio); }
    if (avatarUrl)           { sets.push(`avatar_url=$${i++}`); params.push(avatarUrl); }
    params.push(req.user.id);
    const { rows } = await db(`UPDATE users SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, params);
    res.json({ user: safe(rows[0]) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/users/me/password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword||!newPassword||newPassword.length<8) return res.status(400).json({ error: 'Données invalides' });
    const { rows } = await db('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    await db('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(newPassword,12), req.user.id]);
    res.json({ message: 'Mot de passe mis à jour' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/me', authMiddleware, async (req, res) => {
  try { await db('DELETE FROM users WHERE id=$1', [req.user.id]); res.json({ message: 'Compte supprimé' }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const { rows } = await db(`SELECT id,full_name,avatar_url,city,bio,badge,coins,role,created_at,
      (SELECT COUNT(*) FROM posts WHERE user_id=u.id AND is_active=true) AS posts_count,
      (SELECT COUNT(*) FROM reposts WHERE user_id=u.id) AS reposts_count
      FROM users u WHERE id=$1 AND is_banned=false`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Introuvable' });
    res.json({ user: rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/users/:id/posts', async (req, res) => {
  try {
    const { type='posts' } = req.query;
    let rows;
    if (type === 'reposts') {
      ({ rows } = await db(`SELECT p.*, u.full_name AS poster_name, u.avatar_url AS poster_avatar,
        r.created_at AS reposted_at, op.id AS original_id, ou.full_name AS original_poster_name
        FROM reposts r JOIN posts p ON r.post_id=p.id JOIN users u ON p.user_id=u.id
        LEFT JOIN posts op ON r.original_post_id=op.id LEFT JOIN users ou ON op.user_id=ou.id
        WHERE r.user_id=$1 ORDER BY r.created_at DESC LIMIT 30`, [req.params.id]));
    } else {
      ({ rows } = await db(`SELECT p.*, u.full_name AS poster_name FROM posts p JOIN users u ON p.user_id=u.id
        WHERE p.user_id=$1 AND p.is_active=true ORDER BY p.created_at DESC LIMIT 30`, [req.params.id]));
    }
    res.json({ posts: rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════
//  COMMENTS
// ══════════════════════════════════════
app.get('/api/comments/:postId/comments', async (req, res) => {
  try {
    const { rows } = await db(`SELECT c.*,u.full_name,u.avatar_url,u.badge FROM comments c JOIN users u ON c.user_id=u.id WHERE c.post_id=$1 ORDER BY c.created_at ASC`, [req.params.postId]);
    res.json({ comments: rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/comments/:postId/comments', authMiddleware, async (req, res) => {
  try {
    const { content, isWitness } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Commentaire vide' });
    const { rows } = await db(`INSERT INTO comments(user_id,post_id,content,is_witness) VALUES($1,$2,$3,$4) RETURNING *`,
      [req.user.id, req.params.postId, content.trim(), isWitness||false]);
    await db('UPDATE posts SET comments_count=comments_count+1 WHERE id=$1', [req.params.postId]);
    if (isWitness) { await awardCoins(req.user.id, parseInt(process.env.COINS_PER_WITNESS)||50, 'witness', 'Témoignage', rows[0].id); }
    const { rows: full } = await db(`SELECT c.*,u.full_name,u.avatar_url,u.badge FROM comments c JOIN users u ON c.user_id=u.id WHERE c.id=$1`, [rows[0].id]);
    res.status(201).json({ comment: full[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/comments/comment/:id', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db('SELECT * FROM comments WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Introuvable' });
    if (rows[0].user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Non autorisé' });
    await db('DELETE FROM comments WHERE id=$1', [req.params.id]);
    await db('UPDATE posts SET comments_count=GREATEST(0,comments_count-1) WHERE id=$1', [rows[0].post_id]);
    res.json({ message: 'Supprimé' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════
//  MESSAGES
// ══════════════════════════════════════
app.get('/api/messages/conversations', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db(`
      SELECT DISTINCT ON (other_user)
        CASE WHEN m.sender_id=$1 THEN m.receiver_id ELSE m.sender_id END AS other_user,
        m.content AS last_message, m.created_at AS last_message_at,
        u.full_name, u.avatar_url, u.badge,
        (SELECT COUNT(*) FROM messages WHERE sender_id=CASE WHEN m.sender_id=$1 THEN m.receiver_id ELSE m.sender_id END AND receiver_id=$1 AND is_read=false) AS unread_count
      FROM messages m
      JOIN users u ON u.id=CASE WHEN m.sender_id=$1 THEN m.receiver_id ELSE m.sender_id END
      WHERE m.sender_id=$1 OR m.receiver_id=$1
      ORDER BY other_user, m.created_at DESC`, [req.user.id]);
    res.json({ conversations: rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/messages/:userId', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db(`SELECT m.*,s.full_name AS sender_name,s.avatar_url AS sender_avatar
      FROM messages m JOIN users s ON m.sender_id=s.id
      WHERE (m.sender_id=$1 AND m.receiver_id=$2) OR (m.sender_id=$2 AND m.receiver_id=$1)
      ORDER BY m.created_at ASC LIMIT 100`, [req.user.id, req.params.userId]);
    await db(`UPDATE messages SET is_read=true WHERE sender_id=$1 AND receiver_id=$2 AND is_read=false`, [req.params.userId, req.user.id]);
    res.json({ messages: rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/messages', authMiddleware, async (req, res) => {
  try {
    const { receiverId, content } = req.body;
    if (!receiverId||!content?.trim()) return res.status(400).json({ error: 'Destinataire et contenu requis' });
    if (receiverId === req.user.id) return res.status(400).json({ error: 'Impossible de s\'envoyer un message' });
    const { rows } = await db(`INSERT INTO messages(sender_id,receiver_id,content) VALUES($1,$2,$3) RETURNING *`, [req.user.id, receiverId, content.trim()]);
    res.status(201).json({ message: rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════
//  NOTIFICATIONS
// ══════════════════════════════════════
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db(`SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.user.id]);
    res.json({ notifications: rows, unread: rows.filter(n=>!n.is_read).length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    await db(`UPDATE notifications SET is_read=true WHERE user_id=$1`, [req.user.id]);
    res.json({ message: 'Toutes lues' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════
//  PAYMENTS
// ══════════════════════════════════════
app.post('/api/payments/initiate', authMiddleware, async (req, res) => {
  try {
    const { amountXaf, postId, phone, provider } = req.body;
    if (!amountXaf||amountXaf<100) return res.status(400).json({ error: 'Montant minimum 100 XAF' });
    const coinVal = parseFloat(process.env.COIN_VALUE_XAF)||1;
    const coins = Math.floor(amountXaf/coinVal);
    const { rows: tx } = await db(`INSERT INTO payment_transactions(user_id,type,amount_xaf,coins,status,phone,provider,post_id) VALUES($1,'deposit',$2,$3,'pending',$4,$5,$6) RETURNING id`,
      [req.user.id, amountXaf, coins, phone||null, provider||'orange', postId||null]);
    // Mode dev : simulation automatique
    if (!process.env.FAPSHI_API_KEY || process.env.NODE_ENV !== 'production') {
      await db(`UPDATE payment_transactions SET status='success' WHERE id=$1`, [tx[0].id]);
      await awardCoins(req.user.id, coins, 'purchase', `Achat ${coins} coins (${amountXaf} XAF)`, tx[0].id);
      if (postId) await db('UPDATE posts SET reward_coins=reward_coins+$1 WHERE id=$2', [coins, postId]);
      return res.json({ success: true, devMode: true, coins, amountXaf, message: `${coins} coins crédités` });
    }
    res.json({ txId: tx[0].id, coins, message: 'Transaction initiée' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/payments/webhook', async (req, res) => {
  try {
    const { status, externalId } = req.body;
    if (!externalId) return res.status(400).json({ error: 'Missing externalId' });
    const { rows } = await db('SELECT * FROM payment_transactions WHERE id=$1', [externalId]);
    if (!rows.length||rows[0].status!=='pending') return res.json({ ok: true });
    if (status === 'SUCCESSFUL') {
      await db(`UPDATE payment_transactions SET status='success' WHERE id=$1`, [externalId]);
      await awardCoins(rows[0].user_id, rows[0].coins, 'purchase', `Achat ${rows[0].coins} coins`, externalId);
      if (rows[0].post_id) await db('UPDATE posts SET reward_coins=reward_coins+$1 WHERE id=$2', [rows[0].coins, rows[0].post_id]);
    } else {
      await db(`UPDATE payment_transactions SET status='failed' WHERE id=$1`, [externalId]);
    }
    res.json({ received: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/payments/status/:txId', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db('SELECT * FROM payment_transactions WHERE id=$1 AND user_id=$2', [req.params.txId, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Introuvable' });
    res.json({ transaction: rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/payments/withdraw', authMiddleware, async (req, res) => {
  try {
    const { coins, phone, provider } = req.body;
    const minW = parseInt(process.env.MIN_WITHDRAW_COINS)||500;
    if (!coins||coins<minW) return res.status(400).json({ error: `Minimum ${minW} coins` });
    if (!phone) return res.status(400).json({ error: 'Numéro requis' });
    const { rows: u } = await db('SELECT coins FROM users WHERE id=$1', [req.user.id]);
    if (!u.length||u[0].coins<coins) return res.status(400).json({ error: 'Coins insuffisants' });
    const coinVal = parseFloat(process.env.COIN_VALUE_XAF)||1;
    const amountXaf = Math.floor(coins*coinVal);
    await db('UPDATE users SET coins=coins-$1 WHERE id=$2', [coins, req.user.id]);
    await db(`INSERT INTO coin_transactions(user_id,type,amount,description) VALUES($1,'withdrawal',$2,$3)`,
      [req.user.id, -coins, `Retrait ${coins} coins → ${amountXaf} XAF`]);
    await db(`INSERT INTO payment_transactions(user_id,type,amount_xaf,coins,status,phone,provider) VALUES($1,'withdrawal',$2,$3,'success',$4,$5)`,
      [req.user.id, amountXaf, coins, phone, provider||'orange']);
    res.json({ success: true, amountXaf, coins, message: `${amountXaf} XAF en route sur ${phone}` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/payments/history', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db('SELECT * FROM payment_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    res.json({ transactions: rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await db('SELECT key,value FROM site_settings');
    res.json({ settings: Object.fromEntries(rows.map(r=>[r.key,r.value])) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/settings', authMiddleware, requireAdmin, async (req, res) => {
  try {
    for (const [k,v] of Object.entries(req.body)) {
      await db(`INSERT INTO site_settings(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()`, [k,String(v)]);
    }
    res.json({ message: 'Paramètres mis à jour' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/settings/admin/stats', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const [missing, found, users, todayPosts, payments] = await Promise.all([
      db(`SELECT COUNT(*) FROM posts WHERE status='missing' AND is_active=true`),
      db(`SELECT COUNT(*) FROM posts WHERE status='found' AND created_at>NOW()-INTERVAL '30 days'`),
      db(`SELECT COUNT(*) FROM users WHERE is_banned=false`),
      db(`SELECT COUNT(*) FROM posts WHERE created_at>NOW()-INTERVAL '24 hours'`),
      db(`SELECT COALESCE(SUM(amount_xaf),0) AS total FROM payment_transactions WHERE status='success' AND type='deposit'`),
    ]);
    res.json({
      totalMissing:  parseInt(missing.rows[0].count),
      foundThisMonth:parseInt(found.rows[0].count),
      activeUsers:   parseInt(users.rows[0].count),
      reportsToday:  parseInt(todayPosts.rows[0].count),
      totalRevenue:  parseInt(payments.rows[0].total),
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════
//  HEALTH + 404
// ══════════════════════════════════════
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message });
});

// ══════════════════════════════════════
//  MIGRATIONS INLINE
// ══════════════════════════════════════
async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tables = [
      `CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), full_name VARCHAR(100) NOT NULL, email VARCHAR(150) UNIQUE, phone VARCHAR(20) UNIQUE, password_hash VARCHAR(255), avatar_url TEXT, city VARCHAR(100), bio TEXT, role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user','admin','moderator')), is_verified BOOLEAN DEFAULT false, is_banned BOOLEAN DEFAULT false, ban_reason TEXT, coins INTEGER DEFAULT 0, badge VARCHAR(50) DEFAULT 'Membre', notify_email BOOLEAN DEFAULT true, notify_sms BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS posts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, person_name VARCHAR(100) NOT NULL, person_age INTEGER, person_gender VARCHAR(20), last_seen TEXT NOT NULL, last_seen_date DATE, description TEXT NOT NULL, photo_url TEXT, contact_phone VARCHAR(30), contact_email VARCHAR(150), urgency VARCHAR(20) DEFAULT 'normal' CHECK (urgency IN ('normal','urgent','critical')), status VARCHAR(20) DEFAULT 'missing' CHECK (status IN ('missing','found','closed')), reward_coins INTEGER DEFAULT 0, is_active BOOLEAN DEFAULT true, views_count INTEGER DEFAULT 0, likes_count INTEGER DEFAULT 0, reposts_count INTEGER DEFAULT 0, shares_count INTEGER DEFAULT 0, comments_count INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS reposts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE, original_post_id UUID REFERENCES posts(id) ON DELETE CASCADE, comment TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(user_id, post_id))`,
      `CREATE TABLE IF NOT EXISTS likes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(user_id, post_id))`,
      `CREATE TABLE IF NOT EXISTS shares (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE, platform VARCHAR(50), created_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS comments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE, content TEXT NOT NULL, is_witness BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, receiver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL, is_read BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS notifications (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, type VARCHAR(50) NOT NULL, title VARCHAR(200), body TEXT, data JSONB DEFAULT '{}', is_read BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS coin_transactions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, type VARCHAR(50) NOT NULL, amount INTEGER NOT NULL, description TEXT, reference_id UUID, created_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS payment_transactions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, type VARCHAR(20) NOT NULL CHECK (type IN ('deposit','withdrawal')), amount_xaf INTEGER NOT NULL, coins INTEGER NOT NULL, status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','success','failed','cancelled')), fapshi_ref VARCHAR(100), fapshi_payment_url TEXT, phone VARCHAR(20), provider VARCHAR(20), post_id UUID REFERENCES posts(id) ON DELETE SET NULL, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS site_settings (key VARCHAR(100) PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS password_resets (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, token VARCHAR(100) NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW())`,
    ];
    for (const sql of tables) await client.query(sql);
    const idxs = [
      'CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status)',
      'CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)',
      'CREATE INDEX IF NOT EXISTS idx_notifs_user ON notifications(user_id,is_read)',
      'CREATE INDEX IF NOT EXISTS idx_coin_tx_user ON coin_transactions(user_id)',
    ];
    for (const idx of idxs) await client.query(idx);
    await client.query('COMMIT');
    console.log('✅ Migrations OK');
  } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function createAdmin() {
  const email = process.env.ADMIN_EMAIL || 'admin@wanted.app';
  const pwd   = process.env.ADMIN_PASSWORD || 'Admin@2024!';
  const name  = process.env.ADMIN_NAME || 'Administrateur';
  try {
    const { rows } = await db('SELECT id,role FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!rows.length) {
      await db(`INSERT INTO users(full_name,email,password_hash,role,coins,badge,is_verified) VALUES($1,$2,$3,'admin',500,'Légende',true)`,
        [name, email.toLowerCase(), await bcrypt.hash(pwd,12)]);
      console.log('✅ Admin créé:', email, '/', pwd);
    } else {
      if (rows[0].role !== 'admin') await db(`UPDATE users SET role='admin' WHERE email=$1`, [email.toLowerCase()]);
      console.log('ℹ️  Admin:', email);
    }
  } catch(e) { console.error('⚠️  Admin error:', e.message); }
}

async function ensureSettings() {
  const defs = [['site_name','WANTED'],['coins_per_repost','10'],['coins_per_share','5'],['coins_per_post','20'],['coins_per_witness','50'],['coins_per_found','200'],['coins_welcome','100'],['coin_value_xaf','1'],['min_withdraw_coins','500']];
  for (const [k,v] of defs) await db(`INSERT INTO site_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING`,[k,v]).catch(()=>{});
}

async function start() {
  try {
    await db('SELECT 1');
    console.log('✅ PostgreSQL connecté');
    await runMigrations();
    await createAdmin();
    await ensureSettings();
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`🚀 WANTED API port ${PORT}`));
  } catch(e) { console.error('❌ Démarrage:', e.message); process.exit(1); }
}

start();
