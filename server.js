require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// ── Cloudflare R2 setup (optional) ───────────────────────────────────────────
const R2_ENABLED = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME
);

let r2 = null;
let PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand;

if (R2_ENABLED) {
  const sdk = require('@aws-sdk/client-s3');
  PutObjectCommand    = sdk.PutObjectCommand;
  GetObjectCommand    = sdk.GetObjectCommand;
  DeleteObjectCommand = sdk.DeleteObjectCommand;
  DeleteObjectsCommand = sdk.DeleteObjectsCommand;

  r2 = new sdk.S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

// ── Directory setup (local fallback) ─────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_DIR      = path.join(__dirname, 'db');
const BACKUP_DIR  = path.join(__dirname, 'backups');
[DB_DIR, UPLOADS_DIR, BACKUP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── SQLite ───────────────────────────────────────────────────────────────────
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
    drive_path    TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
`);

// Migrate: add drive_path if upgrading from original schema
try { db.exec('ALTER TABLE client_photos ADD COLUMN drive_path TEXT'); } catch {}

// ── Multer ───────────────────────────────────────────────────────────────────
// Memory storage when R2 is enabled (upload buffer → R2).
// Disk storage as fallback (save to ./uploads/).
const multerStorage = R2_ENABLED
  ? multer.memoryStorage()
  : multer.diskStorage({
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
  storage: multerStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, GIF, and WebP images are allowed'));
  },
});

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Photo proxy endpoint ──────────────────────────────────────────────────────
// Single URL scheme for both R2 and local — frontend never changes.
// R2: streams directly from bucket. Local: serves from disk.
app.get('/api/photos/:clientId/:filename', async (req, res) => {
  const { clientId, filename } = req.params;

  if (!/^[\w-]+$/.test(clientId) || !/^[\w\-.]+$/.test(filename)) {
    return res.status(400).end();
  }

  const ext = path.extname(filename).toLowerCase();
  const contentTypes = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png',  '.gif': 'image/gif',  '.webp': 'image/webp',
  };

  if (R2_ENABLED) {
    try {
      const obj = await r2.send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: `photos/${clientId}/${filename}`,
      }));
      res.setHeader('Content-Type', obj.ContentType || contentTypes[ext] || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      obj.Body.pipe(res); // stream directly — no buffering
    } catch (err) {
      if (err.name === 'NoSuchKey') res.status(404).end();
      else { console.error('R2 get:', err.message); res.status(500).end(); }
    }
  } else {
    const filePath = path.join(UPLOADS_DIR, clientId, filename);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(filePath);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────
async function saveBackup(payload) {
  const ts      = new Date().toISOString().replace(/[:.]/g, '-');
  const content = JSON.stringify(payload, null, 2);

  if (R2_ENABLED) {
    const key = `backups/clients-${ts}.json`;
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: content,
      ContentType: 'application/json',
    }));
    return { type: 'r2', location: key };
  } else {
    const filePath = path.join(BACKUP_DIR, `clients-${ts}.json`);
    fs.writeFileSync(filePath, content, 'utf8');
    return { type: 'local', location: filePath };
  }
}

// ── Routes: clients ───────────────────────────────────────────────────────────

app.get('/api/clients', (req, res) => {
  const like = `%${(req.query.search || '').trim()}%`;
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

app.get('/api/clients/:id', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const photos = db
    .prepare('SELECT * FROM client_photos WHERE client_id = ? ORDER BY created_at ASC')
    .all(req.params.id);

  res.json({ ...client, photos });
});

app.post('/api/clients', (req, res) => {
  const { name, company, email, phone, address, notes, tags } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO clients (id, name, company, email, phone, address, notes, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), company || '', email || '', phone || '', address || '', notes || '', tags || '');

  res.status(201).json(db.prepare('SELECT * FROM clients WHERE id = ?').get(id));
});

app.put('/api/clients/:id', (req, res) => {
  const { name, company, email, phone, address, notes, tags } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

  if (!db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Client not found' });
  }

  db.prepare(`
    UPDATE clients
    SET name=?, company=?, email=?, phone=?, address=?, notes=?, tags=?,
        updated_at=datetime('now')
    WHERE id=?
  `).run(name.trim(), company || '', email || '', phone || '', address || '', notes || '', tags || '', req.params.id);

  res.json(db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id));
});

app.delete('/api/clients/:id', async (req, res) => {
  if (!db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Client not found' });
  }

  const photos = db.prepare('SELECT * FROM client_photos WHERE client_id = ?').all(req.params.id);

  if (R2_ENABLED && photos.length) {
    const objects = photos
      .filter(p => p.drive_path)
      .map(p => ({ Key: p.drive_path }));
    if (objects.length) {
      try {
        await r2.send(new DeleteObjectsCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Delete: { Objects: objects },
        }));
      } catch (e) { console.error('R2 deleteObjects:', e.message); }
    }
  } else {
    const clientDir = path.join(UPLOADS_DIR, req.params.id);
    if (fs.existsSync(clientDir)) fs.rmSync(clientDir, { recursive: true, force: true });
  }

  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Routes: photos ────────────────────────────────────────────────────────────

app.post('/api/clients/:id/photos', (req, res) => {
  if (!db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Client not found' });
  }

  const count = db
    .prepare('SELECT COUNT(*) AS n FROM client_photos WHERE client_id = ?')
    .get(req.params.id).n;
  if (count >= 10) {
    return res.status(400).json({ error: 'Maximum of 10 photos per client reached' });
  }

  upload.single('photo')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    // Re-check after upload (concurrent request guard)
    const freshCount = db
      .prepare('SELECT COUNT(*) AS n FROM client_photos WHERE client_id = ?')
      .get(req.params.id).n;
    if (freshCount >= 10) {
      if (req.file.path) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Maximum of 10 photos per client reached' });
    }

    let filename, drivePath;

    if (R2_ENABLED) {
      filename  = `${uuidv4()}${path.extname(req.file.originalname).toLowerCase()}`;
      drivePath = `photos/${req.params.id}/${filename}`;
      try {
        await r2.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: drivePath,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
        }));
      } catch (e) {
        return res.status(500).json({ error: 'Failed to upload to R2: ' + e.message });
      }
    } else {
      filename  = req.file.filename;
      drivePath = null;
    }

    const photoId = uuidv4();
    db.prepare(`
      INSERT INTO client_photos (id, client_id, filename, original_name, drive_path)
      VALUES (?, ?, ?, ?, ?)
    `).run(photoId, req.params.id, filename, req.file.originalname, drivePath);

    res.status(201).json(db.prepare('SELECT * FROM client_photos WHERE id = ?').get(photoId));
  });
});

app.delete('/api/clients/:id/photos/:photoId', async (req, res) => {
  const photo = db
    .prepare('SELECT * FROM client_photos WHERE id = ? AND client_id = ?')
    .get(req.params.photoId, req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  if (R2_ENABLED && photo.drive_path) {
    try {
      await r2.send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: photo.drive_path,
      }));
    } catch (e) { console.error('R2 delete:', e.message); }
  } else if (!R2_ENABLED) {
    const filePath = path.join(UPLOADS_DIR, req.params.id, photo.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  db.prepare('DELETE FROM client_photos WHERE id = ?').run(req.params.photoId);
  res.json({ success: true });
});

// ── Routes: backup & info ─────────────────────────────────────────────────────

app.post('/api/backup', async (req, res) => {
  try {
    const clients = db.prepare('SELECT * FROM clients').all();
    const photos  = db.prepare('SELECT * FROM client_photos').all();

    const result = await saveBackup({
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

app.get('/api/info', (_req, res) => {
  res.json({
    r2Enabled: R2_ENABLED,
    storageType: R2_ENABLED ? 'cloudflare-r2' : 'local',
    bucket: R2_ENABLED ? process.env.R2_BUCKET_NAME : null,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Sales Support CRM  →  http://localhost:${PORT}`);
  console.log(`  Photo/backup storage: ${R2_ENABLED ? `Cloudflare R2 (${process.env.R2_BUCKET_NAME})` : 'local (./uploads/ + ./backups/)'}\n`);
});
