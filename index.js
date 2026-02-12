require('dotenv').config();
const express = require('express');
const session = require('express-session');
const Queue = require('queue-fifo');
const Redis = require('ioredis');
const { Sequelize, Op, DataTypes } = require('sequelize');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const fetch = require('node-fetch')

const { Playlist, Song, User, sequelize } = require('./models');

const COOLDOWN_MS = 30 * 1000; // 30 seconds between updates
const youtubeQueue = new Queue();
const inQueueSet = new Set(); // Track what's already queued
let isWorkerRunning = false;
let dbReady = false;

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function writeCrashLog(type, err, extra = '') {
  try {
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const file = path.join(LOG_DIR, `crash-${stamp}.log`);
    const body = [
      `timestamp=${now.toISOString()}`,
      `type=${type}`,
      `pid=${process.pid}`,
      `node=${process.version}`,
      extra ? `extra=${extra}` : '',
      `message=${err?.message || String(err)}`,
      '',
      (err?.stack || String(err))
    ].filter(Boolean).join('\n');
    fs.writeFileSync(file, body, 'utf8');
    console.error(`[CRASH] Logged to ${file}`);
  } catch (logErr) {
    console.error('[CRASH] Failed to write crash log:', logErr);
  }
}

process.on('uncaughtException', (err) => {
  writeCrashLog('uncaughtException', err);
  // Keeping the process running after an uncaught exception can leave it in a bad state.
  // Default behavior remains "exit", but allow opting out when running without a supervisor.
  if (String(process.env.EXIT_ON_UNCAUGHT_EXCEPTION || 'true').toLowerCase() === 'true') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  writeCrashLog('unhandledRejection', err);
  // Many unhandled rejections here are transient DB connection issues during startup.
  // Do not crash the whole app; log and keep running.
});

const Bottleneck = require('bottleneck');

const limiter = new Bottleneck({
    minTime: 30 * 1000,    // 30 seconds between jobs
    maxConcurrent: 1       // Only one job at a time
});

// Helper to sleep for cooldown
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const app = express();
const PORT = process.env.PORT || 3000;
const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB || 0)
});

function parseCsvList(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function apiCorsMiddleware(req, res, next) {
  const allowOriginsRaw = process.env.CORS_ALLOW_ORIGINS || '*';
  const allowCredentials = String(process.env.CORS_ALLOW_CREDENTIALS || 'false').toLowerCase() === 'true';

  const origin = req.headers.origin;
  let allowOriginHeader = '*';

  if (allowOriginsRaw !== '*') {
    const allowList = parseCsvList(allowOriginsRaw);
    if (origin && allowList.includes(origin)) {
      allowOriginHeader = origin; // reflect allowed origin
      res.setHeader('Vary', 'Origin');
    } else {
      // Not allowed; omit CORS headers so browser blocks it.
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      return next();
    }
  } else if (allowCredentials && origin) {
    // Credentials + wildcard is invalid; reflect request origin instead.
    allowOriginHeader = origin;
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Origin', allowOriginHeader);
  if (allowCredentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] || 'Content-Type, Authorization'
  );
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// Middleware
app.use(express.static('public'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(session({
    secret: process.env.SECRET_KEY,
    resave: false,
    saveUninitialized: false
}));

// Allow cross-domain access to the API routes (fixes CORS errors in browsers).
app.use('/api', apiCorsMiddleware);

const CONFIG_PATH = path.join(__dirname, 'config.json');

function parseYouTubeId(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  // Plain YouTube ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;

  // URL formats: youtube.com/watch?v=... and youtu.be/...
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    if (host.includes('youtu.be')) {
      const id = url.pathname.replace(/^\/+/, '').split('/')[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }

    if (host.includes('youtube.com')) {
      const id = url.searchParams.get('v');
      return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? id : null;
    }
  } catch (err) {
    return null;
  }

  return null;
}

function normalizePushFmUrl(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!url.hostname.toLowerCase().includes('push.fm')) return null;
    return url.toString();
  } catch (err) {
    return null;
  }
}

function loadYtdlpNodes() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (Array.isArray(config.ytdlpnode)) {
        return config.ytdlpnode;
      }
    }
  } catch (err) {
    console.error('[YTDLP] Failed to read config.json:', err.message);
  }

  if (process.env.YTDLP_API) {
    return [{
      url: process.env.YTDLP_API,
      apikey: process.env.YTDLP_API_KEY || ''
    }];
  }

  return [];
}

