import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import { LRUCache } from 'lru-cache'
import youtubedl from "youtube-dl-exec";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = parseInt(process.env.YTDLP_TIMEOUT_MS || "60000", 10); // 60s default
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
const MAX_FILE_AGE_MS = parseInt(process.env.MAX_FILE_AGE_MS || `${60 * 60 * 1000}`, 10); // 1 hour

// Ensure downloads dir exists
if (!fssync.existsSync(DOWNLOAD_DIR)) {
  fssync.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Middleware
app.use(helmet());
app.use(morgan("combined"));
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Serve downloaded files
app.use("/files", express.static(DOWNLOAD_DIR, { fallthrough: false }));

// Simple cache for /info
const cache = new LRUCache({ max: 500, ttl: 5 * 60 * 1000 });

const isValidUrl = (s) => {
  try {
    const u = new URL(s);
    return ["http:", "https:"].includes(u.protocol);
  } catch {
    return false;
  }
};

// ---- yt-dlp helpers ----
const baseArgs = {
  noCheckCertificates: true,
  noWarnings: true,
  skipDownload: true,
  addHeader: ["referer:youtube.com", "user-agent:googlebot"]
};

async function fetchInfo(url, flatPlaylist = false) {
  const args = {
    ...baseArgs,
    dumpSingleJson: true,
    skipDownload: true,
  };
  if (flatPlaylist) args.flatPlaylist = true;
  return youtubedl(url, args);
}

function safeBasename(s, fallback) {
  // Light sanitizer for filenames
  const cleaned = (s || fallback || "file")
    .replace(/[\/\\?%*:|"<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "file";
}

async function downloadAudioMP3(url, meta) {
  const id = meta?.id;
  const title = meta?.title;
  const baseName = safeBasename(`${title || id || "audio"}-${id || Date.now()}`);
  const outTpl = path.join(DOWNLOAD_DIR, `${baseName}.%(ext)s`);

  await youtubedl(url, {
    noWarnings: true,
    noCheckCertificates: true,
    addHeader: ["referer:youtube.com", "user-agent:googlebot"],
    extractAudio: true,       // Extract audio only
    audioFormat: "mp3",       // Convert to MP3
    audioQuality: "0",        // Best quality
    output: outTpl
  });

  const files = await fs.readdir(DOWNLOAD_DIR);
  const produced =
    files.find((f) => f.startsWith(baseName) && f.endsWith(".mp3")) ||
    files.find((f) => f.startsWith(baseName)); // backup

  if (!produced) throw new Error("Audio file not found after download");
  return produced;
}

async function downloadAudioM4A(url, meta) {
  // Prefer m4a (AAC). If container differs, remux to m4a.
  const id = meta?.id;
  const title = meta?.title;
  const baseName = safeBasename(`${title || id || "audio"}-${id || Date.now()}`);
  const outTpl = path.join(DOWNLOAD_DIR, `${baseName}.%(ext)s`);

  await youtubedl(url, {
    // Download best audio, output to template, extract/remux to m4a if needed
    noWarnings: true,
    noCheckCertificates: true,
    addHeader: ["referer:youtube.com", "user-agent:googlebot"],
    // Two good approaches:
    // 1) extractAudio + audioFormat m4a (transcode if needed)
    // 2) format bestaudio + remux to m4a (no quality loss if possible)
    // We'll prefer remux when possible:
    format: "bestaudio/best",
    remuxVideo: "m4a", // yt-dlp treats this as "remux to audio container when possible"
    // Fall back to postprocessing into m4a when required:
    extractAudio: true,
    audioFormat: "m4a",
    output: outTpl
  });

  // Find the produced file (extension may vary briefly; prefer .m4a)
  const files = await fs.readdir(DOWNLOAD_DIR);
  const produced =
    files.find((f) => f.startsWith(baseName) && f.endsWith(".m4a")) ||
    files.find((f) => f.startsWith(baseName)); // backup

  if (!produced) throw new Error("Audio file not found after download");
  return produced;
}

async function downloadVideoMP4(url, meta) {
  const id = meta?.id;
  const title = meta?.title;
  const baseName = safeBasename(`${title || id || "video"}-${id || Date.now()}`);
  const outTpl = path.join(DOWNLOAD_DIR, `${baseName}.%(ext)s`);

  await youtubedl(url, {
    noWarnings: true,
    noCheckCertificates: true,
    addHeader: ["referer:youtube.com", "user-agent:googlebot"],
    // Prefer best mp4 video+audio; remux to mp4 if needed
    format:
      "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    remuxVideo: "mp4",
    output: outTpl
  });

  const files = await fs.readdir(DOWNLOAD_DIR);
  const produced =
    files.find((f) => f.startsWith(baseName) && f.endsWith(".mp4")) ||
    files.find((f) => f.startsWith(baseName)); // backup

  if (!produced) throw new Error("Video file not found after download");
  return produced;
}

// ---- Routes ----

// Info endpoint (unchanged, but uses youtube-dl-exec)
app.get("/info", async (req, res) => {
  const url = req.query.url?.toString().trim();
  const flat = req.query.flat == "1";
  const fields = req.query.fields?.toString();
  const bypassCache = req.query.cache === "0";

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "Missing or invalid ?url=" });
  }

  const cacheKey = JSON.stringify({ url, flat, fields: fields || "full" });
  if (!bypassCache) {
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);
  }

  try {
    const raw = await fetchInfo(url, flat);
    const payload = fields === "basic" ? pickFields(raw) : raw;
    cache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({
      error: "youtube-dl-exec failed",
      detail: err?.stderr?.toString?.() || err?.message || "Unknown error",
    });
  }
});

