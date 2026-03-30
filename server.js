require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// ── Directory setup ───────────────────────────────────────────────────────────
const IS_VERCEL   = !!process.env.VERCEL;
const TMP         = IS_VERCEL ? '/tmp' : __dirname;
const UPLOADS_DIR = path.join(TMP, 'uploads');
const BACKUP_DIR  = path.join(TMP, 'backups');
const DB_DIR      = path.join(TMP, 'db');

[UPLOADS_DIR, BACKUP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));
if (!process.env.TURSO_DATABASE_URL) fs.mkdirSync(DB_DIR, { recursive: true });

// ── Turso / libSQL setup ──────────────────────────────────────────────────────
const tursoUrl = (process.env.TURSO_DATABASE_URL || '')
  .replace(/^libsql:\/\//, 'https://') || `file:${path.join(DB_DIR, 'clients.db')}`;

const db = createClient({
  url:       tursoUrl,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDb() {
  try { await db.execute('PRAGMA journal_mode = WAL'); } catch {}
  try { await db.execute('PRAGMA foreign_keys = ON'); } catch {}

  await db.execute(`
    CREATE TABLE IF NOT EXISTS clients (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      company               TEXT DEFAULT '',
      email                 TEXT DEFAULT '',
      phone                 TEXT DEFAULT '',
      address               TEXT DEFAULT '',
      clinic_name           TEXT DEFAULT '',
      manager               TEXT DEFAULT '',
      relevant_people       TEXT DEFAULT '',
      notes                 TEXT DEFAULT '',
      tags                  TEXT DEFAULT '',
      profile_photo         TEXT DEFAULT '',
      profile_photo_drive   TEXT DEFAULT '',
      area                  TEXT DEFAULT '',
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now'))
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
  try { await db.execute("ALTER TABLE clients ADD COLUMN clinic_name TEXT DEFAULT ''"); } catch {}
  try { await db.execute("ALTER TABLE clients ADD COLUMN manager TEXT DEFAULT ''"); } catch {}
  try { await db.execute("ALTER TABLE clients ADD COLUMN relevant_people TEXT DEFAULT ''"); } catch {}
  try { await db.execute("ALTER TABLE clients ADD COLUMN profile_photo TEXT DEFAULT ''"); } catch {}
  try { await db.execute("ALTER TABLE clients ADD COLUMN profile_photo_drive TEXT DEFAULT ''"); } catch {}
  try { await db.execute("ALTER TABLE clients ADD COLUMN area TEXT DEFAULT ''"); } catch {}
}

// Lazy init — runs once, reused across warm Vercel invocations
let _initPromise = null;
function ensureDb() {
  if (!_initPromise) _initPromise = initDb();
  return _initPromise;
}

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const dir = path.join(UPLOADS_DIR, req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(_req, file, cb) {
      cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, GIF, and WebP images are allowed'));
  },
});

// ── Auto daily backup ─────────────────────────────────────────────────────────
let lastBackupHash = null;

async function runBackupIfChanged() {
  try {
    const cr = await db.execute('SELECT * FROM clients');
    const pr = await db.execute('SELECT * FROM client_photos');
    const payload = {
      timestamp: new Date().toISOString(),
      version: 1,
      stats: { clients: cr.rows.length, photos: pr.rows.length },
      clients: cr.rows.map(r => ({ ...r })),
      photos:  pr.rows.map(r => ({ ...r })),
    };
    const content = JSON.stringify(payload);
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    if (hash === lastBackupHash) return; // no changes

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(BACKUP_DIR, `clients-${ts}.json`);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    lastBackupHash = hash;

    // Keep only the 30 most recent backups
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('clients-') && f.endsWith('.json'))
      .sort();
    if (files.length > 30) {
      files.slice(0, files.length - 30).forEach(f => {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
      });
    }

    console.log(`[backup] Saved ${filePath}`);
  } catch (err) {
    console.error('[backup] Failed:', err.message);
  }
}

function scheduleDailyBackup() {
  // Run once at startup (after a short delay to let the DB warm up)
  setTimeout(runBackupIfChanged, 5000);
  // Then every 24 hours
  setInterval(runBackupIfChanged, 24 * 60 * 60 * 1000);
}

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

// ── Photo proxy ───────────────────────────────────────────────────────────────
app.get('/api/photos/:clientId/:filename', (req, res) => {
  const { clientId, filename } = req.params;
  if (!/^[\w-]+$/.test(clientId) || !/^[\w\-.]+$/.test(filename)) return res.status(400).end();

  const filePath = path.join(UPLOADS_DIR, clientId, filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(filePath);
});

// ── Routes: clients ───────────────────────────────────────────────────────────

app.get('/api/clients', async (req, res) => {
  try {
    const like = `%${(req.query.search || '').trim()}%`;
    const result = await db.execute({
      sql: `SELECT c.*, COUNT(p.id) AS photo_count
            FROM clients c
            LEFT JOIN client_photos p ON p.client_id = c.id
            WHERE c.name  LIKE ? OR c.company  LIKE ?
               OR c.email LIKE ? OR c.phone    LIKE ?
               OR c.tags  LIKE ? OR c.area     LIKE ?
               OR c.address LIKE ? OR c.clinic_name LIKE ?
               OR c.manager LIKE ?
            GROUP BY c.id ORDER BY c.area ASC, c.clinic_name ASC`,
      args: [like, like, like, like, like, like, like, like, like],
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
    const { name, company, email, phone, address, area, clinic_name, manager, relevant_people, notes, tags } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    const id = uuidv4();
    await db.execute({
      sql: `INSERT INTO clients (id, name, company, email, phone, address, area, clinic_name, manager, relevant_people, notes, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, name.trim(), company||'', email||'', phone||'', address||'', area||'', clinic_name||'', manager||'', relevant_people||'', notes||'', tags||''],
    });
    const r = await db.execute({ sql: 'SELECT * FROM clients WHERE id = ?', args: [id] });
    res.status(201).json(row(r.rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/clients/:id', async (req, res) => {
  try {
    const { name, company, email, phone, address, area, clinic_name, manager, relevant_people, notes, tags } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    const ex = await db.execute({ sql: 'SELECT id FROM clients WHERE id = ?', args: [req.params.id] });
    if (!ex.rows[0]) return res.status(404).json({ error: 'Client not found' });

    await db.execute({
      sql: `UPDATE clients SET name=?, company=?, email=?, phone=?, address=?, area=?,
            clinic_name=?, manager=?, relevant_people=?, notes=?, tags=?,
            updated_at=datetime('now') WHERE id=?`,
      args: [name.trim(), company||'', email||'', phone||'', address||'', area||'', clinic_name||'', manager||'', relevant_people||'', notes||'', tags||'', req.params.id],
    });
    const r = await db.execute({ sql: 'SELECT * FROM clients WHERE id = ?', args: [req.params.id] });
    res.json(row(r.rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clients/:id', async (req, res) => {
  try {
    const ex = await db.execute({ sql: 'SELECT id FROM clients WHERE id = ?', args: [req.params.id] });
    if (!ex.rows[0]) return res.status(404).json({ error: 'Client not found' });

    const clientDir = path.join(UPLOADS_DIR, req.params.id);
    if (fs.existsSync(clientDir)) fs.rmSync(clientDir, { recursive: true, force: true });

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
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Maximum of 10 photos per client reached' });
    }

    const photoId = uuidv4();
    await db.execute({
      sql: `INSERT INTO client_photos (id, client_id, filename, original_name, drive_path) VALUES (?, ?, ?, ?, ?)`,
      args: [photoId, req.params.id, req.file.filename, req.file.originalname, null],
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

    const fp = path.join(UPLOADS_DIR, req.params.id, photo.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);

    await db.execute({ sql: 'DELETE FROM client_photos WHERE id = ?', args: [req.params.photoId] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Routes: profile photo ─────────────────────────────────────────────────────

app.post('/api/clients/:id/profile-photo', (req, res) => {
  upload.single('photo')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const ex = await db.execute({ sql: 'SELECT * FROM clients WHERE id = ?', args: [req.params.id] });
    const client = row(ex.rows[0]);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // Delete old profile photo if it exists
    if (client.profile_photo) {
      const old = path.join(UPLOADS_DIR, req.params.id, client.profile_photo);
      if (fs.existsSync(old)) fs.unlinkSync(old);
    }

    await db.execute({
      sql: `UPDATE clients SET profile_photo=?, profile_photo_drive='', updated_at=datetime('now') WHERE id=?`,
      args: [req.file.filename, req.params.id],
    });

    const updated = await db.execute({ sql: 'SELECT * FROM clients WHERE id = ?', args: [req.params.id] });
    res.json(row(updated.rows[0]));
  });
});

app.delete('/api/clients/:id/profile-photo', async (req, res) => {
  try {
    const ex = await db.execute({ sql: 'SELECT * FROM clients WHERE id = ?', args: [req.params.id] });
    const client = row(ex.rows[0]);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    if (client.profile_photo) {
      const fp = path.join(UPLOADS_DIR, req.params.id, client.profile_photo);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }

    await db.execute({
      sql: `UPDATE clients SET profile_photo='', profile_photo_drive='', updated_at=datetime('now') WHERE id=?`,
      args: [req.params.id],
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Export for Vercel / start for local dev ───────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  initDb()
    .then(() => {
      scheduleDailyBackup();
      app.listen(PORT, () => {
        const dbMode = process.env.TURSO_DATABASE_URL ? `Turso (${process.env.TURSO_DATABASE_URL})` : 'local SQLite';
        console.log(`\n  Sales Support CRM  →  http://localhost:${PORT}`);
        console.log(`  Database:             ${dbMode}`);
        console.log(`  Photos:               ${UPLOADS_DIR}`);
        console.log(`  Backups:              ${BACKUP_DIR} (auto daily)\n`);
      });
    })
    .catch(err => { console.error('Failed to initialise database:', err); process.exit(1); });
}

module.exports = app;
