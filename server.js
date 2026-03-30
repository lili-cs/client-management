require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// ── S3 setup (optional) ──────────────────────────────────────────────────────
const S3_ENABLED = !!(
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY &&
  process.env.S3_BUCKET_NAME
);

let s3Client = null;
let PutObjectCommand = null;

if (S3_ENABLED) {
  const sdk = require('@aws-sdk/client-s3');
  s3Client = new sdk.S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  PutObjectCommand = sdk.PutObjectCommand;
}

// ── Directory setup ──────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_DIR = path.join(__dirname, 'db');
const BACKUP_DIR = path.join(__dirname, 'backups');
[UPLOADS_DIR, DB_DIR, BACKUP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── Database setup ───────────────────────────────────────────────────────────
const db = new Database(path.join(DB_DIR, 'clients.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    company     TEXT DEFAULT '',
    email       TEXT DEFAULT '',
    phone       TEXT DEFAULT '',
    address     TEXT DEFAULT '',
    notes       TEXT DEFAULT '',
    tags        TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS client_photos (
    id            TEXT PRIMARY KEY,
    client_id     TEXT NOT NULL,
    filename      TEXT NOT NULL,
    original_name TEXT DEFAULT '',
    s3_key        TEXT,
    s3_url        TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
`);

// ── Multer (photo uploads) ───────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const dir = path.join(UPLOADS_DIR, req.params.id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB per photo
  fileFilter(_req, file, cb) {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, GIF, and WebP images are allowed'));
  },
});

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Helpers ──────────────────────────────────────────────────────────────────
async function uploadToS3(key, body, contentType) {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
}

async function backupToCloud(payload) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const content = JSON.stringify(payload, null, 2);

  if (S3_ENABLED) {
    const key = `backups/clients-${ts}.json`;
    const url = await uploadToS3(key, content, 'application/json');
    return { type: 's3', location: url, key };
  } else {
    const filePath = path.join(BACKUP_DIR, `clients-${ts}.json`);
    fs.writeFileSync(filePath, content, 'utf8');
    return { type: 'local', location: filePath };
  }
}

// ── Routes: clients ──────────────────────────────────────────────────────────

// GET /api/clients?search=
app.get('/api/clients', (req, res) => {
  const { search } = req.query;
  const like = `%${(search || '').trim()}%`;

  const rows = db.prepare(`
    SELECT c.*, COUNT(p.id) AS photo_count
    FROM clients c
    LEFT JOIN client_photos p ON p.client_id = c.id
    WHERE c.name    LIKE ? OR c.company LIKE ?
       OR c.email   LIKE ? OR c.phone   LIKE ?
       OR c.tags    LIKE ?
    GROUP BY c.id
    ORDER BY c.updated_at DESC
  `).all(like, like, like, like, like);

  res.json(rows);
});

// GET /api/clients/:id
app.get('/api/clients/:id', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const photos = db
    .prepare('SELECT * FROM client_photos WHERE client_id = ? ORDER BY created_at ASC')
    .all(req.params.id);

  res.json({ ...client, photos });
});

// POST /api/clients
app.post('/api/clients', (req, res) => {
  const { name, company, email, phone, address, notes, tags } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO clients (id, name, company, email, phone, address, notes, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), company || '', email || '', phone || '', address || '', notes || '', tags || '');

  res.status(201).json(db.prepare('SELECT * FROM clients WHERE id = ?').get(id));
});

// PUT /api/clients/:id
app.put('/api/clients/:id', (req, res) => {
  const { name, company, email, phone, address, notes, tags } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const existing = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Client not found' });

  db.prepare(`
    UPDATE clients
    SET name=?, company=?, email=?, phone=?, address=?, notes=?, tags=?,
        updated_at=datetime('now')
    WHERE id=?
  `).run(name.trim(), company || '', email || '', phone || '', address || '', notes || '', tags || '', req.params.id);

  res.json(db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id));
});

// DELETE /api/clients/:id
app.delete('/api/clients/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Client not found' });

  const clientDir = path.join(UPLOADS_DIR, req.params.id);
  if (fs.existsSync(clientDir)) fs.rmSync(clientDir, { recursive: true, force: true });

  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Routes: photos ───────────────────────────────────────────────────────────

// POST /api/clients/:id/photos
app.post('/api/clients/:id/photos', (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const count = db
    .prepare('SELECT COUNT(*) AS n FROM client_photos WHERE client_id = ?')
    .get(req.params.id).n;

  if (count >= 10) {
    return res.status(400).json({ error: 'Maximum of 10 photos per client reached' });
  }

  upload.single('photo')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    // Re-check count after upload to guard against concurrent requests
    const freshCount = db
      .prepare('SELECT COUNT(*) AS n FROM client_photos WHERE client_id = ?')
      .get(req.params.id).n;

    if (freshCount >= 10) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Maximum of 10 photos per client reached' });
    }

    let s3Key = null;
    let s3Url = null;

    if (S3_ENABLED) {
      try {
        const key = `photos/${req.params.id}/${req.file.filename}`;
        s3Url = await uploadToS3(key, fs.readFileSync(req.file.path), req.file.mimetype);
        s3Key = key;
      } catch (s3Err) {
        console.error('S3 photo upload failed (keeping local copy):', s3Err.message);
      }
    }

    const photoId = uuidv4();
    db.prepare(`
      INSERT INTO client_photos (id, client_id, filename, original_name, s3_key, s3_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(photoId, req.params.id, req.file.filename, req.file.originalname, s3Key, s3Url);

    res.status(201).json(
      db.prepare('SELECT * FROM client_photos WHERE id = ?').get(photoId)
    );
  });
});

// DELETE /api/clients/:id/photos/:photoId
app.delete('/api/clients/:id/photos/:photoId', (req, res) => {
  const photo = db
    .prepare('SELECT * FROM client_photos WHERE id = ? AND client_id = ?')
    .get(req.params.photoId, req.params.id);

  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  const filePath = path.join(UPLOADS_DIR, req.params.id, photo.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  db.prepare('DELETE FROM client_photos WHERE id = ?').run(req.params.photoId);
  res.json({ success: true });
});

// ── Routes: backup ───────────────────────────────────────────────────────────

// POST /api/backup
app.post('/api/backup', async (req, res) => {
  try {
    const clients = db.prepare('SELECT * FROM clients').all();
    const photos = db.prepare('SELECT * FROM client_photos').all();

    const result = await backupToCloud({
      timestamp: new Date().toISOString(),
      version: 1,
      stats: { clients: clients.length, photos: photos.length },
      clients,
      photos,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/info
app.get('/api/info', (_req, res) => {
  res.json({
    s3Enabled: S3_ENABLED,
    bucket: S3_ENABLED ? process.env.S3_BUCKET_NAME : null,
    region: S3_ENABLED ? (process.env.AWS_REGION || 'us-east-1') : null,
  });
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Sales Support CRM  →  http://localhost:${PORT}`);
  console.log(`  Storage backup: ${S3_ENABLED ? `S3 (${process.env.S3_BUCKET_NAME})` : 'local ./backups/'}\n`);
});
