import { useState, useEffect, useCallback } from 'react';
import { getGmailScanStatus, triggerGmailScan } from '../services/api';

export default function GmailScanStatus() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await getGmailScanStatus();
      setStatus(data);
      setScanning(data.is_running);
      setError(null);
    } catch (e) {
      setError('Failed to load scan status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, scanning ? 5000 : 30000);
    return () => clearInterval(interval);
  }, [fetchStatus, scanning]);

  const handleScan = async () => {
    try {
      setScanning(true);
      setError(null);
      await triggerGmailScan();
      setTimeout(fetchStatus, 2000);
    } catch (e) {
      setError(e.message || 'Failed to start scan');
      setScanning(false);
    }
  };

  if (loading) return <div className="settings-section"><p>Loading Gmail scan status...</p></div>;

  if (!status?.gmail_linked) {
    return (
      <div className="settings-section">
        <h3>📧 Gmail Receipt Scanner</h3>
        <p style={{ color: 'var(--text-secondary, #999)', marginTop: '8px' }}>
          Link your Google account above to enable automatic receipt scanning.
        </p>
      </div>
    );
  }

  const lastRun = status.last_run;
  const formatTime = (ts) => {
    if (!ts) return 'Never';
    const d = new Date(ts + 'Z');
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  };

  return (
    <div className="settings-section">
      <h3>📧 Gmail Receipt Scanner</h3>

      {error && (
        <div style={{
          background: '#3a1c1c', border: '1px solid #e74c3c',
          borderRadius: '8px', padding: '10px 14px', margin: '10px 0',
          color: '#e74c3c', fontSize: '14px'
        }}>
          {error}
        </div>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
        gap: '12px', margin: '14px 0'
      }}>
        <StatCard label="Total Scanned" value={status.total_documents} />
        <StatCard label="Last 24h" value={status.recent_24h.created} sub="new" />
        <StatCard label="Duplicates" value={status.recent_24h.duplicates} sub="skipped" />
        <StatCard label="Blocked" value={status.blocked_senders} sub="senders" />
      </div>

      {lastRun && (
        <div style={{
          background: 'var(--bg-secondary, #1e1e1e)', borderRadius: '8px',
          padding: '12px 14px', margin: '10px 0', fontSize: '13px',
          color: 'var(--text-secondary, #aaa)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px' }}>
            <span>Last scan: <strong style={{ color: 'var(--text-primary, #eee)' }}>
              {formatTime(lastRun.completed_at || lastRun.started_at)}
            </strong></span>
            <span style={{
              color: lastRun.status === 'completed' ? '#2ecc71'
                : lastRun.status === 'failed' ? '#e74c3c' : '#f39c12',
              fontWeight: 600
            }}>
              {lastRun.status === 'running' ? '⟳ Scanning...' : lastRun.status}
            </span>
          </div>
          {lastRun.status === 'completed' && (
            <div style={{ marginTop: '6px', fontSize: '12px' }}>
              Found {lastRun.messages_found} emails, created {lastRun.documents_created} docs
              {lastRun.errors > 0 && `, ${lastRun.errors} errors`}
            </div>
          )}
          {lastRun.status === 'failed' && lastRun.error_message && (
            <div style={{ marginTop: '6px', fontSize: '12px', color: '#e74c3c' }}>
              {lastRun.error_message}
            </div>
          )}
        </div>
      )}

      <button
        onClick={handleScan}
        disabled={scanning}
        style={{
          width: '100%', padding: '12px',
          background: scanning ? '#555' : 'var(--accent-blue, #3498db)',
          color: '#fff', border: 'none', borderRadius: '8px',
          fontSize: '15px', fontWeight: 600, cursor: scanning ? 'wait' : 'pointer',
          marginTop: '8px',
        }}
      >
        {scanning ? '⟳ Scanning Gmail...' : '🔍 Scan Now (Last 7 Days)'}
      </button>

      <p style={{
        fontSize: '12px', color: 'var(--text-secondary, #777)',
        marginTop: '8px', textAlign: 'center'
      }}>
        Auto-scans every 15 min from 7 AM to 10 PM
      </p>
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div style={{
      background: 'var(--bg-secondary, #1e1e1e)', borderRadius: '8px',
      padding: '12px', textAlign: 'center',
    }}>
      <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-primary, #eee)' }}>
        {value ?? 0}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-secondary, #888)', marginTop: '2px' }}>
        {label}{sub ? ` ${sub}` : ''}
      </div>
    </div>
  );
}
