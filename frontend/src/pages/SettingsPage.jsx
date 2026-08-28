import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { getTags, renameTag, deleteTag, getVersion, uploadPatch, applyPatch, getGoogleStatus, getGoogleLinkUrl, unlinkGoogle, getAuthConfig } from '../services/api';

export default function SettingsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingTag, setEditingTag] = useState(null);
  const [editName, setEditName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [toast, setToast] = useState('');

  // Update state
  const [version, setVersion] = useState(null);
  const [patchInfo, setPatchInfo] = useState(null);
  const [uploadingPatch, setUploadingPatch] = useState(false);
  const [applying, setApplying] = useState(false);
  const patchFileRef = useRef(null);

  // Google state
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [googleStatus, setGoogleStatus] = useState(null);
  const [googleLoading, setGoogleLoading] = useState(true);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  useEffect(() => {
    loadTags();
    loadVersion();
    loadGoogleStatus();

    // Check for Google link result in URL
    const params = new URLSearchParams(window.location.search);
    if (params.get('google_linked') === 'true') {
      showToast('Google account linked successfully!');
      window.history.replaceState({}, '', '/settings');
    }
    const googleError = params.get('google_error');
    if (googleError) {
      const messages = {
        already_linked_other: 'That Google account is already linked to a different user.',
        no_user: 'Could not identify your account. Try again.',
        token_exchange_failed: 'Google returned an error. Try again.',
        access_denied: 'Google linking was cancelled.'
      };
      showToast(messages[googleError] || `Google error: ${googleError}`);
      window.history.replaceState({}, '', '/settings');
    }
  }, []);

  async function loadTags() {
    try {
      const data = await getTags();
      setTags(data);
    } catch (err) {
      showToast(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadVersion() {
    try {
      const v = await getVersion();
      setVersion(v);
    } catch (err) { /* version endpoint may not exist yet */ }
  }

  async function loadGoogleStatus() {
    try {
      const config = await getAuthConfig();
      setGoogleEnabled(config.google || false);
      if (config.google) {
        const status = await getGoogleStatus();
        setGoogleStatus(status);
      }
    } catch (err) { /* not configured */ }
    finally { setGoogleLoading(false); }
  }

  async function handleRename(tagId) {
    if (!editName.trim()) return;
    try {
      await renameTag(tagId, editName.trim());
      setEditingTag(null);
      setEditName('');
      await loadTags();
      showToast('Tag renamed');
    } catch (err) {
      showToast(err.message);
    }
  }

  async function handleDelete(tagId) {
    try {
      await deleteTag(tagId);
      setConfirmDelete(null);
      await loadTags();
      showToast('Tag deleted');
    } catch (err) {
      showToast(err.message);
    }
  }

  async function handlePatchUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploadingPatch(true);
    setPatchInfo(null);

    try {
      const result = await uploadPatch(file);
      setPatchInfo(result);
      showToast('Patch uploaded and extracted');
    } catch (err) {
      showToast('Upload failed: ' + err.message);
    } finally {
      setUploadingPatch(false);
      if (patchFileRef.current) patchFileRef.current.value = '';
    }
  }

  async function handleApplyPatch() {
    if (!patchInfo) return;
    setApplying(true);

    try {
      await applyPatch(patchInfo.extractDir);
      showToast('Patch applied! App is restarting...');

      // Poll for the app to come back
      setTimeout(() => {
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          try {
            const res = await fetch('/api/auth/config');
            if (res.ok) {
              clearInterval(poll);
              window.location.reload();
            }
          } catch (e) { /* still restarting */ }
          if (attempts > 60) { // 60 seconds max
            clearInterval(poll);
            setApplying(false);
            showToast('Rebuild is taking a while. Refresh manually in a minute.');
          }
        }, 2000);
      }, 3000);
    } catch (err) {
      setApplying(false);
      showToast('Apply failed: ' + err.message);
    }
  }

  async function handleUnlinkGoogle() {
    try {
      await unlinkGoogle();
      setGoogleStatus({ linked: false });
      setConfirmUnlink(false);
      showToast('Google account unlinked');
    } catch (err) {
      showToast(err.message);
    }
  }

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(''), 3500); }

  if (loading) return <div className="spinner" />;

  return (
    <>
      <button className="btn btn-ghost" onClick={() => navigate(-1)} style={{ marginBottom: '12px' }}>← Back</button>

      <div className="card">
        <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '16px' }}>⚙️ Settings</h2>

        {/* ── Google Account ── */}
        {googleEnabled && (
          <>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '12px', color: 'var(--text-secondary)' }}>
              Google Account
            </h3>

            {googleLoading ? (
              <div className="spinner" style={{ margin: '12px 0' }} />
            ) : googleStatus?.linked ? (
              <div style={{ marginBottom: '20px' }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '12px',
                  background: 'rgba(58, 217, 142, 0.08)',
                  border: '1px solid rgba(58, 217, 142, 0.25)',
                  borderRadius: 'var(--radius-sm)',
                  marginBottom: '10px'
                }}>
                  <span style={{ fontSize: '1.2rem' }}>✅</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                      Linked to {googleStatus.email}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: '2px' }}>
                      {[
                        googleStatus.hasGmail && 'Gmail',
                        googleStatus.hasDrive && 'Drive'
                      ].filter(Boolean).join(' + ') || 'Sign-in only'}
                    </div>
                  </div>
                </div>

                {/* Re-link button for admin to upgrade scopes */}
                {user?.role === 'admin' && !googleStatus.hasDrive && (
                  <button
                    onClick={() => { window.location.href = getGoogleLinkUrl(); }}
                    className="btn btn-secondary btn-block"
                    style={{ marginBottom: '6px', fontSize: '0.82rem' }}
                  >
                    🔄 Re-link with Drive access (for backups)
                  </button>
                )}

                {confirmUnlink ? (
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button className="btn btn-danger" style={{ fontSize: '0.82rem' }} onClick={handleUnlinkGoogle}>
                      Yes, unlink
                    </button>
                    <button className="btn btn-ghost" style={{ fontSize: '0.82rem' }} onClick={() => setConfirmUnlink(false)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}
                    onClick={() => setConfirmUnlink(true)}
                  >
                    Unlink Google Account
                  </button>
                )}
              </div>
            ) : (
              <div style={{ marginBottom: '20px' }}>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-dim)', marginBottom: '10px', lineHeight: 1.5 }}>
                  Link your Google account to enable "Sign in with Google" on the login page
                  {user?.role === 'admin' ? ', plus Google Drive backups and Gmail receipt scanning.' : ' and Gmail receipt scanning.'}
                </p>
                <button
                  onClick={() => { window.location.href = getGoogleLinkUrl(); }}
                  className="btn btn-primary"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontSize: '0.88rem'
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 48 48">
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                  </svg>
                  Link Google Account
                </button>
              </div>
            )}

            <div style={{ height: '1px', background: 'var(--border)', margin: '16px 0' }} />
          </>
        )}

        {/* ── Tag Management ── */}
        <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '12px', color: 'var(--text-secondary)' }}>Tag Management</h3>

        {tags.length === 0 ? (
          <p style={{ color: 'var(--text-dim)', fontSize: '0.88rem' }}>No tags yet. Tags are created when you add them to documents.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {tags.map(tag => (
              <div key={tag.id} className="settings-tag-row">
                {editingTag === tag.id ? (
                  <div style={{ display: 'flex', gap: '6px', flex: 1, alignItems: 'center' }}>
                    <input type="text" value={editName} onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRename(tag.id); if (e.key === 'Escape') setEditingTag(null); }}
                      autoFocus style={{ flex: 1, fontSize: '0.85rem' }} />
                    <button className="btn btn-primary" style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                      onClick={() => handleRename(tag.id)}>Save</button>
                    <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                      onClick={() => setEditingTag(null)}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="tag-chip" style={{ margin: 0 }}>{tag.name}</span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                        {tag.usage_count} doc{tag.usage_count !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: '0.78rem' }}
                        onClick={() => { setEditingTag(tag.id); setEditName(tag.name); }}>
                        ✏️
                      </button>
                      {confirmDelete === tag.id ? (
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                          <button className="btn btn-danger" style={{ padding: '4px 8px', fontSize: '0.78rem' }}
                            onClick={() => handleDelete(tag.id)}>Delete</button>
                          <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: '0.78rem' }}
                            onClick={() => setConfirmDelete(null)}>Cancel</button>
                        </div>
                      ) : (
                        <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: '0.78rem' }}
                          onClick={() => setConfirmDelete(tag.id)}>
                          🗑️
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Update / Patching ── */}
      <div className="card" style={{ marginTop: '16px' }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '12px', color: 'var(--text-secondary)' }}>🔄 Update / Patch</h3>

        {version && (
          <div style={{ fontSize: '0.82rem', color: 'var(--text-dim)', marginBottom: '12px', padding: '8px 12px', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)' }}>
            <div><strong>Last update:</strong> {version.version}</div>
            <div><strong>Date:</strong> {version.lastCommit !== 'unknown' ? new Date(version.lastCommit).toLocaleString() : 'Unknown'}</div>
          </div>
        )}

        {applying ? (
          <div style={{ textAlign: 'center', padding: '20px' }}>
            <div className="spinner" />
            <p style={{ color: 'var(--accent-orange)', fontSize: '0.88rem', marginTop: '12px' }}>
              Applying patch and rebuilding...
            </p>
            <p style={{ color: 'var(--text-dim)', fontSize: '0.78rem' }}>
              The app will reload automatically when ready.
            </p>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
              <button className="btn btn-secondary" onClick={() => patchFileRef.current?.click()}
                disabled={uploadingPatch}>
                {uploadingPatch ? 'Extracting...' : '📦 Upload Patch (.tar.gz)'}
              </button>
              <input ref={patchFileRef} type="file" accept=".tar.gz,.tgz"
                style={{ display: 'none' }} onChange={handlePatchUpload} />
            </div>

            {patchInfo && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                    Patch Preview
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                    {patchInfo.fileCount} file{patchInfo.fileCount !== 1 ? 's' : ''}
                  </span>
                </div>

                <div style={{ maxHeight: '150px', overflowY: 'auto', marginBottom: '12px' }}>
                  {patchInfo.files.map(f => (
                    <div key={f.path} style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', padding: '2px 0', fontFamily: 'monospace' }}>
                      {f.path}
                    </div>
                  ))}
                </div>

                {patchInfo.hasDeployScript ? (
                  <div style={{ fontSize: '0.78rem', color: 'var(--accent-green)', marginBottom: '10px' }}>
                    ✓ deploy.sh found
                  </div>
                ) : (
                  <div style={{ fontSize: '0.78rem', color: 'var(--accent-orange)', marginBottom: '10px' }}>
                    ⚠ No deploy.sh found. Files will be copied directly.
                  </div>
                )}

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="btn btn-primary" onClick={handleApplyPatch}>
                    🚀 Apply Patch
                  </button>
                  <button className="btn btn-ghost" onClick={() => setPatchInfo(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
