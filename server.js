require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
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
  PutObjectCommand     = sdk.PutObjectCommand;
  GetObjectCommand     = sdk.GetObjectCommand;
  DeleteObjectCommand  = sdk.DeleteObjectCommand;
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

// ── Turso / libSQL setup ──────────────────────────────────────────────────────
// Uses Turso when TURSO_DATABASE_URL is set, otherwise falls back to a local
// SQLite file — same @libsql/client, same API, same SQL syntax either way.
const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || `file:${path.join(DB_DIR, 'clients.db')}`,
  authToken: process.env.TURSO_AUTH_TOKEN, // ignored for local file
});

async function initDb() {
  // Pragmas are best-effort — Turso remote ignores some of them
  try { await db.execute('PRAGMA journal_mode = WAL'); } catch {}
  try { await db.execute('PRAGMA foreign_keys = ON'); } catch {}

  await db.execute(`
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
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS client_photos (
      id            TEXT PRIMARY KEY,
      client_id     TEXT NOT NULL,
      filename      TEXT NOT NULL,
      original_name TEXT DEFAULT '',
      drive_path    TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    )
  `);

  // Migration: add drive_path if upgrading from older schema
  try { await db.execute('ALTER TABLE client_photos ADD COLUMN drive_path TEXT'); } catch {}
}

