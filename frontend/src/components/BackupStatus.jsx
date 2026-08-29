import { useState, useEffect, useCallback } from 'react';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function timeAgo(dateStr) {
  if (!dateStr) return 'Never';
  const now = new Date();
  const then = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z'));
  const mins = Math.floor((now - then) / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString();
}

function StatusBadge({ status }) {
  const colors = {
    success: { bg: 'rgba(62, 207, 113, 0.15)', text: '#3ecf71' },
    partial: { bg: 'rgba(255, 193, 7, 0.15)', text: '#ffc107' },
    failed:  { bg: 'rgba(224, 85, 85, 0.15)', text: '#e05555' },
    running: { bg: 'rgba(74, 158, 255, 0.15)', text: '#4a9eff' }
  };
  const c = colors[status] || colors.failed;
  return (
    <span style={{
      padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem',
      fontWeight: 600, backgroundColor: c.bg, color: c.text, textTransform: 'uppercase'
    }}>{status}</span>
  );
}

export default function BackupStatus({ token }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const [toast, setToast] = useState(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/backup/status', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        if (backingUp && !data.backup_in_progress) {
          setBackingUp(false);
          const s = data.last_run?.status;
          showToast(
            s === 'success' ? 'Backup complete!' :
            s === 'partial' ? 'Backup finished with some errors' : 'Backup failed',
            s === 'success' ? 'success' : s === 'partial' ? 'warning' : 'error'
          );
        }
      }
    } catch {} finally { setLoading(false); }
  }, [backingUp, token]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, backingUp ? 5000 : 30000);
    return () => clearInterval(interval);
  }, [fetchStatus, backingUp]);

  function showToast(message, type) {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }

  async function triggerBackup() {
    try {
      setBackingUp(true);
      const res = await fetch('/api/backup/run', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.status === 409) { showToast('Backup already in progress', 'warning'); return; }
      if (!res.ok) {
        const data = await res.json();
        showToast(data.error || 'Failed to start backup', 'error');
        setBackingUp(false);
        return;
      }
      showToast('Backup started...', 'info');
    } catch {
      showToast('Network error', 'error');
      setBackingUp(false);
    }
  }

  if (loading) return <div className="card" style={{ marginTop: '16px' }}><p style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>Loading backup status...</p></div>;
  if (!status) return null;

  return (
    <>
      <div className="card" style={{ marginTop: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600, margin: 0 }}>☁️ Google Drive Backup</h3>
          {status.google_auth_ok
            ? <span style={{ fontSize: '0.8rem', color: '#3ecf71' }}>● Connected</span>
            : <span style={{ fontSize: '0.8rem', color: '#e05555' }}>● Not connected</span>
          }
        </div>

        {!status.google_auth_ok && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px', padding: '10px', marginBottom: '12px',
            borderRadius: '8px', background: 'rgba(224,85,85,0.1)', border: '1px solid rgba(224,85,85,0.3)',
            fontSize: '0.8rem', color: '#e05555'
          }}>
            ⚠ {status.google_auth_error || 'Google Drive not linked'}. Re-link your Google account with Drive permissions.
          </div>
        )}

        {/* Stats grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '12px' }}>
          {[
            { val: status.files_synced, label: 'Synced' },
            { val: status.files_pending, label: 'Pending' },
            { val: status.files_failed, label: 'Failed', color: status.files_failed > 0 ? '#e05555' : undefined },
            { val: formatBytes(status.total_backed_up_bytes), label: 'Total' }
          ].map((s, i) => (
            <div key={i} style={{ textAlign: 'center', padding: '8px 4px', background: 'var(--bg, #111113)', borderRadius: '6px' }}>
              <div style={{ fontSize: '1.1rem', fontWeight: 600, color: s.color || 'var(--text)' }}>{s.val}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-dim, #8888a0)', marginTop: '2px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Last run */}
        {status.last_run && (
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: '12px', padding: '8px 10px', borderRadius: '6px', background: 'var(--bg, #111113)'
          }}>
            <span style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>
              Last backup: {timeAgo(status.last_run.completed_at || status.last_run.started_at)}
            </span>
            <StatusBadge status={status.last_run.status} />
          </div>
        )}

        {!status.last_run && (
          <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem', marginBottom: '12px' }}>No backups have run yet.</p>
        )}

        {/* Backup Now */}
        <button
          onClick={triggerBackup}
          disabled={backingUp || !status.google_auth_ok}
          className="btn btn-primary"
          style={{
            width: '100%', padding: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            opacity: (backingUp || !status.google_auth_ok) ? 0.5 : 1,
            cursor: (backingUp || !status.google_auth_ok) ? 'not-allowed' : 'pointer'
          }}
        >
          {backingUp ? '⏳ Backing up...' : '☁️ Backup Now'}
        </button>
      </div>

      {toast && (
        <div className="toast">{toast.message}</div>
      )}
    </>
  );
}
