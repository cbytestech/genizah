import { useState, useEffect } from 'react';
import { getGmailScanHistory } from '../services/api';

export default function GmailScanHistory() {
  const [runs, setRuns] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getGmailScanHistory(10)
      .then(data => setRuns(data.runs || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading || runs.length === 0) return null;

  const formatTime = (ts) => {
    if (!ts) return '';
    return new Date(ts + 'Z').toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  };

  const statusIcon = (s) => s === 'completed' ? '✓' : s === 'failed' ? '✗' : '⟳';
  const statusColor = (s) => s === 'completed' ? '#2ecc71' : s === 'failed' ? '#e74c3c' : '#f39c12';

  return (
    <div className="settings-section" style={{ marginTop: '8px' }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          background: 'none', border: 'none', color: 'var(--text-secondary, #aaa)',
          cursor: 'pointer', fontSize: '14px', padding: '4px 0', width: '100%',
          textAlign: 'left', display: 'flex', justifyContent: 'space-between',
        }}
      >
        <span>Scan History ({runs.length})</span>
        <span>{expanded ? '▼' : '▶'}</span>
      </button>

      {expanded && (
        <div style={{ marginTop: '8px' }}>
          {runs.map(run => (
            <div key={run.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 10px', borderBottom: '1px solid var(--border, #333)',
              fontSize: '13px', gap: '8px', flexWrap: 'wrap',
            }}>
              <div style={{ flex: 1, minWidth: '140px' }}>
                <span style={{ color: statusColor(run.status), fontWeight: 600, marginRight: '6px' }}>
                  {statusIcon(run.status)}
                </span>
                <span style={{ color: 'var(--text-primary, #ddd)' }}>
                  {formatTime(run.started_at)}
                </span>
                <span style={{
                  marginLeft: '8px', fontSize: '11px',
                  color: 'var(--text-secondary, #777)',
                  textTransform: 'capitalize',
                }}>
                  {run.scan_type}
                </span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary, #888)' }}>
                {run.status === 'completed' && (
                  <>
                    {run.documents_created > 0 && <span style={{ color: '#2ecc71' }}>+{run.documents_created} </span>}
                    {run.duplicates_skipped > 0 && <span>{run.duplicates_skipped} dupes </span>}
                    {run.errors > 0 && <span style={{ color: '#e74c3c' }}>{run.errors} err</span>}
                    {run.documents_created === 0 && run.errors === 0 && 'No new receipts'}
                  </>
                )}
                {run.status === 'failed' && (
                  <span style={{ color: '#e74c3c' }}>{run.error_message || 'Failed'}</span>
                )}
                {run.status === 'running' && (
                  <span style={{ color: '#f39c12' }}>In progress...</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
