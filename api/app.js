require('dotenv').config({ path: require('path').join(__dirname, '.env') });
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Minio = require('minio');
const { v4: uuidv4 } = require('uuid');

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_PUBLIC_URL,
  R2_ENDPOINT,
  FIREBASE_API_KEY = process.env.VITE_FIREBASE_API_KEY,
  ALLOWED_ORIGIN,
  METADATA_PREFIX = 'bactube-videos',
} = process.env;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
  console.error('Missing R2 credentials in environment');
}

// --- R2 Client ---
const r2Endpoint = R2_ENDPOINT || `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const r2Client = new Minio.Client({
  endPoint: r2Endpoint,
  port: 443,
  useSSL: true,
  accessKey: R2_ACCESS_KEY_ID,
  secretKey: R2_SECRET_ACCESS_KEY,
  region: 'auto',
});

// --- Metadata helpers (stored in R2) ---
const META_INDEX = `${METADATA_PREFIX}/index.json`;

async function getObjectJson(key) {
  try {
    const stream = await r2Client.getObject(R2_BUCKET_NAME, key);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    if (err.code === 'NoSuchKey' || err.message?.includes('NoSuchKey')) return null;
    throw err;
  }
}

async function putObjectJson(key, value) {
  const buffer = Buffer.from(JSON.stringify(value), 'utf8');
  await r2Client.putObject(R2_BUCKET_NAME, key, buffer, buffer.length, {
    'Content-Type': 'application/json',
  });
}

async function updateIndex(video) {
  try {
    const list = (await getObjectJson(META_INDEX)) || [];
    const idx = list.findIndex((v) => v.id === video.id);
    if (idx >= 0) list[idx] = video;
    await putObjectJson(META_INDEX, list);
  } catch (err) {
    console.error('update index warning', err.message);
  }
}

function sortVideos(list) {
  return list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

async function listVideos() {
  let list = await getObjectJson(META_INDEX);
  if (Array.isArray(list) && list.length) return sortVideos(list);

  // Fallback: scan objects (used on first load or missing index)
  const keys = [];
  try {
    const stream = r2Client.listObjectsV2(R2_BUCKET_NAME, `${METADATA_PREFIX}/`, true);
    for await (const obj of stream) {
      if (obj.name && obj.name.endsWith('.json') && obj.name !== META_INDEX) {
        keys.push(obj.name);
      }
    }
  } catch (err) {
    console.error('list objects error', err.message);
  }

  const videos = (await Promise.all(keys.map((k) => getObjectJson(k)))).filter(Boolean);
  return sortVideos(videos);
}

async function getVideo(id) {
  return getObjectJson(`${METADATA_PREFIX}/${id}.json`);
}

async function createVideo(fields) {
  const id = uuidv4();
  const video = {
    ...fields,
    id,
    viewCount: fields.viewCount || 0,
    likes: fields.likes || 0,
    dislikes: fields.dislikes || 0,
    createdAt: fields.createdAt || new Date().toISOString(),
  };
  await putObjectJson(`${METADATA_PREFIX}/${id}.json`, video);

  const list = (await getObjectJson(META_INDEX)) || [];
  list.unshift(video);
  await putObjectJson(META_INDEX, list);

  return video;
}

async function updateVideo(id, updates) {
  const video = await getVideo(id);
  if (!video) throw new Error('Video not found');
  Object.assign(video, updates);
  await putObjectJson(`${METADATA_PREFIX}/${id}.json`, video);
  await updateIndex(video);
  return video;
}

// --- Express App ---
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: ALLOWED_ORIGIN || true, credentials: true }));

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const idToken = auth.slice(7).trim();
  try {
    const { data } = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      { idToken },
      { timeout: 10000 }
    );
    if (!data.users || !data.users.length) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    const u = data.users[0];
    req.user = {
      uid: u.localId,
      email: u.email,
      displayName: u.displayName,
      photoUrl: u.photoUrl,
    };
    next();
  } catch (err) {
    console.error('auth error', err.response?.data || err.message);
    res.status(401).json({ error: 'Invalid token' });
  }
}

const api = express.Router();

api.get('/health', (req, res) => res.json({ ok: true, store: 'r2' }));

api.get('/videos', async (req, res) => {
  try {
    const videos = await listVideos();
    res.json({ videos });
  } catch (err) {
    console.error('list videos error', err.message);
    res.status(500).json({ error: 'Failed to load videos' });
  }
});

api.post('/videos', requireAuth, async (req, res) => {
  try {
    const { title, description, thumbnailUrl, videoUrl, duration } = req.body;
    const video = await createVideo({
      title: title || '',
      description: description || '',
      thumbnailUrl: thumbnailUrl || '',
      videoUrl: videoUrl || '',
      duration: duration || '0:00',
      authorUid: req.user.uid,
      authorName: req.user.displayName || req.user.email || 'User',
      authorPhoto: req.user.photoUrl || '',
    });
    res.json({ video });
  } catch (err) {
    console.error('create video error', err.message);
    res.status(500).json({ error: 'Failed to create video' });
  }
});

api.post('/upload-url', requireAuth, async (req, res) => {
  try {
    const { filename } = req.body;
    const ext = path.extname(filename || '') || '';
    const key = `${uuidv4()}${ext}`;
    const expiry = 60 * 60; // 1 hour
    const uploadUrl = await r2Client.presignedPutObject(R2_BUCKET_NAME, key, expiry);
    const publicUrl = `${R2_PUBLIC_URL}/${key}`;
    res.json({ uploadUrl, publicUrl, key });
  } catch (err) {
    console.error('presign error', err.message);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

api.post('/videos/:id/view', async (req, res) => {
  try {
    const video = await getVideo(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    await updateVideo(req.params.id, { viewCount: (video.viewCount || 0) + 1 });
    res.json({ ok: true });
  } catch (err) {
    console.error('view error', err.message);
    res.status(500).json({ error: 'Failed to update view' });
  }
});

api.post('/videos/:id/like', requireAuth, async (req, res) => {
  try {
    const video = await getVideo(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    await updateVideo(req.params.id, { likes: (video.likes || 0) + 1 });
    res.json({ ok: true });
  } catch (err) {
    console.error('like error', err.message);
    res.status(500).json({ error: 'Failed to update like' });
  }
});

api.post('/videos/:id/dislike', requireAuth, async (req, res) => {
  try {
    const video = await getVideo(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    await updateVideo(req.params.id, { dislikes: (video.dislikes || 0) + 1 });
    res.json({ ok: true });
  } catch (err) {
    console.error('dislike error', err.message);
    res.status(500).json({ error: 'Failed to update dislike' });
  }
});

app.use('/api', api);
app.use('/', api);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
