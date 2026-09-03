// Genizah — API service
const API_BASE = '/api';

function getToken() { return localStorage.getItem('genizah_token'); }
function setToken(token) { localStorage.setItem('genizah_token', token); }
function clearToken() { localStorage.removeItem('genizah_token'); }

async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (res.status === 401) { clearToken(); window.location.href = '/login'; throw new Error('Session expired'); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// Auth
export async function getAuthConfig() { return (await fetch(`${API_BASE}/auth/config`)).json(); }
export async function login(username, password) {
  const data = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  setToken(data.token); return data;
}
export async function register(username, password, displayName) {
  const data = await apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ username, password, displayName }) });
  setToken(data.token); return data;
}
export async function getMe() { return apiFetch('/auth/me'); }
export function logout() { clearToken(); window.location.href = '/login'; }
export function isLoggedIn() { return !!getToken(); }

// Google OAuth
export function getGoogleLoginUrl() { return '/api/auth/google?action=login'; }
export function getGoogleLinkUrl() {
  const token = getToken();
  return `/api/auth/google?action=link&token=${encodeURIComponent(token)}`;
}
export async function getGoogleStatus() { return apiFetch('/auth/google/status'); }
export async function unlinkGoogle() { return apiFetch('/auth/google/link', { method: 'DELETE' }); }

// Documents
export async function getDocuments(params = {}) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v !== undefined && v !== '' && v !== null) query.set(k, v); }
  return apiFetch(`/documents?${query}`);
}
export async function getDocument(id) { return apiFetch(`/documents/${id}`); }
export async function uploadDocument(formData) { return apiFetch('/documents', { method: 'POST', body: formData }); }
export async function updateDocument(id, data) { return apiFetch(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); }
export async function deleteDocument(id) { return apiFetch(`/documents/${id}`, { method: 'DELETE' }); }

// Lookups
export async function getOwners() { return apiFetch('/owners'); }
export async function getTypes() { return apiFetch('/types'); }
export async function getTags() { return apiFetch('/tags'); }

// Activity & Sync
export async function getActivity(params = {}) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v) query.set(k, v); }
  return apiFetch(`/activity?${query}`);
}
export async function getSyncStatus() { return apiFetch('/sync/status'); }

// Attachments
export async function deleteAttachment(docId, attachId) { return apiFetch(`/documents/${docId}/attachments/${attachId}`, { method: 'DELETE' }); }
export async function deletePrimaryImage(docId) { return apiFetch(`/documents/${docId}/primary-image`, { method: 'DELETE' }); }
export async function replacePrimaryImage(docId, blob) {
  const formData = new FormData();
  formData.append('file', blob, 'edited.jpg');
  return apiFetch(`/documents/${docId}/primary-image`, { method: 'PUT', body: formData });
}
export async function replaceAttachment(docId, attachId, blob) {
  const formData = new FormData();
  formData.append('file', blob, 'edited.jpg');
  return apiFetch(`/documents/${docId}/attachments/${attachId}`, { method: 'PUT', body: formData });
}

// OCR
export async function ocrScanFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  return apiFetch('/documents/ocr-scan', { method: 'POST', body: formData });
}
export async function ocrRescan(docId) { return apiFetch(`/documents/${docId}/ocr`, { method: 'POST' }); }

// Tag management
export async function renameTag(tagId, name) { return apiFetch(`/tags/${tagId}`, { method: 'PATCH', body: JSON.stringify({ name }) }); }
export async function deleteTag(tagId) { return apiFetch(`/tags/${tagId}`, { method: 'DELETE' }); }

// Updates
export async function getVersion() { return apiFetch('/update/version'); }
export async function uploadPatch(file) {
  const formData = new FormData();
  formData.append('patch', file);
  return apiFetch('/update/upload', { method: 'POST', body: formData });
}
export async function applyPatch(extractDir) { return apiFetch('/update/apply', { method: 'POST', body: JSON.stringify({ extractDir }) }); }

// Gmail Scan
export async function getGmailScanStatus() { return apiFetch('/gmail-scan/status'); }
export async function triggerGmailScan() { return apiFetch('/gmail-scan/trigger', { method: 'POST' }); }
export async function triggerGmailRescan() { return apiFetch('/gmail-scan/rescan', { method: 'POST' }); }
export async function getGmailScanHistory(limit = 20) { return apiFetch(`/gmail-scan/history?limit=${limit}`); }
export async function getGmailSenderRules() { return apiFetch('/gmail-scan/rules'); }
export async function addGmailSenderRule(sender_email, sender_name, action = 'block') {
  return apiFetch('/gmail-scan/rules', { method: 'POST', body: JSON.stringify({ sender_email, sender_name, action }) });
}
export async function removeGmailSenderRule(id) { return apiFetch(`/gmail-scan/rules/${id}`, { method: 'DELETE' }); }
export async function getGmailRecentSenders() { return apiFetch('/gmail-scan/recent-senders'); }

// Reports
function reportQuery(params = {}) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v !== undefined && v !== '' && v !== null) query.set(k, v); }
  return query.toString();
}
export async function getReportSummary(params) { return apiFetch(`/reports/summary?${reportQuery(params)}`); }
export async function getReportDashboard(params) { return apiFetch(`/reports/dashboard?${reportQuery(params)}`); }
export async function getReportByTag(params) { return apiFetch(`/reports/by-tag?${reportQuery(params)}`); }
export async function getReportByVendor(params) { return apiFetch(`/reports/by-vendor?${reportQuery(params)}`); }
export async function getReportByOwner(params) { return apiFetch(`/reports/by-owner?${reportQuery(params)}`); }
export async function getReportByMonth(params) { return apiFetch(`/reports/by-month?${reportQuery(params)}`); }
export async function getReportByDayOfWeek(params) { return apiFetch(`/reports/by-day-of-week?${reportQuery(params)}`); }
export async function getReportTrend(params) { return apiFetch(`/reports/trend?${reportQuery(params)}`); }
export function getReportCsvUrl(params) { return `${API_BASE}/reports/export/csv?${reportQuery(params)}&token=${getToken()}`; }
export async function getReportExpiring(days = 90) { return apiFetch(`/reports/expiring?days=${days}`); }
export function getReportPdfUrl(params) { return `${API_BASE}/reports/export/pdf?${reportQuery(params)}&token=${getToken()}`; }
