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
    likedBy: [],
    dislikedBy: [],
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

// --- Comments (stored in R2) ---
function commentsKey(videoId) {
  return `${METADATA_PREFIX}/comments/${videoId}.json`;
}

async function getComments(videoId) {
  return (await getObjectJson(commentsKey(videoId))) || [];
}

async function putComments(videoId, comments) {
  await putObjectJson(commentsKey(videoId), comments);
}

async function addComment(videoId, user, text) {
  const comments = await getComments(videoId);
  const comment = {
    id: uuidv4(),
    videoId,
    authorUid: user.uid,
    authorName: user.displayName || user.email || 'مستخدم',
    authorPhoto: user.photoUrl || '',
    text: text.trim(),
    likes: 0,
    likedBy: [],
    createdAt: new Date().toISOString(),
    replies: [],
  };
  comments.unshift(comment);
  await putComments(videoId, comments);
  return comment;
}

async function addReply(videoId, commentId, user, text) {
  const comments = await getComments(videoId);
  const parent = comments.find((c) => c.id === commentId);
  if (!parent) throw new Error('Comment not found');
  const reply = {
    id: uuidv4(),
    authorUid: user.uid,
    authorName: user.displayName || user.email || 'مستخدم',
    authorPhoto: user.photoUrl || '',
    text: text.trim(),
    likes: 0,
    likedBy: [],
    createdAt: new Date().toISOString(),
  };
  parent.replies = parent.replies || [];
  parent.replies.push(reply);
  await putComments(videoId, comments);
  return reply;
}

function removeUid(list, uid) {
  return (list || []).filter((id) => id !== uid);
}

function toggleUid(list, uid) {
  const arr = list || [];
  return arr.includes(uid) ? removeUid(arr, uid) : [...arr, uid];
}

function includesUid(list, uid) {
  return (list || []).includes(uid);
}

async function toggleVideoLike(videoId, uid) {
  const video = await getVideo(videoId);
  if (!video) throw new Error('Video not found');
  video.likedBy = video.likedBy || [];
  video.dislikedBy = video.dislikedBy || [];
  let likes = video.likes || 0;
  let dislikes = video.dislikes || 0;

  if (includesUid(video.likedBy, uid)) {
    video.likedBy = removeUid(video.likedBy, uid);
    likes = Math.max(0, likes - 1);
  } else {
    video.likedBy = [...video.likedBy, uid];
    likes += 1;
    if (includesUid(video.dislikedBy, uid)) {
      video.dislikedBy = removeUid(video.dislikedBy, uid);
      dislikes = Math.max(0, dislikes - 1);
    }
  }
  video.likes = likes;
  video.dislikes = dislikes;
  await putObjectJson(`${METADATA_PREFIX}/${videoId}.json`, video);
  await updateIndex(video);
  return {
    likes: video.likes,
    dislikes: video.dislikes,
    likedBy: video.likedBy,
    dislikedBy: video.dislikedBy,
  };
}

async function toggleVideoDislike(videoId, uid) {
  const video = await getVideo(videoId);
  if (!video) throw new Error('Video not found');
  video.likedBy = video.likedBy || [];
  video.dislikedBy = video.dislikedBy || [];
  let likes = video.likes || 0;
  let dislikes = video.dislikes || 0;

  if (includesUid(video.dislikedBy, uid)) {
    video.dislikedBy = removeUid(video.dislikedBy, uid);
    dislikes = Math.max(0, dislikes - 1);
  } else {
    video.dislikedBy = [...video.dislikedBy, uid];
    dislikes += 1;
    if (includesUid(video.likedBy, uid)) {
      video.likedBy = removeUid(video.likedBy, uid);
      likes = Math.max(0, likes - 1);
    }
  }
  video.likes = likes;
  video.dislikes = dislikes;
  await putObjectJson(`${METADATA_PREFIX}/${videoId}.json`, video);
  await updateIndex(video);
  return {
    likes: video.likes,
    dislikes: video.dislikes,
    likedBy: video.likedBy,
    dislikedBy: video.dislikedBy,
  };
}