function buildInfoUrls(nodeUrl, youtubeUrl) {
  const normalized = String(nodeUrl || '').trim().replace(/\/+$/, '');
  if (!normalized) return [];

  if (/\/api\/info$/i.test(normalized) || /\/info$/i.test(normalized)) {
    return [`${normalized}?cache=1&url=${encodeURIComponent(youtubeUrl)}`];
  }

  return [
    `${normalized}/api/info?cache=1&url=${encodeURIComponent(youtubeUrl)}`,
    `${normalized}/info?cache=1&url=${encodeURIComponent(youtubeUrl)}`
  ];
}

// Helper: Try YTDLP nodes in order and parse stats
async function fetchYouTubeStats(youtubeid) {
  const normalizedId = parseYouTubeId(youtubeid);
  if (!normalizedId) {
    return { views: 0, likes: 0 };
  }

  const nodes = loadYtdlpNodes();
  const youtubeUrl = `https://www.youtube.com/watch?v=${normalizedId}`;

  if (!nodes.length) {
    console.error('[YTDLP] No nodes configured. Add ytdlpnode[] in config.json or set YTDLP_API.');
    return { views: 0, likes: 0 };
  }

  for (const node of nodes) {
    const urls = buildInfoUrls(node?.url, youtubeUrl);
    const apikey = String(node?.apikey || '').trim();

    for (const infoUrl of urls) {
      try {
        const headers = { accept: 'application/json' };
        if (apikey) headers.authorization = `Bearer ${apikey}`;

        const res = await fetch(infoUrl, {
          method: 'GET',
          headers,
          redirect: 'follow'
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const raw = await res.text();
        let data;
        try {
          data = JSON.parse(raw);
        } catch (parseErr) {
          throw new Error('Invalid JSON response');
        }

        const views = data.view_count ?? data.views ?? data.stats?.views ?? null;
        const likes = data.like_count ?? data.likes ?? data.stats?.likes ?? null;

        return {
          views: views != null ? String(views) : 0,
          likes: likes != null ? String(likes) : 0,
        };
      } catch (err) {
        console.error(`[YTDLP] Node request failed (${infoUrl}):`, err.message);
      }
    }
  }

  console.error(`[YTDLP] All nodes failed for ${normalizedId}`);
  return { views: 0, likes: 0 };
}

async function enqueueOutdatedSongs() {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000);
    const songs = await Song.findAll({
        where: { updatedAt: { [Op.lt]: cutoff } }
    });

    for (const song of songs) {
        const normalizedId = parseYouTubeId(song.youtubeid);
        if (!normalizedId) {
            continue;
        }

        if (!inQueueSet.has(normalizedId)) {
            youtubeQueue.enqueue(normalizedId);
            inQueueSet.add(normalizedId);
            console.log(`[QUEUE] Enqueued ${song.youtubeid}`);
        }
    }
}


async function processYouTubeID(youtubeid) {
    try {
        console.log(`[WORKER] Processing ${youtubeid}`);

        // Try reading from Redis cache first
        const cached = await redis.get(`ytstats:${youtubeid}`);

        let stats;
        if (cached) {
            // Use cached data
            stats = JSON.parse(cached);
            console.log(`[CACHE] Using cached stats for ${youtubeid}`);
        } else {
            // Cache expired or missing, fetch new stats
            console.log(`[CACHE] Cache miss, fetching fresh stats for ${youtubeid}`);
            stats = await fetchYouTubeStats(youtubeid);
            await redis.set(`ytstats:${youtubeid}`, JSON.stringify(stats), 'EX', 600);
        }

        // Update database regardless (fresh or cached)
        await Song.update({
            views: stats.views,
            likes: stats.likes
        }, { where: { youtubeid } });

        console.log(`[WORKER] Done: ${youtubeid}`);
    } catch (err) {
        console.error(`[WORKER] Error processing ${youtubeid}:`, err);
    } finally {
        inQueueSet.delete(youtubeid); // Allow requeueing in future
    }
}


function feedLimiter() {
    if (!youtubeQueue.isEmpty()) {
        const youtubeid = youtubeQueue.dequeue();
        limiter.schedule(() => processYouTubeID(youtubeid));
    }
}

// Background updater to sync stats into database every minute
async function updateAllStatsInBackground() {
    try {
        const cutoff = new Date(Date.now() - 10 * 60 * 1000); // 12 hours ago
        const songs = await Song.findAll({
            where: {
                updatedAt: { [Op.lt]: cutoff }
            }
        });
        for (const song of songs) {
            const stats = await fetchYouTubeStats(song.youtubeid);
            await redis.set(`ytstats:${song.youtubeid}`, JSON.stringify(stats), 'EX', 60);
            await Song.update({ views: stats.views, likes: stats.likes }, { where: { youtubeid: song.youtubeid } });
            console.log(`[${new Date().toISOString()}] Updated stats for ${song.youtubeid}. Waiting ${COOLDOWN_MS / 1000}s...`);
            await sleep(COOLDOWN_MS);
        }
    } catch (err) {
        console.error('Background stats update failed:', err);
    }
}

setInterval(enqueueOutdatedSongs, 60 * 1000);
setInterval(feedLimiter, 5000);

app.get('/', async (req, res) => {
    const playlists = await Playlist.findAll({
        include: {
            model: Song,
            as: 'Songs'
        }
    });
    res.render('index', { playlists }); // assuming index.ejs is in views/
});

app.get('/mediaplayer', async (req, res) => {
    res.render('mediaplayer'); // assuming index.ejs is in views/
});

// Admin Auth Middleware
async function isAuthenticated(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  const user = await User.findByPk(req.session.userId);

  if (user.status === 'suspended') {
    return res.status(403).send('Account suspended');
  }
  if (user.status === 'banned') {
    req.session.destroy(() => res.redirect('/login'));
    return;
  }

  req.user = user;
  next();
}

async function isAdmin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');

  const user = await User.findByPk(req.session.userId);
  if (user && user.role === 'admin') {
    req.user = user;
    return next();
  }
  res.status(403).send('Admins only');
}