// Download AUDIO (.m4a)
app.get("/download/audio", async (req, res) => {
  const url = req.query.url?.toString().trim();
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "Missing or invalid ?url=" });
  }

  try {
    const meta = await fetchInfo(url);
    const filename = await downloadAudioMP3(url, meta);
    res.json({
      ok: true,
      kind: "audio",
      filename,
      link: `/files/${encodeURIComponent(filename)}`,
    });
  } catch (err) {
    res.status(500).json({
      error: "audio download failed",
      detail: err?.stderr?.toString?.() || err?.message || "Unknown error",
    });
  }
});

// Download VIDEO (.mp4)
app.get("/download/video", async (req, res) => {
  const url = req.query.url?.toString().trim();
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "Missing or invalid ?url=" });
  }

  try {
    const meta = await fetchInfo(url);
    const filename = await downloadVideoMP4(url, meta);
    res.json({
      ok: true,
      kind: "video",
      filename,
      link: `/files/${encodeURIComponent(filename)}`,
    });
  } catch (err) {
    res.status(500).json({
      error: "video download failed",
      detail: err?.stderr?.toString?.() || err?.message || "Unknown error",
    });
  }
});

// Optional: basic field trimmer for /info?fields=basic
function pickFields(data) {
  if (!data || typeof data !== "object") return data;

  if (Array.isArray(data.entries)) {
    return {
      type: "playlist",
      id: data.id,
      title: data.title,
      extractor: data.extractor_key,
      webpage_url: data.webpage_url,
      entries: data.entries.map((e) => ({
        id: e.id,
        title: e.title,
        duration: e.duration,
        url: e.url || e.webpage_url,
      })),
    };
  }

  return {
    type: data.is_live ? "live" : "video",
    id: data.id,
    title: data.title,
    duration: data.duration,
    uploader: data.uploader,
    channel: data.channel,
    thumbnail: data.thumbnail,
    webpage_url: data.webpage_url,
    extractor: data.extractor_key,
    formats: data.formats?.map((f) => ({
      format_id: f.format_id,
      ext: f.ext,
      acodec: f.acodec,
      vcodec: f.vcodec,
      tbr: f.tbr,
      width: f.width,
      height: f.height,
    })),
  };
}

// ---- Cleanup job: every hour, delete files older than MAX_FILE_AGE_MS ----
async function cleanupDownloads() {
  try {
    const now = Date.now();
    const files = await fs.readdir(DOWNLOAD_DIR);
    const toDelete = [];

    for (const file of files) {
      const fp = path.join(DOWNLOAD_DIR, file);
      try {
        const st = await fs.stat(fp);
        // Skip if not a file
        if (!st.isFile()) continue;
        if (now - st.mtimeMs > MAX_FILE_AGE_MS) {
          toDelete.push(fp);
        }
      } catch {
        // ignore stat errors
      }
    }

    await Promise.allSettled(toDelete.map((fp) => fs.unlink(fp)));
    if (toDelete.length) {
      console.log(`[cleanup] Deleted ${toDelete.length} old files`);
    }
  } catch (e) {
    console.warn("[cleanup] error:", e?.message || e);
  }
}

// Run once at startup and then hourly
cleanupDownloads();
setInterval(cleanupDownloads, 60 * 60 * 1000);

// ---- Root ----
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    endpoints: {
      info: "/info?url=<VIDEO_OR_PLAYLIST_URL>&fields=basic",
      download_audio: "/download/audio?url=<VIDEO_URL>",
      download_video: "/download/video?url=<VIDEO_URL>",
      files_base: "/files/<FILENAME>",
    },
    config: {
      TIMEOUT_MS,
      DOWNLOAD_DIR,
      MAX_FILE_AGE_MS,
    },
  });
});

app.listen(PORT, () => {
  console.log(`yt-dlp API listening at http://localhost:${PORT}`);
});