// ── Directory setup (local fallback for uploads/backups) ──────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const BACKUP_DIR  = path.join(__dirname, 'backups');
[UPLOADS_DIR, BACKUP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── Multer ────────────────────────────────────────────────────────────────────
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

// ── Helpers ───────────────────────────────────────────────────────────────────
// libSQL rows have named column access but need spreading for plain JSON output
function row(r)  { return r ? { ...r } : null; }
function rows(rs){ return rs.map(r => ({ ...r })); }

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

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Photo proxy endpoint ──────────────────────────────────────────────────────
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
      obj.Body.pipe(res);
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

// ── Routes: clients ───────────────────────────────────────────────────────────

app.get('/api/clients', async (req, res) => {
  try {
    const like = `%${(req.query.search || '').trim()}%`;
    const result = await db.execute({
      sql: `SELECT c.*, COUNT(p.id) AS photo_count
            FROM clients c
            LEFT JOIN client_photos p ON p.client_id = c.id
            WHERE c.name    LIKE ? OR c.company LIKE ?
               OR c.email   LIKE ? OR c.phone   LIKE ?
               OR c.tags    LIKE ?
            GROUP BY c.id
            ORDER BY c.updated_at DESC`,
      args: [like, like, like, like, like],
    });
    res.json(rows(result.rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clients/:id', async (req, res) => {
  try {
    const clientRes = await db.execute({
      sql: 'SELECT * FROM clients WHERE id = ?',
      args: [req.params.id],
    });
    const client = row(clientRes.rows[0]);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const photosRes = await db.execute({
      sql: 'SELECT * FROM client_photos WHERE client_id = ? ORDER BY created_at ASC',
      args: [req.params.id],
    });
    res.json({ ...client, photos: rows(photosRes.rows) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients', async (req, res) => {
  try {
    const { name, company, email, phone, address, notes, tags } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    const id = uuidv4();
    await db.execute({
      sql: `INSERT INTO clients (id, name, company, email, phone, address, notes, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, name.trim(), company || '', email || '', phone || '', address || '', notes || '', tags || ''],
    });

    const result = await db.execute({ sql: 'SELECT * FROM clients WHERE id = ?', args: [id] });
    res.status(201).json(row(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/clients/:id', async (req, res) => {
  try {
    const { name, company, email, phone, address, notes, tags } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    const existing = await db.execute({ sql: 'SELECT id FROM clients WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Client not found' });

    await db.execute({
      sql: `UPDATE clients
            SET name=?, company=?, email=?, phone=?, address=?, notes=?, tags=?,
                updated_at=datetime('now')
            WHERE id=?`,
      args: [name.trim(), company || '', email || '', phone || '', address || '', notes || '', tags || '', req.params.id],
    });

    const result = await db.execute({ sql: 'SELECT * FROM clients WHERE id = ?', args: [req.params.id] });
    res.json(row(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/clients/:id', async (req, res) => {
  try {
    const existing = await db.execute({ sql: 'SELECT id FROM clients WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Client not found' });

    const photosRes = await db.execute({
      sql: 'SELECT * FROM client_photos WHERE client_id = ?',
      args: [req.params.id],
    });
    const clientPhotos = rows(photosRes.rows);

    if (R2_ENABLED && clientPhotos.length) {
      const objects = clientPhotos.filter(p => p.drive_path).map(p => ({ Key: p.drive_path }));
      if (objects.length) {
        try {
          await r2.send(new DeleteObjectsCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Delete: { Objects: objects },
          }));
        } catch (e) { console.error('R2 deleteObjects:', e.message); }
      }
    } else if (!R2_ENABLED) {
      const clientDir = path.join(UPLOADS_DIR, req.params.id);
      if (fs.existsSync(clientDir)) fs.rmSync(clientDir, { recursive: true, force: true });
    }

    // Delete photos then client (cascade may not fire on all libSQL backends)
    await db.execute({ sql: 'DELETE FROM client_photos WHERE client_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Routes: photos ────────────────────────────────────────────────────────────

app.post('/api/clients/:id/photos', async (req, res) => {
  try {
    const existing = await db.execute({ sql: 'SELECT id FROM clients WHERE id = ?', args: [req.params.id] });
    if (!existing.rows[0]) return res.status(404).json({ error: 'Client not found' });

    const countRes = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM client_photos WHERE client_id = ?',
      args: [req.params.id],
    });
    if (Number(countRes.rows[0].n) >= 10) {
      return res.status(400).json({ error: 'Maximum of 10 photos per client reached' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  upload.single('photo')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    // Re-check count after upload
    const freshCount = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM client_photos WHERE client_id = ?',
      args: [req.params.id],
    });
    if (Number(freshCount.rows[0].n) >= 10) {
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
    await db.execute({
      sql: `INSERT INTO client_photos (id, client_id, filename, original_name, drive_path)
            VALUES (?, ?, ?, ?, ?)`,
      args: [photoId, req.params.id, filename, req.file.originalname, drivePath],
    });

    const photoRes = await db.execute({
      sql: 'SELECT * FROM client_photos WHERE id = ?',
      args: [photoId],
    });
    res.status(201).json(row(photoRes.rows[0]));
  });
});

app.delete('/api/clients/:id/photos/:photoId', async (req, res) => {
  try {
    const photoRes = await db.execute({
      sql: 'SELECT * FROM client_photos WHERE id = ? AND client_id = ?',
      args: [req.params.photoId, req.params.id],
    });
    const photo = row(photoRes.rows[0]);
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    if (R2_ENABLED && photo.drive_path) {
      try {
        await r2.send(new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: photo.drive_path,
        }));
      } catch (e) { console.error('R2 delete:', e.message); }
    } else if (!R2_ENABLED && photo.filename) {
      const filePath = path.join(UPLOADS_DIR, req.params.id, photo.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await db.execute({ sql: 'DELETE FROM client_photos WHERE id = ?', args: [req.params.photoId] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Routes: backup & info ─────────────────────────────────────────────────────

app.post('/api/backup', async (req, res) => {
  try {
    const clientsRes = await db.execute('SELECT * FROM clients');
    const photosRes  = await db.execute('SELECT * FROM client_photos');

    const result = await saveBackup({
      timestamp: new Date().toISOString(),
      version: 1,
      stats: { clients: clientsRes.rows.length, photos: photosRes.rows.length },
      clients: rows(clientsRes.rows),
      photos:  rows(photosRes.rows),
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
    db: process.env.TURSO_DATABASE_URL ? 'turso' : 'local-sqlite',
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      const dbMode = process.env.TURSO_DATABASE_URL ? `Turso (${process.env.TURSO_DATABASE_URL})` : 'local SQLite';
      const storeMode = R2_ENABLED ? `Cloudflare R2 (${process.env.R2_BUCKET_NAME})` : 'local (./uploads/ + ./backups/)';
      console.log(`\n  Sales Support CRM  →  http://localhost:${PORT}`);
      console.log(`  Database:             ${dbMode}`);
      console.log(`  Photo/backup storage: ${storeMode}\n`);
    });
  })
  .catch(err => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
