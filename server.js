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

// ── Directory setup ───────────────────────────────────────────────────────────
// On Vercel the project root is read-only; use /tmp for any local fallback paths.
const IS_VERCEL   = !!process.env.VERCEL;
const TMP         = IS_VERCEL ? '/tmp' : __dirname;
const UPLOADS_DIR = path.join(TMP, 'uploads');
const BACKUP_DIR  = path.join(TMP, 'backups');
const DB_DIR      = path.join(TMP, 'db');

// Only create dirs that will actually be used
if (!R2_ENABLED)                          [UPLOADS_DIR, BACKUP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));
if (!process.env.TURSO_DATABASE_URL)      fs.mkdirSync(DB_DIR, { recursive: true });

// ── Turso / libSQL setup ──────────────────────────────────────────────────────
const db = createClient({
  url:       process.env.TURSO_DATABASE_URL || `file:${path.join(DB_DIR, 'clients.db')}`,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDb() {
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

  try { await db.execute('ALTER TABLE client_photos ADD COLUMN drive_path TEXT'); } catch {}
}

// Lazy init — runs once, reused across warm Vercel invocations
let _initPromise = null;
function ensureDb() {
  if (!_initPromise) _initPromise = initDb();
  return _initPromise;
}

// ── Multer ────────────────────────────────────────────────────────────────────
const multerStorage = R2_ENABLED
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination(req, _file, cb) {
        const dir = path.join(UPLOADS_DIR, req.params.id);
        fs.mkdirSync(dir, { recursive: true });
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

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure DB is ready before every request
app.use(async (_req, res, next) => {
  try { await ensureDb(); next(); }
  catch (err) {
    console.error('DB init error:', err);
    res.status(500).json({ error: 'Database initialisation failed: ' + err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function row(r)   { return r ? { ...r } : null; }
function rows(rs) { return rs.map(r => ({ ...r })); }

async function saveBackup(payload) {
  const ts      = new Date().toISOString().replace(/[:.]/g, '-');
  const content = JSON.stringify(payload, null, 2);

  if (R2_ENABLED) {
    const key = `backups/clients-${ts}.json`;
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key, Body: content, ContentType: 'application/json',
    }));
    return { type: 'r2', location: key };
  } else {
    const filePath = path.join(BACKUP_DIR, `clients-${ts}.json`);
    fs.writeFileSync(filePath, content, 'utf8');
    return { type: 'local', location: filePath };
  }
}

// ── Photo proxy ───────────────────────────────────────────────────────────────
app.get('/api/photos/:clientId/:filename', async (req, res) => {
  const { clientId, filename } = req.params;
  if (!/^[\w-]+$/.test(clientId) || !/^[\w\-.]+$/.test(filename)) return res.status(400).end();

  const ext = path.extname(filename).toLowerCase();
  const contentTypes = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png',  '.gif':  'image/gif',  '.webp': 'image/webp',
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
            WHERE c.name  LIKE ? OR c.company LIKE ?
               OR c.email LIKE ? OR c.phone   LIKE ?
               OR c.tags  LIKE ?
            GROUP BY c.id ORDER BY c.updated_at DESC`,
      args: [like, like, like, like, like],
    });
    res.json(rows(result.rows));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clients/:id', async (req, res) => {
  try {
    const cr = await db.execute({ sql: 'SELECT * FROM clients WHERE id = ?', args: [req.params.id] });
    const client = row(cr.rows[0]);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const pr = await db.execute({
      sql: 'SELECT * FROM client_photos WHERE client_id = ? ORDER BY created_at ASC',
      args: [req.params.id],
    });
    res.json({ ...client, photos: rows(pr.rows) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clients', async (req, res) => {
  try {
    const { name, company, email, phone, address, notes, tags } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    const id = uuidv4();
    await db.execute({
      sql: `INSERT INTO clients (id, name, company, email, phone, address, notes, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, name.trim(), company||'', email||'', phone||'', address||'', notes||'', tags||''],
    });
    const r = await db.execute({ sql: 'SELECT * FROM clients WHERE id = ?', args: [id] });
    res.status(201).json(row(r.rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/clients/:id', async (req, res) => {
  try {
    const { name, company, email, phone, address, notes, tags } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    const ex = await db.execute({ sql: 'SELECT id FROM clients WHERE id = ?', args: [req.params.id] });
    if (!ex.rows[0]) return res.status(404).json({ error: 'Client not found' });

    await db.execute({
      sql: `UPDATE clients SET name=?, company=?, email=?, phone=?, address=?, notes=?, tags=?,
            updated_at=datetime('now') WHERE id=?`,
      args: [name.trim(), company||'', email||'', phone||'', address||'', notes||'', tags||'', req.params.id],
    });
    const r = await db.execute({ sql: 'SELECT * FROM clients WHERE id = ?', args: [req.params.id] });
    res.json(row(r.rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clients/:id', async (req, res) => {
  try {
    const ex = await db.execute({ sql: 'SELECT id FROM clients WHERE id = ?', args: [req.params.id] });
    if (!ex.rows[0]) return res.status(404).json({ error: 'Client not found' });

    const pr = await db.execute({ sql: 'SELECT * FROM client_photos WHERE client_id = ?', args: [req.params.id] });
    const clientPhotos = rows(pr.rows);

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

    await db.execute({ sql: 'DELETE FROM client_photos WHERE client_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Routes: photos ────────────────────────────────────────────────────────────

app.post('/api/clients/:id/photos', async (req, res) => {
  try {
    const ex = await db.execute({ sql: 'SELECT id FROM clients WHERE id = ?', args: [req.params.id] });
    if (!ex.rows[0]) return res.status(404).json({ error: 'Client not found' });

    const cr = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM client_photos WHERE client_id = ?', args: [req.params.id] });
    if (Number(cr.rows[0].n) >= 10) return res.status(400).json({ error: 'Maximum of 10 photos per client reached' });
  } catch (err) { return res.status(500).json({ error: err.message }); }

  upload.single('photo')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const fc = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM client_photos WHERE client_id = ?', args: [req.params.id] });
    if (Number(fc.rows[0].n) >= 10) {
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
          Key: drivePath, Body: req.file.buffer, ContentType: req.file.mimetype,
        }));
      } catch (e) { return res.status(500).json({ error: 'Failed to upload to R2: ' + e.message }); }
    } else {
      filename  = req.file.filename;
      drivePath = null;
    }

    const photoId = uuidv4();
    await db.execute({
      sql: `INSERT INTO client_photos (id, client_id, filename, original_name, drive_path) VALUES (?, ?, ?, ?, ?)`,
      args: [photoId, req.params.id, filename, req.file.originalname, drivePath],
    });
    const pr = await db.execute({ sql: 'SELECT * FROM client_photos WHERE id = ?', args: [photoId] });
    res.status(201).json(row(pr.rows[0]));
  });
});

app.delete('/api/clients/:id/photos/:photoId', async (req, res) => {
  try {
    const pr = await db.execute({
      sql: 'SELECT * FROM client_photos WHERE id = ? AND client_id = ?',
      args: [req.params.photoId, req.params.id],
    });
    const photo = row(pr.rows[0]);
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    if (R2_ENABLED && photo.drive_path) {
      try { await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: photo.drive_path })); }
      catch (e) { console.error('R2 delete:', e.message); }
    } else if (!R2_ENABLED && photo.filename) {
      const fp = path.join(UPLOADS_DIR, req.params.id, photo.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }

    await db.execute({ sql: 'DELETE FROM client_photos WHERE id = ?', args: [req.params.photoId] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Routes: backup & info ─────────────────────────────────────────────────────

app.post('/api/backup', async (req, res) => {
  try {
    const cr = await db.execute('SELECT * FROM clients');
    const pr = await db.execute('SELECT * FROM client_photos');
    const result = await saveBackup({
      timestamp: new Date().toISOString(), version: 1,
      stats: { clients: cr.rows.length, photos: pr.rows.length },
      clients: rows(cr.rows), photos: rows(pr.rows),
    });
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/info', (_req, res) => {
  res.json({
    r2Enabled:   R2_ENABLED,
    storageType: R2_ENABLED ? 'cloudflare-r2' : 'local',
    bucket:      R2_ENABLED ? process.env.R2_BUCKET_NAME : null,
    db:          process.env.TURSO_DATABASE_URL ? 'turso' : 'local-sqlite',
  });
});

// ── Export for Vercel / start for local dev ───────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  initDb()
    .then(() => app.listen(PORT, () => {
      const dbMode    = process.env.TURSO_DATABASE_URL ? `Turso (${process.env.TURSO_DATABASE_URL})` : 'local SQLite';
      const storeMode = R2_ENABLED ? `Cloudflare R2 (${process.env.R2_BUCKET_NAME})` : 'local (./uploads/ + ./backups/)';
      console.log(`\n  Sales Support CRM  →  http://localhost:${PORT}`);
      console.log(`  Database:             ${dbMode}`);
      console.log(`  Photo/backup storage: ${storeMode}\n`);
    }))
    .catch(err => { console.error('Failed to initialise database:', err); process.exit(1); });
}

module.exports = app;
