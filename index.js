require('dotenv').config();
const express = require('express');
const session = require('express-session');
const Redis = require('ioredis');
const { Sequelize, DataTypes } = require('sequelize');
const youtubedl = require('youtube-dl-exec');
const path = require('path');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');

const { Playlist, Song, User, sequelize } = require('./models');

const COOLDOWN_MS = 30 * 1000; // 30 seconds between updates


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

// Helper: Run youtube-dl-exec and parse stats
async function fetchYouTubeStats(youtubeid) {
    try {
        const data = await youtubedl(`https://www.youtube.com/watch?v=${youtubeid}`, {
            dumpSingleJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            preferFreeFormats: true
        });

        return {
            views: data.view_count?.toString() || 'N/A',
            likes: data.like_count?.toString() || 'N/A'
        };
    } catch (err) {
        console.error(`youtube-dl-exec failed for ${youtubeid}:`, err);
        return { views: 'N/A', likes: 'N/A' };
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

setInterval(updateAllStatsInBackground, 60 * 1000);

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
function isAuthenticated(req, res, next) {
    if (req.session.userId) return next();
    res.redirect('/admin/login');
}

// Replace:
app.get('/admin/login', (req, res) => {
    res.render('login');
});

app.get('/admin', isAuthenticated, async (req, res) => {
    const playlists = await Playlist.findAll({
        include: {
            model: Song,
            as: 'Songs'
        }
    });
    res.render('admin', { playlists });         // pass to EJS view
});

// API Endpoint
app.get('/api/playlists', async (req, res) => {
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
            Artist: song.Artist,
            title: song.title,
            cover: song.cover,
            youtubeid: song.youtubeid,
            views: song.views,
            likes: song.likes
        }))
    }));

    res.json({ playlists: formatted });

});

app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ where: { username } });
    if (user && await bcrypt.compare(password, user.passwordHash)) {
        req.session.userId = user.id;
        res.redirect('/admin');
    } else {
        res.send('Invalid credentials');
    }
});

app.post('/admin/add-song', isAuthenticated, async (req, res) => {
  const { Artist, title, cover, youtubeid, playlist } = req.body;

  try {
    const playlistRecord = await Playlist.findOne({ where: { name: playlist } });
    if (!playlistRecord) {
      return res.status(400).send('Playlist not found');
    }

    await Song.create({
      Artist,
      title,
      cover,
      youtubeid,
      playlistId: playlistRecord.id
    });

    res.redirect('/admin');
  } catch (err) {
    console.error('Error adding song:', err);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/admin/delete-song', isAuthenticated, async (req, res) => {
    await Song.destroy({ where: { youtubeid: req.body.youtubeid } });
    res.redirect('/admin');
});

app.post('/admin/add-playlist', isAuthenticated, async (req, res) => {
    const { name, cover } = req.body;
    await Playlist.create({ name, cover });
    res.redirect('/admin');
});

app.post('/admin/delete-playlist', isAuthenticated, async (req, res) => {
    const { name } = req.body;
    await Playlist.destroy({ where: { name } });
    await Song.destroy({ where: { playlist: name } }); // also delete associated songs
    res.redirect('/admin');
});

app.get('/admin/playlists', isAuthenticated, async (req, res) => {
    const playlists = await Playlist.findAll();
    res.json(playlists);
});

app.post('/admin/update-password', isAuthenticated, async (req, res) => {
    const { newPassword } = req.body;
    const user = await User.findByPk(req.session.userId);
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.redirect('/admin');
});

// First-time setup default admin
(async () => {
    await sequelize.sync();
    const existing = await User.findOne({ where: { username: 'admin' } });
    if (!existing) {
        const passwordHash = await bcrypt.hash('admin', 10);
        await User.create({ username: 'admin', passwordHash });
        console.log('Default admin user created: admin/admin');
    }
})();

// Start
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
