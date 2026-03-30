/* ═══════════════════════════════════════════════════════════════
   Sales CRM – Frontend
   ═══════════════════════════════════════════════════════════════ */
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  clients: [],
  selectedId: null,
  selectedDetail: null,   // full client object with photos
  lightboxPhotos: [],
  lightboxIndex: 0,
};

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(method, url, body) {
  const opts = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]}</span><span class="toast-msg">${escHtml(msg)}</span>`;
  document.getElementById('toast-container').prepend(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function initials(name) {
  return (name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('');
}

function avatarColor(name) {
  const colors = ['#2563eb','#7c3aed','#db2777','#dc2626','#ea580c','#16a34a','#0891b2','#64748b'];
  let h = 0;
  for (const c of name || '') h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return colors[Math.abs(h) % colors.length];
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso + (iso.includes('Z') ? '' : 'Z'))
    .toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function photoUrl(clientId, filename) {
  return `/api/photos/${clientId}/${filename}`;
}

// ── Render: client list ───────────────────────────────────────────────────────
function renderList() {
  const list = document.getElementById('client-list');

  if (!state.clients.length) {
    list.innerHTML = '<div class="list-empty">No clients yet.<br>Click <strong>New Client</strong> to add one.</div>';
    return;
  }

  list.innerHTML = state.clients.map(c => `
    <div class="client-card ${c.id === state.selectedId ? 'active' : ''}"
         data-id="${escHtml(c.id)}" role="button" tabindex="0">
      <div class="card-avatar" style="background:${avatarColor(c.name)}">
        ${c.profile_photo
          ? `<img src="${photoUrl(c.id, c.profile_photo)}" alt="${escHtml(c.name)}" />`
          : escHtml(initials(c.name))}
      </div>
      <div class="card-info">
        <div class="card-name">${escHtml(c.name)}</div>
        <div class="card-sub">${escHtml(c.manager || c.clinic_name || c.email || '—')}</div>
      </div>
      ${c.photo_count > 0
        ? `<span class="card-badge" title="${c.photo_count} photo${c.photo_count !== 1 ? 's' : ''}">📷 ${c.photo_count}</span>`
        : ''}
    </div>
  `).join('');

  list.querySelectorAll('.client-card').forEach(card => {
    card.addEventListener('click', () => selectClient(card.dataset.id));
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') selectClient(card.dataset.id); });
  });
}

// ── Render: detail ────────────────────────────────────────────────────────────
function renderDetail(client) {
  const emptyState = document.getElementById('empty-state');
  const detail = document.getElementById('detail');

  if (!client) {
    emptyState.hidden = false;
    detail.hidden = true;
    return;
  }

  emptyState.hidden = true;
  detail.hidden = false;

  // Avatar — show profile photo if set, otherwise initials
  const avatar = document.getElementById('detail-avatar');
  if (client.profile_photo) {
    avatar.innerHTML = `<img src="${photoUrl(client.id, client.profile_photo)}" alt="${escHtml(client.name)}" />`;
    avatar.style.background = 'transparent';
  } else {
    avatar.innerHTML = escHtml(initials(client.name));
    avatar.style.background = avatarColor(client.name);
  }

  document.getElementById('detail-name').textContent = client.clinic_name || client.name;
  document.getElementById('detail-company').textContent = client.manager || '';

  // Info grid
  const infoFields = [
    { label: 'Contact Name', value: client.name,        link: null },
    { label: 'Email',        value: client.email,       link: client.email ? `mailto:${client.email}` : null },
    { label: 'Phone',        value: client.phone,       link: client.phone ? `tel:${client.phone}` : null },
    { label: 'Address',      value: client.address,     link: null },
    { label: 'Added',        value: formatDate(client.created_at), link: null },
    { label: 'Updated',      value: formatDate(client.updated_at), link: null },
  ].filter(f => f.value);

  document.getElementById('detail-info').innerHTML = infoFields.map(f => `
    <div class="info-item">
      <div class="info-label">${escHtml(f.label)}</div>
      <div class="info-value">
        ${f.link
          ? `<a href="${escHtml(f.link)}">${escHtml(f.value)}</a>`
          : escHtml(f.value)}
      </div>
    </div>
  `).join('');

  // Relevant people
  const relevantSection = document.getElementById('detail-relevant-section');
  if (client.relevant_people && client.relevant_people.trim()) {
    document.getElementById('detail-relevant').textContent = client.relevant_people;
    relevantSection.hidden = false;
  } else {
    relevantSection.hidden = true;
  }

  // Notes
  const notesSection = document.getElementById('detail-notes-section');
  if (client.notes && client.notes.trim()) {
    document.getElementById('detail-notes').textContent = client.notes;
    notesSection.hidden = false;
  } else {
    notesSection.hidden = true;
  }

  // Tags
  const tagsSection = document.getElementById('detail-tags-section');
  const tags = (client.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  if (tags.length) {
    document.getElementById('detail-tags').innerHTML = tags
      .map(t => `<span class="tag">${escHtml(t)}</span>`).join('');
    tagsSection.hidden = false;
  } else {
    tagsSection.hidden = true;
  }

  // Photos
  renderPhotos(client);
}

function renderPhotos(client) {
  const photos = client.photos || [];
  const count = photos.length;

  document.getElementById('photo-count').textContent = `${count} / 10`;

  const uploadArea = document.getElementById('photo-upload-area');
  uploadArea.classList.toggle('hidden', count >= 10);

  const grid = document.getElementById('photo-grid');
  state.lightboxPhotos = photos;

  if (!photos.length) {
    grid.innerHTML = '';
    return;
  }

  grid.innerHTML = photos.map((p, i) => `
    <div class="photo-item" data-photo-id="${escHtml(p.id)}" data-index="${i}">
      <img src="${photoUrl(client.id, p.filename)}"
           alt="${escHtml(p.original_name || 'Photo')}"
           loading="lazy" />
      <button class="photo-delete" title="Delete photo" data-photo-id="${escHtml(p.id)}">✕</button>
    </div>
  `).join('');

  grid.querySelectorAll('.photo-item img').forEach(img => {
    img.addEventListener('click', () => {
      const idx = parseInt(img.closest('.photo-item').dataset.index, 10);
      openLightbox(idx);
    });
  });

  grid.querySelectorAll('.photo-delete').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deletePhoto(client.id, btn.dataset.photoId);
    });
  });
}

// ── Select client ─────────────────────────────────────────────────────────────
async function selectClient(id) {
  state.selectedId = id;
  renderList(); // update active state

  // On mobile, hide sidebar
  document.getElementById('sidebar').classList.remove('open');

  try {
    const client = await api('GET', `/api/clients/${id}`);
    state.selectedDetail = client;
    renderDetail(client);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Load clients ──────────────────────────────────────────────────────────────
async function loadClients(search = '') {
  try {
    const url = search ? `/api/clients?search=${encodeURIComponent(search)}` : '/api/clients';
    state.clients = await api('GET', url);
    renderList();
  } catch (err) {
    toast('Failed to load clients: ' + err.message, 'error');
  }
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(client = null) {
  const overlay  = document.getElementById('modal-overlay');
  const title    = document.getElementById('modal-title');
  const form     = document.getElementById('client-form');
  const nameErr  = document.getElementById('name-error');

  title.textContent = client ? 'Edit Client' : 'New Client';
  nameErr.textContent = '';

  // Populate form
  const fields = ['name','company','email','phone','address','clinic_name','manager','relevant_people','tags','notes'];
  fields.forEach(f => {
    const el = form.elements[f];
    if (el) el.value = client ? (client[f] || '') : '';
  });

  form.dataset.clientId = client ? client.id : '';
  overlay.hidden = false;
  form.elements['name'].focus();
}

function closeModal() {
  document.getElementById('modal-overlay').hidden = true;
}

async function submitForm(e) {
  e.preventDefault();
  const form    = document.getElementById('client-form');
  const nameEl  = form.elements['name'];
  const nameErr = document.getElementById('name-error');
  const saveBtn = document.getElementById('save-btn');

  nameErr.textContent = '';
  nameEl.classList.remove('error');
  const clinicEl = form.elements['clinic_name'];
  clinicEl.classList.remove('error');

  const clinic_name = clinicEl.value.trim();
  if (!clinic_name) {
    clinicEl.classList.add('error');
    nameErr.textContent = 'Clinic Name is required.';
    clinicEl.focus();
    return;
  }

  const name = nameEl.value.trim() || clinic_name; // fallback to clinic name if contact blank

  const payload = {
    name,
    company:          '',
    email:            form.elements['email'].value.trim(),
    phone:            form.elements['phone'].value.trim(),
    address:          form.elements['address'].value.trim(),
    clinic_name:      form.elements['clinic_name'].value.trim(),
    manager:          form.elements['manager'].value.trim(),
    relevant_people:  form.elements['relevant_people'].value.trim(),
    tags:             form.elements['tags'].value.trim(),
    notes:            form.elements['notes'].value.trim(),
  };

  const clientId = form.dataset.clientId;
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    let result;
    if (clientId) {
      result = await api('PUT', `/api/clients/${clientId}`, payload);
      toast(`${result.name} updated.`, 'success');
    } else {
      result = await api('POST', '/api/clients', payload);
      toast(`${result.name} added.`, 'success');
    }

    closeModal();
    await loadClients(document.getElementById('search-input').value.trim());

    // Refresh detail if editing current
    if (clientId && state.selectedId === clientId) {
      await selectClient(clientId);
    } else if (!clientId) {
      await selectClient(result.id);
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Client';
  }
}

// ── Delete client ─────────────────────────────────────────────────────────────
async function deleteClient() {
  if (!state.selectedId) return;
  const client = state.selectedDetail;
  if (!client) return;

  if (!confirm(`Delete "${client.name}"? This cannot be undone.`)) return;

  try {
    await api('DELETE', `/api/clients/${state.selectedId}`);
    toast(`${client.name} deleted.`, 'info');
    state.selectedId = null;
    state.selectedDetail = null;
    renderDetail(null);
    await loadClients(document.getElementById('search-input').value.trim());
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Photo upload ──────────────────────────────────────────────────────────────
async function uploadPhoto(file) {
  if (!state.selectedId) return;

  const photos = state.selectedDetail?.photos || [];
  if (photos.length >= 10) {
    toast('Maximum of 10 photos per client.', 'warning');
    return;
  }

  const grid = document.getElementById('photo-grid');
  const placeholder = document.createElement('div');
  placeholder.className = 'photo-item';
  placeholder.innerHTML = '<div class="photo-uploading"><div class="spinner"></div></div>';
  grid.appendChild(placeholder);

  const formData = new FormData();
  formData.append('photo', file);

  try {
    const res = await fetch(`/api/clients/${state.selectedId}/photos`, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    // Refresh detail
    const updated = await api('GET', `/api/clients/${state.selectedId}`);
    state.selectedDetail = updated;
    renderDetail(updated);

    // Update list badge
    await loadClients(document.getElementById('search-input').value.trim());
    toast('Photo uploaded.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    placeholder.remove();
  }
}

async function uploadProfilePhoto(file) {
  if (!state.selectedId) return;
  const wrap = document.getElementById('detail-avatar-wrap');
  wrap.style.opacity = '0.5';
  wrap.style.pointerEvents = 'none';

  const formData = new FormData();
  formData.append('photo', file);

  try {
    const res = await fetch(`/api/clients/${state.selectedId}/profile-photo`, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.selectedDetail = { ...state.selectedDetail, ...data };
    renderDetail(state.selectedDetail);
    await loadClients(document.getElementById('search-input').value.trim());
    toast('Profile photo updated.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    wrap.style.opacity = '';
    wrap.style.pointerEvents = '';
  }
}

async function deletePhoto(clientId, photoId) {
  if (!confirm('Delete this photo?')) return;
  try {
    await api('DELETE', `/api/clients/${clientId}/photos/${photoId}`);
    const updated = await api('GET', `/api/clients/${clientId}`);
    state.selectedDetail = updated;
    renderDetail(updated);
    await loadClients(document.getElementById('search-input').value.trim());
    toast('Photo deleted.', 'info');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(index) {
  if (!state.lightboxPhotos.length) return;
  state.lightboxIndex = index;
  updateLightboxImage();
  document.getElementById('lightbox-overlay').hidden = false;
}

function closeLightbox() {
  document.getElementById('lightbox-overlay').hidden = true;
}

function updateLightboxImage() {
  const p = state.lightboxPhotos[state.lightboxIndex];
  if (!p) return;
  const img = document.getElementById('lightbox-img');
  img.src = photoUrl(state.selectedId, p.filename);
  img.alt = p.original_name || 'Photo';
}

function lightboxNav(dir) {
  const len = state.lightboxPhotos.length;
  state.lightboxIndex = (state.lightboxIndex + dir + len) % len;
  updateLightboxImage();
}

// ── Backup ────────────────────────────────────────────────────────────────────
async function triggerBackup() {
  const btn = document.getElementById('backup-btn');
  btn.disabled = true;
  btn.innerHTML = '<span>☁</span> Backing up…';
  try {
    const result = await api('POST', '/api/backup');
    if (result.type === 's3') {
      toast('Backup saved to S3.', 'success');
    } else {
      toast(`Backup saved locally: ${result.location.split('/').slice(-1)[0]}`, 'success');
    }
  } catch (err) {
    toast('Backup failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>☁</span> Backup Now';
  }
}

// ── Storage info badge ────────────────────────────────────────────────────────
async function loadStorageInfo() {
  try {
    const info = await api('GET', '/api/info');
    const badge = document.getElementById('storage-badge');
    if (info.r2Enabled) {
      badge.textContent = `R2: ${info.bucket}`;
      badge.title = `Photos and backups stored on Cloudflare R2 bucket: ${info.bucket}`;
    } else {
      badge.textContent = 'Local storage';
      badge.title = 'Photos and backups saved locally — add R2 credentials to .env for cloud storage';
    }
  } catch {}
}

// ── Search (debounced) ────────────────────────────────────────────────────────
let searchTimer;
function onSearch(e) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = e.target.value.trim();
    loadClients(q);
    // If searching, clear selection
    if (q) {
      state.selectedId = null;
      renderDetail(null);
    }
  }, 280);
}

// ── Mobile ────────────────────────────────────────────────────────────────────
function injectMobileTopbar() {
  if (document.getElementById('mobile-topbar')) return;
  const bar = document.createElement('div');
  bar.className = 'mobile-topbar';
  bar.id = 'mobile-topbar';
  bar.innerHTML = `
    <div class="mobile-topbar-left">
      <button class="mobile-menu-btn" id="mobile-menu-btn" aria-label="Open client list">☰</button>
      <span>Sales CRM</span>
    </div>
    <button class="btn btn-primary btn-sm" id="mobile-add-btn">+ Add</button>
  `;
  document.getElementById('main').prepend(bar);

  document.getElementById('mobile-menu-btn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
  document.getElementById('mobile-add-btn').addEventListener('click', () => openModal());
}

// ── Init ──────────────────────────────────────────────────────────────────────
function bindEvents() {
  // Add buttons
  document.getElementById('add-btn').addEventListener('click', () => openModal());
  document.getElementById('empty-add-btn').addEventListener('click', () => openModal());

  // Edit / Delete
  document.getElementById('edit-btn').addEventListener('click', () => {
    if (state.selectedDetail) openModal(state.selectedDetail);
  });
  document.getElementById('delete-btn').addEventListener('click', deleteClient);

  // Back (mobile)
  document.getElementById('back-btn').addEventListener('click', () => {
    state.selectedId = null;
    renderDetail(null);
    renderList();
    document.getElementById('sidebar').classList.add('open');
  });

  // Modal
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('cancel-btn').addEventListener('click', closeModal);
  document.getElementById('client-form').addEventListener('submit', submitForm);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Profile photo upload
  const profilePhotoInput = document.getElementById('profile-photo-input');
  document.getElementById('detail-avatar-wrap').addEventListener('click', () => profilePhotoInput.click());
  profilePhotoInput.addEventListener('change', () => {
    const file = profilePhotoInput.files[0];
    if (file) { uploadProfilePhoto(file); profilePhotoInput.value = ''; }
  });

  // Photo upload
  const photoInput = document.getElementById('photo-input');
  const uploadArea = document.getElementById('photo-upload-area');

  document.getElementById('browse-btn').addEventListener('click', () => photoInput.click());

  photoInput.addEventListener('change', () => {
    const file = photoInput.files[0];
    if (file) { uploadPhoto(file); photoInput.value = ''; }
  });

  uploadArea.addEventListener('click', e => {
    if (e.target === uploadArea || e.target.closest('.upload-prompt') && !e.target.classList.contains('link-btn')) {
      photoInput.click();
    }
  });

  uploadArea.addEventListener('dragover', e => {
    e.preventDefault();
    uploadArea.classList.add('drag-over');
  });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
  uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) uploadPhoto(file);
  });

  // Lightbox
  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  document.getElementById('lightbox-prev').addEventListener('click', () => lightboxNav(-1));
  document.getElementById('lightbox-next').addEventListener('click', () => lightboxNav(1));
  document.getElementById('lightbox-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeLightbox();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!document.getElementById('lightbox-overlay').hidden) { closeLightbox(); return; }
      if (!document.getElementById('modal-overlay').hidden) { closeModal(); return; }
    }
    if (e.key === 'ArrowLeft'  && !document.getElementById('lightbox-overlay').hidden) lightboxNav(-1);
    if (e.key === 'ArrowRight' && !document.getElementById('lightbox-overlay').hidden) lightboxNav(1);
  });

  // Backup
  document.getElementById('backup-btn').addEventListener('click', triggerBackup);

  // Search
  document.getElementById('search-input').addEventListener('input', onSearch);
}

async function init() {
  injectMobileTopbar();
  bindEvents();
  await loadClients();
  await loadStorageInfo();
}

init();