async function toggleCommentLike(videoId, commentId, uid) {
  const comments = await getComments(videoId);
  const comment = comments.find((c) => c.id === commentId);
  if (!comment) throw new Error('Comment not found');
  const was = includesUid(comment.likedBy, uid);
  comment.likedBy = toggleUid(comment.likedBy, uid);
  comment.likes = (comment.likes || 0) + (was ? -1 : 1);
  if (comment.likes < 0) comment.likes = 0;
  await putComments(videoId, comments);
  return { likes: comment.likes, likedBy: comment.likedBy };
}

async function toggleReplyLike(videoId, commentId, replyId, uid) {
  const comments = await getComments(videoId);
  const comment = comments.find((c) => c.id === commentId);
  if (!comment || !comment.replies) throw new Error('Comment not found');
  const reply = comment.replies.find((r) => r.id === replyId);
  if (!reply) throw new Error('Reply not found');
  const was = includesUid(reply.likedBy, uid);
  reply.likedBy = toggleUid(reply.likedBy, uid);
  reply.likes = (reply.likes || 0) + (was ? -1 : 1);
  if (reply.likes < 0) reply.likes = 0;
  await putComments(videoId, comments);
  return { likes: reply.likes, likedBy: reply.likedBy };
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
    const result = await toggleVideoLike(req.params.id, req.user.uid);
    res.json({ ok: true, ...result, likedByCurrentUser: includesUid(result.likedBy, req.user.uid), dislikedByCurrentUser: includesUid(result.dislikedBy, req.user.uid) });
  } catch (err) {
    console.error('like error', err.message);
    res.status(500).json({ error: 'Failed to update like' });
  }
});

api.post('/videos/:id/dislike', requireAuth, async (req, res) => {
  try {
    const result = await toggleVideoDislike(req.params.id, req.user.uid);
    res.json({ ok: true, ...result, likedByCurrentUser: includesUid(result.likedBy, req.user.uid), dislikedByCurrentUser: includesUid(result.dislikedBy, req.user.uid) });
  } catch (err) {
    console.error('dislike error', err.message);
    res.status(500).json({ error: 'Failed to update dislike' });
  }
});

api.get('/videos/:id/comments', async (req, res) => {
  try {
    const comments = await getComments(req.params.id);
    res.json({ comments });
  } catch (err) {
    console.error('comments list error', err.message);
    res.status(500).json({ error: 'Failed to load comments' });
  }
});

api.post('/videos/:id/comments', requireAuth, async (req, res) => {
  try {
    const { text, replyTo } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Comment text is required' });
    }
    if (replyTo) {
      const reply = await addReply(req.params.id, replyTo, req.user, text);
      return res.json({ reply });
    }
    const comment = await addComment(req.params.id, req.user, text);
    res.json({ comment });
  } catch (err) {
    console.error('comment create error', err.message);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

api.post('/videos/:id/comments/:commentId/like', requireAuth, async (req, res) => {
  try {
    const result = await toggleCommentLike(req.params.id, req.params.commentId, req.user.uid);
    res.json({ ok: true, ...result, likedByCurrentUser: includesUid(result.likedBy, req.user.uid) });
  } catch (err) {
    console.error('comment like error', err.message);
    res.status(500).json({ error: 'Failed to like comment' });
  }
});

api.post('/videos/:id/comments/:commentId/replies/:replyId/like', requireAuth, async (req, res) => {
  try {
    const result = await toggleReplyLike(req.params.id, req.params.commentId, req.params.replyId, req.user.uid);
    res.json({ ok: true, ...result, likedByCurrentUser: includesUid(result.likedBy, req.user.uid) });
  } catch (err) {
    console.error('reply like error', err.message);
    res.status(500).json({ error: 'Failed to like reply' });
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