async function enforceActiveUser(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  const user = await User.findByPk(req.session.userId);

  if (user.status === 'suspended') {
    return res.status(403).send('Account suspended');
  }
  if (user.status === 'banned') {
    req.session.destroy(() => res.redirect('/login'));
    return;
  }

  req.user = user;
  next();
}

// Replace:
app.get('/login', (req, res) => {
    res.render('login');
});

app.get('/user', isAuthenticated, async (req, res) => {
    const playlists = await Playlist.findAll({
      where: { userId: req.user.id },   // only user’s playlists
      include: [{ model: Song, as: 'Songs' }]
    });
    res.render('user', { playlists });         // pass to EJS view
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ where: { username } });
    if (user && await bcrypt.compare(password, user.passwordHash)) {
        req.session.userId = user.id;
        res.redirect('/user');
    } else {
        res.send('Invalid credentials');
    }
});

app.post('/user/add-song', isAuthenticated, async (req, res) => {
  const { Artist, title, cover, youtubeid, pushfmurl, playlist } = req.body;

  try {
    const playlistRecord = await Playlist.findOne({ where: { name: playlist } });
    if (!playlistRecord) {
      return res.status(400).send('Playlist not found');
    }

    const normalizedYouTubeId = parseYouTubeId(youtubeid);
    if (!normalizedYouTubeId) {
      return res.status(400).send('Valid YouTube ID or URL is required');
    }
    const normalizedPushFmUrl = normalizePushFmUrl(pushfmurl);
    if (String(pushfmurl || '').trim() && !normalizedPushFmUrl) {
      return res.status(400).send('Push.fm URL is invalid');
    }

    await Song.create({
      Artist,
      title,
      cover,
      youtubeid: normalizedYouTubeId,
      pushfmurl: normalizedPushFmUrl,
      playlistId: playlistRecord.id
    });

    res.redirect('/user');
  } catch (err) {
    console.error('Error adding song:', err);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/user/delete-song', isAuthenticated, async (req, res) => {
    await Song.destroy({ where: { youtubeid: req.body.youtubeid } });
    res.redirect('/user');
});

app.post('/user/add-playlist', isAuthenticated, async (req, res) => {
  try {
    const { name, cover } = req.body;

    await Playlist.create({
      name,
      cover,
      userId: req.user.id   // link to the current user
    });

    res.redirect('/user');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating playlist');
  }
});

app.post('/user/delete-playlist', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.body; // safer to use id, not name

    // Ensure playlist belongs to logged-in user
    const deleted = await Playlist.destroy({
      where: {
        id,
        userId: req.user.id
      }
    });

    if (!deleted) {
      return res.status(403).send('Not allowed');
    }

    res.redirect('/user');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting playlist');
  }
});


app.get('/user/playlists', isAuthenticated, async (req, res) => {
  try {
    const playlists = await Playlist.findAll({
      where: { userId: req.user.id },   // only user’s playlists
      include: [{ model: Song, as: 'Songs' }]
    });

    res.json(playlists);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching playlists');
  }
});

