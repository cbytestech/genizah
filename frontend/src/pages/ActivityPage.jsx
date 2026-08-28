import { useState, useEffect } from 'react';
import { getActivity } from '../services/api';
import { useNavigate } from 'react-router-dom';

const ACTION_ICONS = {
  uploaded: '📤',
  viewed: '👁️',
  edited: '✏️',
  deleted: '🗑️',
  expired_warning: '⚠️',
  shared: '🔗',
  updated: '🔄'
};

export default function ActivityPage() {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    getActivity({ limit: 50 })
      .then(data => setActivities(data))
      .catch(err => console.error(err))
      .finally(() => setLoading(false));
  }, []);

  function formatTime(dateStr) {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // Group by date
  function groupByDate(items) {
    const groups = {};
    for (const item of items) {
      const date = new Date(item.created_at).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric'
      });
      if (!groups[date]) groups[date] = [];
      groups[date].push(item);
    }
    return groups;
  }

  if (loading) return <div className="spinner" />;

  const grouped = groupByDate(activities);

  return (
    <>
      <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '16px' }}>
        🔔 Activity
      </h2>

      {activities.length === 0 ? (
        <div className="empty-state">
          <div className="icon">🔔</div>
          <p>No activity yet. Start scanning documents!</p>
        </div>
      ) : (
        Object.entries(grouped).map(([date, items]) => (
          <div key={date}>
            <div style={{
              fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-dim)',
              textTransform: 'uppercase', letterSpacing: '0.5px',
              padding: '12px 0 6px', marginTop: '8px'
            }}>
              {date}
            </div>
            {items.map(item => (
              <div
                key={item.id}
                className="activity-item"
                style={{ cursor: item.document_id ? 'pointer' : 'default' }}
                onClick={() => item.document_id && navigate(`/doc/${item.document_id}`)}
              >
                <span className="activity-icon">
                  {ACTION_ICONS[item.action] || '📌'}
                </span>
                <div style={{ flex: 1 }}>
                  <div className="activity-text" style={{ whiteSpace: 'pre-line' }}>{item.detail}</div>
                  <div className="activity-time">{formatTime(item.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </>
  );
}
