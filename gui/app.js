const $ = (id) => document.getElementById(id);

const API_BASE = location.protocol === 'http:' ? location.origin : (window.fsApp?.apiBase || 'http://127.0.0.1:8899');

const state = {
  profiles: [],
  selected: null,
  current: null,
  deviceType: 'Windows',
  checked: new Set(),
  uploadChecked: new Set(),
  pending: new Set(),
  checkingUids: new Set(),
  checkingAll: false,
  deletingDead: false
};

const api = {
  async get(path) {
    const r = await fetch(API_BASE + '/api' + path, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    return r.json();
  },
  async post(path, body, signal = AbortSignal.timeout(150000)) {
    const r = await fetch(API_BASE + '/api' + path, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
  async del(path) {
    const r = await fetch(API_BASE + '/api' + path, { method: 'DELETE', signal: AbortSignal.timeout(150000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  }
};

function renderProfileList() {
  if (page === 'dashboard') renderDashboard();
  if (page === 'profiles') renderDirectory();
  if (page === 'upload') renderUploadPicker();
  renderBulkBar();
  renderUidControls();
}

function uidState(profile) {
  if (!profile) return 'unchecked';
  if (state.checkingUids.has(profile.name)) return 'checking';
  const result = profile.uidCheck?.state;
  return ['alive', 'dead', 'error', 'skipped'].includes(result) ? result : 'unchecked';
}

function uidLabel(profile) {
  if (state.checkingUids.has(profile.name)) return 'Checking UID…';
  return ({ alive: 'Alive', dead: 'Dead', error: 'Check failed', skipped: 'No UID' })[profile.uidCheck?.state] || (profile.uid ? 'Not checked' : 'No UID');
}

function deadProfiles() {
  return state.profiles.filter(p => p.uidCheck?.state === 'dead' && Date.now() - p.uidCheck.checkedAt < 15 * 60 * 1000 && !state.checkingUids.has(p.name));
}

function renderUidControls() {
  const dead = deadProfiles();
  $('btn-check-all').disabled = state.checkingAll || state.checkingUids.size > 0 || state.deletingDead || !state.profiles.length;
  $('btn-check-all').textContent = state.checkingAll ? 'Checking UIDs…' : 'Check all UIDs';
  $('directory-check').disabled = !state.checked.size || $('btn-check-all').disabled;
  $('btn-delete-dead').classList.toggle('hidden', !dead.length);
  $('btn-delete-dead').textContent = `Delete dead profiles (${dead.length})`;
  $('btn-delete-dead').disabled = state.checkingAll || state.checkingUids.size > 0 || state.deletingDead;
  const profile = state.profiles.find(p => p.name === state.selected);
  $('btn-check-uid').disabled = !profile || state.checkingAll || state.checkingUids.has(profile.name) || state.deletingDead;
  $('d-uid-status').textContent = profile ? `UID ${profile.uid || 'unavailable'} · ${uidLabel(profile)}` : 'UID not checked';
  $('d-uid-status').dataset.state = uidState(profile);
  $('d-uid-status').classList.add('uid-status');
  $('d-uid-status').title = profile?.uidCheck?.message || '';
}

async function checkOneUid(name) {
  if (state.checkingUids.has(name)) return;
  state.checkingUids.add(name);
  const profile = state.profiles.find(p => p.name === name);
  if (profile) profile.uidCheck = null;
  renderProfileList();
  try {
    const response = await api.post('/profiles/' + encodeURIComponent(name) + '/check-uid');
    const current = state.profiles.find(p => p.name === name);
    if (current) current.uidCheck = response.uidCheck;
    return response.uidCheck;
  } catch (error) {
    const result = { state: 'error', message: error.message, checkedAt: Date.now() };
    const current = state.profiles.find(p => p.name === name);
    if (current) current.uidCheck = result;
    return result;
  } finally {
    state.checkingUids.delete(name);
    renderProfileList();
  }
}

async function checkAllUids(names = state.profiles.map(p => p.name)) {
  if (state.checkingAll || state.checkingUids.size || state.deletingDead) return;
  state.checkingAll = true;
  let next = 0, done = 0;
  const counts = { alive: 0, dead: 0, error: 0, skipped: 0 };
  const progress = () => { $('uid-progress').textContent = `${done}/${names.length} checked · ${counts.alive} alive · ${counts.dead} dead · ${counts.error} failed · ${counts.skipped} no UID`; };
  progress();
  renderUidControls();
  try {
    await Promise.all(Array.from({ length: Math.min(3, names.length) }, async () => {
      while (next < names.length) {
        const result = await checkOneUid(names[next++]);
        counts[result?.state in counts ? result.state : 'error']++;
        done++;
        progress();
      }
    }));
    toast(`UID check complete: ${counts.alive} alive, ${counts.dead} dead, ${counts.error} failed`);
  } finally { state.checkingAll = false; renderUidControls(); }
}

async function deleteDeadProfiles() {
  if (state.checkingAll || state.checkingUids.size || state.deletingDead) return;
  const names = deadProfiles().map(p => p.name);
  if (!names.length) return;
  state.deletingDead = true;
  renderUidControls();
  try {
    const confirmed = await confirmDialog('Delete dead profiles?', `check.fb.tools reported these ${names.length} profiles as invalid or nonexistent:\n${names.join(', ')}\n\nDelete their profiles and browser data permanently? Failed checks and profiles without UIDs are excluded.`, 'Delete dead profiles');
    if (!confirmed) return;
    const result = await api.post('/profiles/delete-many', { names, onlyDead: true });
    for (const name of result.deleted) state.checked.delete(name);
    await refreshProfiles();
    toast(`Deleted ${result.deleted.length} dead profiles${result.skipped?.length ? `; ${result.skipped.length} skipped (check again)` : ''}`);
  } catch (error) { showError(error); }
  finally { state.deletingDead = false; renderUidControls(); }
}

function renderBulkBar() {
  const n = state.checked.size;
  if (page === 'profiles') {
    const visible = directoryProfiles();
    const checked = visible.filter(p => state.checked.has(p.name)).length;
    $('directory-all').disabled = !visible.length;
    $('directory-all').checked = !!visible.length && checked === visible.length;
    $('directory-all').indeterminate = checked > 0 && checked < visible.length;
    const hidden = n - checked;
    $('directory-count').textContent = n + ' selected' + (hidden ? ' (' + hidden + ' outside this search)' : '');
    for (const id of ['directory-clear', 'directory-delete']) $(id).disabled = !n;
    $('directory-check').disabled = !n || $('btn-check-all').disabled;
  }

}

function setChecked(names, checked) {
  for (const name of names) {
    if (checked) state.checked.add(name);
    else state.checked.delete(name);
  }
  for (const box of document.querySelectorAll('#directory-rows input')) {
    box.checked = state.checked.has(box.dataset.name);
  }
  renderBulkBar();
}

function renderDashboard() {
  const total = state.profiles.length;
  $('dashboard-welcome').classList.toggle('hidden', total > 0);
  $('dashboard-summary').classList.toggle('hidden', !total);
  $('total-profiles').textContent = total;
  $('running-profiles').textContent = state.profiles.filter(p => p.running).length;
  $('stopped-profiles').textContent = state.profiles.filter(p => p.state === 'stopped').length;

}

function filteredProfiles(prefix) {
  const query = $(prefix + '-search').value.trim().toLowerCase();
  const order = $(prefix + '-sort').value;
  return state.profiles.filter(p =>
    [p.name, p.uid, 'Profile ' + (p.serialNumber ?? ''), p.browserPlatform].join(' ').toLowerCase().includes(query)
  ).sort((a, b) => {
    if (order === 'uid') {
      if (!!a.uid !== !!b.uid) return a.uid ? -1 : 1;
      const compared = String(a.uid || a.name).localeCompare(String(b.uid || b.name), undefined, { numeric: true });
      if (compared) return compared;
    }
    if (order === 'created') {
      const compared = (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0);
      if (compared) return compared;
    }
    return (a.serialNumber || 0) - (b.serialNumber || 0) || a.name.localeCompare(b.name);
  });
}

function profileDisplay(p, format) {
  if (format === 'number') return { title: 'Profile ' + (p.serialNumber ?? '—'), subtitle: p.uid || p.name };
  return { title: p.uid || p.name, subtitle: '#' + (p.serialNumber ?? '—') + ' · ' + (p.browserPlatform || '') };
}

function directoryProfiles() {
  return filteredProfiles('directory');
}

let pickerMarkup = null;
function renderUploadPicker() {
  const choosing = $('u-selected').checked;
  $('upload-picker').classList.toggle('hidden', !choosing);
  $('u-sel-count').textContent = state.uploadChecked.size + ' selected';
  $('u-total-count').textContent = state.profiles.length + ' available';
  const profiles = filteredProfiles('picker');
  const visibleSelected = profiles.filter(p => state.uploadChecked.has(p.name)).length;
  $('picker-all').disabled = !profiles.length;
  $('picker-all').checked = !!profiles.length && visibleSelected === profiles.length;
  $('picker-all').indeterminate = visibleSelected > 0 && visibleSelected < profiles.length;
  $('picker-select-label').textContent = $('picker-search').value.trim() ? 'Select matches' : 'Select all';
  const hidden = state.uploadChecked.size - visibleSelected;
  $('picker-count').textContent = state.uploadChecked.size + ' selected' + (hidden ? ' · ' + hidden + ' outside search' : '');
  $('picker-clear').disabled = !state.uploadChecked.size;
  const markup = profiles.map(p => {
    const display = profileDisplay(p, $('picker-format').value);
    return `<label class="picker-profile"><input class="modern-check" type="checkbox" data-name="${escapeHtml(p.name)}" aria-label="Select ${escapeHtml(display.title)}">
      <span><strong>${escapeHtml(display.title)}</strong><small>${escapeHtml(display.subtitle)}</small></span></label>`;
  }).join('') || '<p class="muted">No matching profiles.</p>';
  if (markup !== pickerMarkup) {
    const focusedName = $('picker-list').querySelector(':focus')?.dataset.name;
    $('picker-list').innerHTML = markup;
    pickerMarkup = markup;
    if (focusedName) [...$('picker-list').querySelectorAll('input')].find(el => el.dataset.name === focusedName)?.focus({ preventScroll: true });
  }
  for (const box of $('picker-list').querySelectorAll('input')) box.checked = state.uploadChecked.has(box.dataset.name);
}

function setUploadChecked(names, checked) {
  for (const name of names) {
    if (checked) state.uploadChecked.add(name);
    else state.uploadChecked.delete(name);
  }
  renderUploadPicker();
}

function updateParallel(value) {
  const count = Math.max(1, Math.min(10, Math.trunc(Number(value)) || 1));
  $('u-parallel').value = count;
  $('parallel-less').disabled = count === 1;
  $('parallel-more').disabled = count === 10;
  return count;
}

let directoryMarkup = null;
function renderDirectory() {
  const profiles = directoryProfiles();
  const filtered = !!$('directory-search').value.trim();
  $('select-label').textContent = filtered ? 'Select all matches (' + profiles.length + ')' : 'Select all profiles';
  $('directory-all').parentElement.title = $('select-label').textContent;
  $('directory-empty').classList.toggle('hidden', !!profiles.length);
  $('directory-empty').textContent = filtered ? 'No matching profiles.' : 'Create or import a profile to get started.';
  const markup = profiles.map(p => {
    const name = escapeHtml(p.name);
    const login = p.composerLogin?.state;
    const loginLabel = { logged_in: 'Logged in', logged_out: 'Logged out / cookie expired · Log in again or delete', checkpoint: 'Facebook verification needed', unverified: 'Login unverified · Check Facebook' }[login];
    const checkedAt = Number(p.composerLogin?.checkedAt);
    const loginTip = Number.isFinite(checkedAt) ? `Last composer login check: ${new Date(checkedAt).toLocaleString()}` : 'Last composer login check';
    const sessionHint = loginLabel ? `<small class="composer-login ${login === 'logged_in' ? 'valid' : login === 'logged_out' ? 'expired' : 'attention'}" title="${escapeHtml(loginTip)}">${escapeHtml(loginLabel)}</small>` : '';
    const acc = p.accountStatus;
    let accHint = '';
    if (acc) {
      if (acc.risk) {
        accHint = `<small class="composer-login risk" title="${escapeHtml(acc.error || 'Account Status scan failed — log in again or fix this profile')}">Risk</small>`;
      } else if (acc.failed) {
        accHint = `<small class="composer-login attention" title="${escapeHtml(acc.error || 'Account Status scan failed')}">Account check failed</small>`;
      } else {
        const scanned = Number(acc.scannedAt);
        const scannedTip = Number.isFinite(scanned) ? `Last Account Status scan: ${new Date(scanned).toLocaleString()}` : 'Last Account Status scan';
        accHint = `<small class="composer-login ${acc.warningCount ? 'attention' : 'valid'}" title="${escapeHtml(`${scannedTip} · ${acc.totalCount} managed Pages · ${acc.warningCount} warning · ${acc.unknownCount} unverified`)}">${acc.warningCount} Pages Warning</small>`;
      }
    }
    const display = profileDisplay(p, $('directory-format').value);
    const busy = state.pending.has(p.name) || ['starting', 'stopping'].includes(p.state);
    const action = p.running ? 'Stop' : 'Start';
    const status = busy ? (p.state === 'stopping' ? 'Stopping…' : 'Starting…') : p.state;
    return `<tr><td><label class="check-control"><input class="modern-check" type="checkbox" data-name="${name}" aria-label="Select ${name}"></label></td>
      <td><span class="profile-name">${escapeHtml(display.title)}</span><small>${escapeHtml(display.subtitle)}</small>${sessionHint}${accHint}</td>
      <td><span class="pill ${p.running ? 'running' : ''}">${escapeHtml(status)}</span></td>
      <td><span class="uid-status" data-state="${uidState(p)}">${escapeHtml(uidLabel(p))}</span></td>
      <td><div class="row-actions">
        <button class="profile-toggle ${p.running ? 'is-running' : ''}" data-action="toggle" data-name="${name}"
          aria-label="${action} ${name}" title="${action} browser" ${busy ? 'disabled aria-busy="true"' : ''}>
          <svg class="icon" aria-hidden="true"><use href="#icon-${p.running ? 'stop' : 'play'}"/></svg>
        </button>
        <button data-action="info" data-name="${name}" aria-label="Details for ${name}" title="Device and proxy settings">
          <svg class="icon" aria-hidden="true"><use href="#icon-info"/></svg>
        </button>
      </div></td></tr>`;

  }).join('');
  if (markup !== directoryMarkup) {
    const previous = $('directory-rows').querySelector(':focus');
    $('directory-rows').innerHTML = markup;
    directoryMarkup = markup;
    if (previous) {
      const replacement = [...$('directory-rows').querySelectorAll(previous.tagName)].find(el => el.dataset.name === previous.dataset.name && el.dataset.action === previous.dataset.action);
      replacement?.focus({ preventScroll: true });
    }
  }
  for (const box of $('directory-rows').querySelectorAll('input')) box.checked = state.checked.has(box.dataset.name);
}

function confirmDialog(title, text, okLabel = 'Delete') {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-yes').textContent = okLabel;
    $('confirm-modal').classList.remove('hidden');
    const done = (val) => {
      $('confirm-modal').classList.add('hidden');
      $('confirm-yes').onclick = null;
      $('confirm-no').onclick = null;
      $('confirm-modal').onclick = null;
      resolve(val);
    };
    $('confirm-yes').onclick = () => done(true);
    $('confirm-no').onclick = () => done(false);
    $('confirm-modal').onclick = (e) => { if (e.target === $('confirm-modal')) done(false); };
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function showError(error) { toast(error.message || 'Request failed. Please retry.', true); }

function kv(rows) {
  return rows
    .filter((r) => r[1] !== undefined && r[1] !== null && r[1] !== '')
    .map(([k, v]) => `<div class="kvrow"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`)
    .join('');
}

const views = { dashboard: 'dashboard', profiles: 'profiles-page', detail: 'detail', create: 'create-modal', import: 'import-modal', upload: 'upload-modal', downloads: 'downloads-page' };
const titles = { dashboard: 'Dashboard', profiles: 'Profiles', detail: 'Profile details', create: 'Create Profile', import: 'Import Cookies', upload: 'Reels Upload', downloads: 'Download Videos' };
let page = 'dashboard';
let workflowOrigin = 'dashboard';

function showPage(next) {
  if (['dashboard', 'profiles', 'detail'].includes(page)) workflowOrigin = page;
  page = next;
  scheduleDashboardMonitor();
  for (const [key, id] of Object.entries(views)) $(id).classList.toggle('hidden', key !== next);
  for (const key of ['dashboard', 'profiles', 'create', 'import', 'upload', 'downloads']) {
    if (key === next) $('btn-' + key).setAttribute('aria-current', 'page');
    else $('btn-' + key).removeAttribute('aria-current');
  }
  $('page-label').textContent = titles[next];
  $('main').scrollTop = 0;
  renderProfileList();
}

function leaveWorkflow(key) {
  if (page !== key) return;
  if (workflowOrigin === 'detail' && state.current?.name === state.selected && state.current) showPage('detail');
  else showPage(workflowOrigin === 'profiles' ? 'profiles' : 'dashboard');
  $('btn-' + key).focus();
}

function renderDetail(p) {
  showPage('detail');
  $('d-name').textContent = p.name;
  $('d-platform').textContent = p.browserPlatform || (p.isMobile ? 'Android' : 'Windows');

  const hw = p.hardware || {};
  const dev = p.device || {};
  $('kv-device').innerHTML = kv([
    ['Type', p.isMobile ? 'Mobile' : 'Desktop'],
    ['Platform', p.browserPlatform],
    ['Device name', dev.name],
    ['CPU cores', hw.cpu],
    ['RAM (GB)', hw.ram]
  ]);

  populateProxy(p.proxy);
  setStatus();
}

function populateProxy(px = {}) {
  $('f-proxy-scheme').value = px?.scheme || 'http';
  $('f-proxy-host').value = px?.host || '';
  $('f-proxy-port').value = px?.port || '';
  $('f-proxy-user').value = px?.username || '';
  $('f-proxy-pass').value = px?.password || '';
}

function setStatus() {
  renderUidControls();
  const p = state.profiles.find((x) => x.name === state.selected);
  const pill = $('d-status');
  const btn = $('btn-start');
  btn.disabled = !p || state.pending.has(state.selected) || ['starting', 'stopping'].includes(p.state);
  if (!p) {
    pill.className = 'pill stopped';
    pill.textContent = 'stopped';
    btn.textContent = 'Start';
    return;
  }
  if (p.running) {
    pill.className = 'pill running';
    pill.textContent = 'running';
    btn.textContent = 'Stop';
  } else if (['starting', 'stopping'].includes(p.state)) {
    pill.className = 'pill starting';
    pill.textContent = p.state;
    btn.textContent = p.state === 'starting' ? 'Starting…' : 'Stopping…';
  } else {
    pill.className = 'pill stopped';
    pill.textContent = 'stopped';
    btn.textContent = 'Start';
  }
}

let refreshVersion = 0;
async function refreshProfiles() {
  const version = ++refreshVersion;
  const data = await api.get('/profiles');
  if (version !== refreshVersion) return;
  state.profiles = data.list;
  $('connection-status').textContent = 'Connected';
  $('connection-status').classList.remove('offline');
  for (const selection of [state.checked, state.uploadChecked]) {
    for (const name of selection) {
      if (!state.profiles.some(p => p.name === name)) selection.delete(name);
    }
  }
  if (!state.profiles.some((p) => p.name === state.selected)) {
    state.selected = null;
    state.current = null;
    if (page === 'detail') showPage('dashboard');
  }
  renderProfileList();
  setStatus();
}

let selectionVersion = 0;
async function selectProfile(name) {
  const version = ++selectionVersion;
  state.selected = name;
  state.current = null;
  if (page === 'detail') showPage('profiles');
  const p = await api.get('/profiles/' + encodeURIComponent(name));
  if (version !== selectionVersion || state.selected !== name) return;
  state.current = p;
  renderDetail(p);
  $('d-name').focus();
}

async function toggleStart(name = state.selected) {
  const profile = state.profiles.find((p) => p.name === name);
  if (!profile || state.pending.has(name) || ['starting', 'stopping'].includes(profile.state)) return;
  const action = profile.running ? 'stop' : 'start';
  state.pending.add(name);
  profile.state = action === 'start' ? 'starting' : 'stopping';
  renderProfileList();
  setStatus();
  try {
    await api.post('/profiles/' + encodeURIComponent(name) + '/' + action);
    toast(action === 'start' ? 'Profile started' : 'Profile stopped');
  } catch (error) { showError(error); }
  finally {
    state.pending.delete(name);
    await refreshProfiles().catch(showError);
    setStatus();
  }
}

async function deleteProfile() {
  const name = state.selected;
  if (!name) return;
  const ok = await confirmDialog(
    'Delete profile?',
    'Delete "' + name + '" and all of its browser data? This cannot be undone.',
    'Delete'
  );
  if (!ok) return;
  try {
    await api.del('/profiles/' + encodeURIComponent(name));
    state.checked.delete(name);
    state.selected = null;
    await refreshProfiles();
    if (page === 'detail') showPage('dashboard');
    toast('Profile deleted');
  } catch (e) {
    toast('Delete failed: ' + e.message, true);
  }
}

async function bulkDelete() {
  const names = [...state.checked];
  if (!names.length) return;
  const ok = await confirmDialog(
    'Delete ' + names.length + ' profiles?',
    'This will remove these profiles and all of their browser data:\n' + names.join(', ') + '\n\nThis cannot be undone.',
    'Delete all'
  );
  if (!ok) return;
  try {
    const res = await api.post('/profiles/delete-many', { names });
    for (const n of res.deleted) state.checked.delete(n);
    if (state.selected && res.deleted.includes(state.selected)) {
      state.selected = null;
      if (page === 'detail') showPage('dashboard');
    }
    await refreshProfiles();
    toast('Deleted ' + res.deleted.length + ' profile(s)');
  } catch (e) {
    toast('Delete failed: ' + e.message, true);
  }
}

async function stopAll() {
  await api.post('/stop-all');
  await refreshProfiles(state.selected);
}

function selectDevice(type) {
  state.deviceType = type;
  $('dev-windows').classList.toggle('selected', type === 'Windows');
  $('dev-android').classList.toggle('selected', type === 'Android');
  $('idev-windows').classList.toggle('selected', type === 'Windows');
  $('idev-android').classList.toggle('selected', type === 'Android');
  for (const card of document.querySelectorAll('.devcard')) card.setAttribute('aria-pressed', String(card.classList.contains('selected')));
}

async function openCreate() {
  if (page === 'create') return;
  selectionVersion++;
  selectDevice('Windows');
  $('c-name').value = '';
  showPage('create');
  $('create-title').focus();
}

function closeCreate() {
  leaveWorkflow('create');
}

async function doCreate() {
  const btn = $('c-create');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  const origin = selectionVersion;
  try {
    const res = await api.post('/profiles', {
      browserPlatform: state.deviceType,
      name: $('c-name').value.trim() || undefined
    });
    toast('Profile "' + res.profile.name + '" created');
    await refreshProfiles();
    if (page === 'create' && origin === selectionVersion) await selectProfile(res.profile.name);
  } catch (e) {
    toast('Create failed: ' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create';
  }
}

async function saveProxy() {
  const name = state.selected;
  if (!name) return;
  const host = $('f-proxy-host').value.trim();
  const proxy = host
    ? {
        scheme: $('f-proxy-scheme').value,
        host,
        port: Number($('f-proxy-port').value || 80),
        username: $('f-proxy-user').value.trim() || undefined,
        password: $('f-proxy-pass').value || undefined
      }
    : null;
  try {
    await api.post('/profiles/' + encodeURIComponent(name) + '/proxy', { proxy });
    toast('Proxy saved');
    await refreshProfiles();
    if (state.selected === name) {
      const updated = await api.get('/profiles/' + encodeURIComponent(name));
      if (state.selected === name) {
        state.current = updated;
        if (page === 'detail') renderDetail(updated);
        else populateProxy(updated.proxy);
      }
    }
  } catch (e) {
    toast('Save failed: ' + e.message, true);
  }
}

let toastTimer = null;
function toast(msg, isError) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.borderColor = isError ? 'var(--red)' : 'var(--green)';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

let importController = null;

async function openImport() {
  if (page === 'import') return;
  selectionVersion++;
  selectDevice('Windows');
  $('i-cookies').value = '';
  showPage('import');
  $('import-title').focus();
}

function closeImport() {
  importController?.abort();
  $('i-cookies').value = '';
  leaveWorkflow('import');
}

async function doImport() {
  if (importController) return;
  const controller = new AbortController();
  importController = controller;
  const btn = $('i-import');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  const origin = selectionVersion;
  try {
    const res = await api.post('/profiles/import-cookies', {
      browserPlatform: state.deviceType,
      text: $('i-cookies').value
    }, controller.signal);
    importController = null;
    const saved = res.created.filter(profile => profile.passwordSaved).length;
    $('i-cookies').value = '';
    toast(`Imported ${res.created.length} profile(s)${saved ? ` · ${saved} Facebook password(s) saved` : ''}`);
    if (origin === selectionVersion) closeImport();
    await refreshProfiles();
  } catch (e) {
    if (!controller.signal.aborted) toast('Import failed: ' + e.message, true);
  } finally {
    importController = null;
    btn.disabled = false;
    btn.textContent = 'Import';
  }
}

let uploadJob = null;
let uploadPollTimer = null;

function openUpload() {
  if (page === 'upload') return;
  selectionVersion++;
  showPage('upload');
  $('upload-title').focus();
  if (uploadJob && !uploadPollTimer && !$('u-stop').classList.contains('hidden')) pollUpload();
}

function closeUpload() {
  leaveWorkflow('upload');
}

async function startUpload() {
  const videoLines = $('u-video').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!videoLines.length) { toast('Choose at least one video file', true); return; }
  const useAll = $('u-all').checked;
  const profiles = useAll ? 'all' : [...state.uploadChecked];
  if (!useAll && !profiles.length) { toast('No profiles selected', true); return; }
  const parallel = updateParallel($('u-parallel').value);
  $('u-start').disabled = true;
  try {
    const res = await api.post('/upload/start', {
      videoPaths: videoLines,
      title: $('u-title').value.trim(),
      description: $('u-desc').value.trim(),
      profiles,
      parallel
    });
    uploadJob = res.jobId;
    toast(`Upload started: ${res.profileCount} profiles × ${res.videoCount} videos, ${res.parallel} parallel`);
    $('u-status').classList.remove('hidden');
    $('u-stop').classList.remove('hidden');
    $('u-status').textContent = 'Loading upload status…';
    clearTimeout(uploadPollTimer);
    uploadPollTimer = null;
    selectionVersion++;
    showPage('dashboard');
  } catch (e) {
    toast('Upload failed to start: ' + e.message, true);
  } finally {
    $('u-start').disabled = false;
  }
}

async function pollUpload() {
  if (!uploadJob || $('upload-modal').classList.contains('hidden')) { uploadPollTimer = null; return; }
  const id = uploadJob;
  try {
    const job = await api.get('/upload/status/' + encodeURIComponent(id));
    if (id !== uploadJob) return;
    renderUploadStatus(job);
    if (['done','needs_review','cancelled'].includes(job.state)) {
      toast(job.state === 'done' ? 'Upload job finished' : job.state === 'needs_review' ? 'Upload batch needs review' : 'Upload job cancelled');
      $('u-stop').classList.add('hidden');
      uploadPollTimer = null;
      return;
    }
  } catch (e) {}
  uploadPollTimer = setTimeout(pollUpload, 2000);
}

const UPLOAD_LABELS = {
  queued: 'queued', launching: 'launching', scanning: 'scanning Account Status', navigating: 'navigating',
  uploading: 'uploading', ready: 'check composer', waiting_publish: 'waiting for Publish', publishing: 'Publish clicked', accepted: 'accepted by Facebook', submitted: 'publishing unconfirmed', done: 'published', skipped: 'no eligible Pages', failed: 'failed', cancelled: 'cancelled'
};

const PAGE_LABELS = {
  queued: 'queued', skipped: 'skipped', uploading: 'uploading', published: 'published', accepted: 'accepted by Facebook', submitted: 'publishing unconfirmed', ready: 'needs review', failed: 'failed'
};

function uploadStatusMarkup(job) {
  const finished = job.tasks.filter(t => t.settled ?? ['done', 'accepted', 'submitted', 'skipped', 'failed', 'ready', 'cancelled'].includes(t.state)).length;
  return `<div class="upload-head">${escapeHtml(job.state === 'needs_review' ? 'finished with issues' : job.state)} · ${finished}/${job.tasks.length} profiles finished</div>
    <progress aria-label="Profiles finished" value="${finished}" max="${job.tasks.length || 1}"></progress>` +
    job.tasks.map(t => {
      const message = t.error || t.log?.at(-1) || '';
      const profile = state.profiles.find(p => p.name === t.name);
      const title = profile ? profileDisplay(profile, $('picker-format').value).title : t.name;
      const pageLine = (t.pages || []).map(p => {
        const label = p.state === 'skipped' && p.status === 'warning' ? 'skipped · warning' : PAGE_LABELS[p.state] || p.state;
        const tip = p.error ? ` title="${escapeHtml(p.error)}"` : '';
        return `<span class="upload-page upload-page-${escapeHtml(p.state)}"${tip}>${escapeHtml(p.name)} · ${escapeHtml(label)}</span>`;
      }).join('');
      return `<div class="upload-row upload-${escapeHtml(t.state)}"><span class="upload-name" title="${escapeHtml(t.name)}">${escapeHtml(title)}</span>
        <span class="upload-state">${escapeHtml(UPLOAD_LABELS[t.state] || t.state)}</span>
        <span class="upload-log">${escapeHtml(message)}</span>${pageLine ? `<div class="upload-pages">${pageLine}</div>` : ''}</div>`;
    }).join('');
}

function renderUploadStatus(job) {
  $('u-status').innerHTML = uploadStatusMarkup(job);
}

let monitorVersion = 0;
let monitorTimer;
function scheduleDashboardMonitor() {
  clearTimeout(monitorTimer);
  const version = ++monitorVersion;
  if (page === 'dashboard') refreshDashboardUploads(version);
}

async function refreshDashboardUploads(version) {
  try {
    const { jobs } = await api.get('/upload/status');
    if (version !== monitorVersion) return;
    // Keep active jobs and the most recent result visible after navigation or a reload.
    const visible = jobs.filter((job, i) => job.state === 'running' || i === jobs.length - 1).reverse();
    const details = await Promise.all(visible.map(job => api.get('/upload/status/' + encodeURIComponent(job.id))));
    if (version !== monitorVersion) return;
    $('dashboard-feedback').textContent = details.length ? '' : 'No Reels uploads yet.';
    $('dashboard-jobs').innerHTML = details.map(job => {
      const when = new Date(job.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return `<article><h4>Upload · ${escapeHtml(when)}</h4>${uploadStatusMarkup(job)}</article>`;
    }).join('');
  } catch {
    if (version === monitorVersion) $('dashboard-feedback').textContent = 'Upload status is unavailable. Retrying…';
  } finally {
    if (version === monitorVersion) monitorTimer = setTimeout(() => refreshDashboardUploads(version), 2000);
  }
}

async function stopUpload() {
  if (!uploadJob) return;
  try {
    await api.post('/upload/stop/' + encodeURIComponent(uploadJob));
    toast('Upload job stopped');
    const job = await api.get('/upload/status/' + encodeURIComponent(uploadJob));
    renderUploadStatus(job);
  } catch (e) {
    toast('Stop failed: ' + e.message, true);
  }
}

async function init() {
  $('btn-check-all').onclick = () => checkAllUids().catch(showError);
  $('btn-delete-dead').onclick = () => deleteDeadProfiles().catch(showError);
  $('btn-check-uid').onclick = async () => {
    if (!state.selected || state.checkingAll || state.deletingDead) return;
    const result = await checkOneUid(state.selected);
    if (result) toast(result.message, result.state === 'error');
  };
  const themeButton = $('theme-toggle');
  $('join-adxtreme').onclick = () => {
    const url = 'https://t.me/+NiXeHHWxeX9iNzQ9';
    if (window.fsApp?.openExternal) window.fsApp.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  };
  const labelTheme = () => {
    const label = document.documentElement.dataset.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    themeButton.setAttribute('aria-label', label);
    themeButton.title = label;
  };
  labelTheme();
  themeButton.onclick = () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('reels-theme', theme); } catch {}
    labelTheme();
  };
  for (const key of ['dashboard', 'profiles']) {
    $('btn-' + key).onclick = () => {
      selectionVersion++;
      showPage(key);
    };
  }
  for (const prefix of ['directory', 'picker']) {
    for (const field of ['format', 'sort']) {
      const control = $(prefix + '-' + field);
      try {
        const saved = localStorage.getItem('reels-' + control.id);
        if ([...control.options].some(option => option.value === saved)) control.value = saved;
      } catch {}
      control.onchange = () => {
        try { localStorage.setItem('reels-' + control.id, control.value); } catch {}
        renderProfileList();
      };
    }
  }
  for (const id of ['u-title', 'u-desc']) {
    const control = $(id);
    try {
      const saved = localStorage.getItem('reels-' + id);
      if (saved !== null) control.value = saved;
    } catch {}
    control.oninput = () => {
      try { localStorage.setItem('reels-' + id, control.value); } catch {}
    };
  }
  $('u-all').onchange = renderUploadPicker;
  $('u-selected').onchange = renderUploadPicker;
  $('picker-search').oninput = renderUploadPicker;
  $('picker-all').onchange = e => setUploadChecked(filteredProfiles('picker').map(p => p.name), e.target.checked);
  $('picker-clear').onclick = () => setUploadChecked([...state.uploadChecked], false);
  $('picker-list').onchange = e => setUploadChecked([e.target.dataset.name], e.target.checked);
  $('parallel-less').onclick = () => updateParallel(Number($('u-parallel').value) - 1);
  $('parallel-more').onclick = () => updateParallel(Number($('u-parallel').value) + 1);
  $('u-parallel').onchange = () => updateParallel($('u-parallel').value);
  updateParallel($('u-parallel').value);
  $('dashboard-upload').onclick = openUpload;
  $('directory-search').oninput = () => { renderDirectory(); renderBulkBar(); };
  $('directory-all').onchange = (e) => setChecked(directoryProfiles().map(p => p.name), e.target.checked);
  $('directory-rows').onchange = (e) => setChecked([e.target.dataset.name], e.target.checked);
  $('directory-rows').onclick = (e) => {
    const button = e.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.action === 'toggle') return toggleStart(button.dataset.name).catch(showError);
    else if (button.dataset.action === 'info') return selectProfile(button.dataset.name).catch(showError);
  };
  $('directory-clear').onclick = () => setChecked([...state.checked], false);
  $('directory-check').onclick = () => checkAllUids([...state.checked]).catch(showError);
  $('directory-delete').onclick = bulkDelete;
  $('welcome-create').onclick = openCreate;
  $('welcome-import').onclick = openImport;
  $('btn-create').onclick = openCreate;
  $('btn-import').onclick = openImport;
  $('btn-upload').onclick = openUpload;
  $('u-start').onclick = () => startUpload().catch(showError);
  $('u-close').onclick = closeUpload;
  $('u-stop').onclick = () => stopUpload().catch(showError);
  $('u-browse').onclick = async () => {
    if (window.fsApp?.pickVideo) {
      const files = await window.fsApp.pickVideo();
      if (files && files.length) $('u-video').value = files.join('\n');
    } else {
      $('u-video').focus();
      toast('Enter video paths one per line (multi-select needs the desktop app)', true);
    }
  };
  $('i-import').onclick = doImport;
  $('i-cancel').onclick = closeImport;
  $('c-create').onclick = doCreate;
  $('c-cancel').onclick = closeCreate;
  $('dev-windows').onclick = () => selectDevice('Windows');
  $('dev-android').onclick = () => selectDevice('Android');
  $('idev-windows').onclick = () => selectDevice('Windows');
  $('idev-android').onclick = () => selectDevice('Android');
  $('btn-start').onclick = () => toggleStart().catch(showError);
  $('btn-delete').onclick = deleteProfile;
  $('btn-stop-all').onclick = () => stopAll().catch(showError);
  $('btn-proxy-save').onclick = saveProxy;
  $('btn-retry').onclick = () => pollProfiles();
  for (const id of ['btn-proxy-save', 'btn-stop-all', 'btn-delete', 'directory-delete']) {
    const button = $(id);
    const action = button.onclick;
    button.onclick = async () => {
      if (button.disabled) return;
      button.disabled = true;
      try { await action(); } catch (error) { showError(error); }
      finally { button.disabled = id === 'directory-delete' && !state.checked.size; }
    };
  }
  scheduleDashboardMonitor();
  await pollProfiles();
}

let pollTimer;
let polling = false;
async function pollProfiles() {
  if (polling) return;
  polling = true;
  clearTimeout(pollTimer);
  try { await refreshProfiles(); }
  catch (error) {
    $('connection-status').textContent = 'Offline · retrying';
    $('connection-status').classList.add('offline');
  } finally { polling = false; pollTimer = setTimeout(pollProfiles, 4000); }
}

// Keep keyboard focus inside the active dialog and restore it when closed.
let modalOpener;
const modalObserver = new MutationObserver((records) => {
  for (const { target } of records) {
    if (!target.classList.contains('hidden')) {
      modalOpener = document.activeElement;
      $('app').inert = true;
      target.querySelector('button, input, textarea')?.focus();
    } else if (!document.querySelector('.modal:not(.hidden)')) {
      $('app').inert = false;
      modalOpener?.focus();
    }
  }
});
for (const modal of document.querySelectorAll('.modal')) modalObserver.observe(modal, { attributes: true, attributeFilter: ['class'] });
document.addEventListener('keydown', (event) => {
  const modal = document.querySelector('.modal:not(.hidden)');
  if (!modal) {
    if (event.key === 'Escape' && ['create', 'import', 'upload'].includes(page)) leaveWorkflow(page);
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    if (modal.id === 'confirm-modal') $('confirm-no').click();
    else modal.classList.add('hidden');
  }
  if (event.key === 'Tab') {
    const controls = [...modal.querySelectorAll('button, input, select, textarea')].filter((el) => !el.disabled);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

init().catch((e) => toast('Init failed: ' + e.message, true));