app.post('/user/update-password', isAuthenticated, async (req, res) => {
  try {
    const { newPassword } = req.body;

    const hash = await bcrypt.hash(newPassword, 10);
    await User.update(
      { passwordHash: hash },
      { where: { id: req.user.id } }
    );

    res.redirect('/user'); // or success page
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating password');
  }
});

// API Endpoint
app.get('/api/playlists', async (req, res) => {
    if (!dbReady) {
        return res.status(503).json({ error: 'Database not ready' });
    }
    const playlists = await Playlist.findAll({
        include: {
            model: Song,
            as: 'Songs'
        }
    });

    const formatted = playlists.map(playlist => ({
        name: playlist.name,
        cover: playlist.cover,
        Songs: playlist.Songs.map(song => ({
            sourceType: 'youtube',
            sourceUrl: `https://www.youtube.com/watch?v=${song.youtubeid}`,
            pushfmurl: song.pushfmurl || null,
            Artist: song.Artist,
            title: song.title,
            cover: song.cover,
            youtubeid: song.youtubeid,
            views: song.views,
            likes: song.likes,
            createdAt: song.createdAt
        }))
    }));

    res.json({ playlists: formatted });

});

// Admin dashboard
app.get('/admin', isAdmin, async (req, res) => {
  const users = await User.findAll();
  const playlists = await Playlist.findAll({
      include: [{ model: Song, as: 'Songs' }]
  });
  res.render('admin', { users, playlists });
});

// Suspend user
app.post('/admin/suspend', isAdmin, async (req, res) => {
  const { userId } = req.body;
  await User.update({ status: 'suspended' }, { where: { id: userId } });
  res.redirect('/admin');
});

// Ban user
app.post('/admin/ban', isAdmin, async (req, res) => {
  const { userId } = req.body;
  await User.update({ status: 'banned' }, { where: { id: userId } });
  res.redirect('/admin');
});

// Reactivate user
app.post('/admin/activate', isAdmin, async (req, res) => {
  const { userId } = req.body;
  await User.update({ status: 'active' }, { where: { id: userId } });
  res.redirect('/admin');
});

// Create user (admin only)
app.post('/admin/create-user', isAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  const passwordHash = await bcrypt.hash(password, 10);

  await User.create({ username, passwordHash, role });
  res.redirect('/admin');
});

app.post('/admin/reset-user-password', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { userId, newPassword } = req.body;

    const hash = await bcrypt.hash(newPassword, 10);
    await User.update(
      { passwordHash: hash },
      { where: { id: userId } }
    );

    res.redirect('/admin'); // back to user management
  } catch (err) {
    console.error(err);
    res.status(500).send('Error resetting user password');
  }
});

async function ensureSongSchema() {
  const queryInterface = sequelize.getQueryInterface();
  const tableName = Song.getTableName();
  const columns = await queryInterface.describeTable(tableName);

  if (!columns.pushfmurl) {
    await queryInterface.addColumn(tableName, 'pushfmurl', {
      type: DataTypes.STRING,
      allowNull: true
    });
    console.log('[DB] Added Songs.pushfmurl column');
  }
}

async function initDatabaseWithRetry() {
    const baseDelayMs = Number(process.env.DB_RETRY_BASE_DELAY_MS || 1000);
    const maxDelayMs = Number(process.env.DB_RETRY_MAX_DELAY_MS || 30000);

    let attempt = 0;
    while (true) {
        attempt += 1;
        try {
            await sequelize.authenticate();
            await sequelize.sync();
            await ensureSongSchema();

            const existing = await User.findOne({ where: { username: 'admin' } });
            if (!existing) {
                const passwordHash = await bcrypt.hash('admin', 10);
                await User.create({ username: 'admin', passwordHash });
                console.log('Default admin user created: admin/admin');
            }

            dbReady = true;
            console.log('[DB] Ready');
            return;
        } catch (err) {
            dbReady = false;
            writeCrashLog('dbInitError', err, `attempt=${attempt}`);
            console.error(`[DB] Init failed (attempt ${attempt}):`, err?.message || err);

            const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.min(attempt - 1, 10)));
            await sleep(delay);
        }
    }
}

// Initialize DB in background; do not crash the web server if DB is temporarily unavailable.
initDatabaseWithRetry();

// Catch request/route errors and log them
app.use((err, req, res, next) => {
    writeCrashLog('expressError', err, `${req.method} ${req.originalUrl}`);
    res.status(500).send('Internal Server Error');
});

// Start
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
