import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getTags, renameTag, deleteTag, getVersion, uploadPatch, applyPatch } from '../services/api';

export default function SettingsPage() {
  const navigate = useNavigate();
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

  useEffect(() => {
    loadTags();
    loadVersion();
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

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(''), 3500); }

  if (loading) return <div className="spinner" />;

  return (
    <>
      <button className="btn btn-ghost" onClick={() => navigate(-1)} style={{ marginBottom: '12px' }}>← Back</button>

      <div className="card">
        <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '16px' }}>⚙️ Settings</h2>

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
