import { useState, useEffect } from 'react';

function timeAgo(dateStr) {
  if (!dateStr) return '';
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

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function duration(startStr, endStr) {
  if (!startStr || !endStr) return '';
  const secs = Math.round((new Date(endStr + 'Z') - new Date(startStr + 'Z')) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function dotColor(status) {
  if (status === 'success') return '#3ecf71';
  if (status === 'partial') return '#ffc107';
  if (status === 'running') return '#4a9eff';
  return '#e05555';
}

export default function BackupHistory({ token }) {
  const [history, setHistory] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/backup/history?limit=10', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          setHistory(data.runs || []);
        }
      } catch {} finally { setLoading(false); }
    })();
  }, [token]);

  if (loading || history.length === 0) return null;

  return (
    <div className="card" style={{ marginTop: '8px' }}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
        onClick={() => setExpanded(!expanded)}
      >
        <h3 style={{ fontSize: '0.95rem', fontWeight: 600, margin: 0, color: 'var(--text-secondary)' }}>
          Backup History
        </h3>
        <span style={{ color: 'var(--text-dim)', fontSize: '0.75rem', transition: 'transform 0.2s',
          transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
      </div>

      {expanded && (
        <div style={{ marginTop: '12px' }}>
          {history.map(run => (
            <div key={run.id} style={{
              display: 'flex', alignItems: 'flex-start', gap: '8px',
              padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)'
            }}>
              <span style={{
                display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
                backgroundColor: dotColor(run.status), marginTop: '5px', flexShrink: 0
              }} />
              <div>
                <div style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text)' }}>
                  {timeAgo(run.completed_at || run.started_at)}
                  {run.completed_at && run.started_at && (
                    <span style={{ marginLeft: '8px', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                      {duration(run.started_at, run.completed_at)}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: '2px' }}>
                  {run.files_synced > 0 && `${run.files_synced} synced`}
                  {run.files_skipped > 0 && `, ${run.files_skipped} unchanged`}
                  {run.files_failed > 0 && `, ${run.files_failed} failed`}
                  {run.total_bytes > 0 && ` (${formatBytes(run.total_bytes)})`}
                  {run.db_backed_up ? ', DB saved' : ''}
                </div>
                {run.error_message && (
                  <div style={{ fontSize: '0.75rem', color: '#e05555', marginTop: '2px' }}>{run.error_message}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
