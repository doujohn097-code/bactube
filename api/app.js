require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const Minio = require('minio');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_PUBLIC_URL,
  R2_ENDPOINT,
  FIREBASE_PROJECT_ID = process.env.VITE_FIREBASE_PROJECT_ID,
  FIREBASE_API_KEY = process.env.VITE_FIREBASE_API_KEY,
  FIREBASE_ADMIN_KEY,
  ALLOWED_ORIGIN,
  PORT = 3001,
} = process.env;

// --- Service Account setup ---
const fs = require('fs');
let serviceAccount;
const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (credsPath && fs.existsSync(credsPath)) {
  try {
    serviceAccount = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  } catch (e) {
    console.error('Failed to read service account file', e.message);
  }
}
if (!serviceAccount && FIREBASE_ADMIN_KEY) {
  try {
    const decoded = Buffer.from(FIREBASE_ADMIN_KEY, 'base64').toString('utf8');
    serviceAccount = JSON.parse(decoded);
  } catch (e) {
    try {
      serviceAccount = JSON.parse(FIREBASE_ADMIN_KEY);
    } catch (e2) {
      console.error('Failed to parse FIREBASE_ADMIN_KEY');
    }
  }
}

if (!serviceAccount) {
  console.error('Missing FIREBASE_ADMIN_KEY or GOOGLE_APPLICATION_CREDENTIALS');
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

// --- Firestore access token cache ---
let firestoreToken = null;
let firestoreTokenExpiry = 0;

async function getFirestoreToken() {
  if (firestoreToken && Date.now() < firestoreTokenExpiry - 60000) {
    return firestoreToken;
  }
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    {
      iss: serviceAccount.client_email,
      sub: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    serviceAccount.private_key,
    { algorithm: 'RS256' }
  );
  const res = await axios.post(
    'https://oauth2.googleapis.com/token',
    {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: token,
    },
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  firestoreToken = res.data.access_token;
  firestoreTokenExpiry = Date.now() + res.data.expires_in * 1000;
  return firestoreToken;
}

function firestoreBase() {
  return `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

async function firestoreReq(method, subPath, data) {
  const token = await getFirestoreToken();
  const url = `${firestoreBase()}${subPath}`;
  const res = await axios({
    method,
    url,
    data,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return res.data;
}

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: 'NULL_VALUE' };
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
      return { timestampValue: value };
    }
    return { stringValue: value };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'object') {
    const fields = {};
    for (const key of Object.keys(value)) fields[key] = toFirestoreValue(value[key]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function fromFirestoreValue(value) {
  if (!value) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return parseInt(value.integerValue, 10);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.nullValue !== undefined) return null;
  if (value.timestampValue !== undefined) return value.timestampValue;
  if (value.arrayValue) return (value.arrayValue.values || []).map(fromFirestoreValue);
  if (value.mapValue) {
    const obj = {};
    for (const key of Object.keys(value.mapValue.fields || {})) {
      obj[key] = fromFirestoreValue(value.mapValue.fields[key]);
    }
    return obj;
  }
  return null;
}

function documentToObject(doc) {
  const obj = {};
  const fields = (doc.fields || {});
  for (const key of Object.keys(fields)) {
    obj[key] = fromFirestoreValue(fields[key]);
  }
  const parts = doc.name.split('/');
  obj.id = parts[parts.length - 1];
  return obj;
}

async function listVideos() {
  const data = await firestoreReq(
    'GET',
    '/videos?pageSize=100&orderBy=createdAt desc'
  );
  if (!data.documents) return [];
  return data.documents.map(documentToObject);
}

async function getVideo(id) {
  const data = await firestoreReq('GET', `/videos/${id}`);
  return documentToObject(data);
}

async function createVideo(fields) {
  const id = uuidv4();
  const body = { fields: {} };
  for (const key of Object.keys(fields)) body.fields[key] = toFirestoreValue(fields[key]);
  const data = await firestoreReq('POST', `/videos?documentId=${id}`, body);
  return documentToObject(data);
}

async function updateVideo(id, updates) {
  const updateMask = Object.keys(updates).map((k) => `updateMask.fieldPaths=${k}`).join('&');
  const body = { fields: {} };
  for (const key of Object.keys(updates)) body.fields[key] = toFirestoreValue(updates[key]);
  await firestoreReq('PATCH', `/videos/${id}?${updateMask}`, body);
}

// --- Express App ---
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: ALLOWED_ORIGIN || true, credentials: true }));

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.toLowerCase().startsWith('bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const idToken = auth.slice(7).trim();
  try {
    const { data } = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      { idToken }
    );
    if (!data.users || !data.users.length) return res.status(401).json({ error: 'Invalid token' });
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

api.get('/health', (req, res) => res.json({ ok: true }));

api.get('/videos', async (req, res) => {
  try {
    const videos = await listVideos();
    res.json({ videos });
  } catch (err) {
    console.error('list videos error', err.response?.data || err.message);
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
      authorName: req.user.displayName || req.user.email,
      authorPhoto: req.user.photoUrl || '',
      viewCount: 0,
      likes: 0,
      dislikes: 0,
      createdAt: new Date().toISOString(),
    });
    res.json({ video });
  } catch (err) {
    console.error('create video error', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create video' });
  }
});

api.post('/upload-url', requireAuth, async (req, res) => {
  try {
    const { filename, contentType } = req.body;
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
    await updateVideo(req.params.id, { viewCount: (video.viewCount || 0) + 1 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update view' });
  }
});

api.post('/videos/:id/like', requireAuth, async (req, res) => {
  try {
    const video = await getVideo(req.params.id);
    await updateVideo(req.params.id, { likes: (video.likes || 0) + 1 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update like' });
  }
});

api.post('/videos/:id/dislike', requireAuth, async (req, res) => {
  try {
    const video = await getVideo(req.params.id);
    await updateVideo(req.params.id, { dislikes: (video.dislikes || 0) + 1 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update dislike' });
  }
});

app.use('/', api);

module.exports = app;
