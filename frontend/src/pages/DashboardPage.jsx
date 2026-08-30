import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDocuments, getOwners, getTypes } from '../services/api';

// Stats endpoint
async function getStats() {
  const token = localStorage.getItem('genizah_token');
  const res = await fetch('/api/documents/stats', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Stats failed');
  return res.json();
}

export default function DashboardPage() {
  const navigate = useNavigate();

  // Format activity detail text (handle JSON from gmail actions)
  function formatDetail(action, detail) {
    if (!detail) return '';
    try {
      const data = JSON.parse(detail);
      if (action === 'gmail_receipt') {
        const parts = [data.vendor || 'Unknown'];
        if (data.amount) parts.push(`$${data.amount}`);
        if (data.type && data.type !== 'Receipt') parts.push(data.type);
        return `📧 ${parts.join(' · ')}`;
      }
      if (action === 'gmail_scan_complete') {
        return `📬 Scan: ${data.created} new, ${data.duplicates} skipped`;
      }
      if (action === 'gmail_sender_rule') {
        return `🚫 ${data.action === 'block' ? 'Blocked' : 'Unblocked'}: ${data.sender_email}`;
      }
      return detail;
    } catch { return detail; }
  }
  const [documents, setDocuments] = useState([]);
  const [owners, setOwners] = useState([]);
  const [types, setTypes] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterOwner, setFilterOwner] = useState('');
  const [filterType, setFilterType] = useState('');
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getDocuments({
        search: search || undefined,
        owner_id: filterOwner || undefined,
        type_id: filterType || undefined,
        page: pagination.page, limit: 20
      });
      setDocuments(data.documents);
      setPagination(data.pagination);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, [search, filterOwner, filterType, pagination.page]);

  useEffect(() => {
    Promise.all([getOwners(), getTypes(), getStats()])
      .then(([o, t, s]) => { setOwners(o); setTypes(t); setStats(s); })
      .catch(() => {});
  }, []);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  function formatDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  return (
    <div className="dashboard-layout">
      {/* Stats row (desktop) */}
      {stats && (
        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-number">{stats.total}</div>
            <div className="stat-label">Documents</div>
          </div>
          {stats.byOwner.map(o => (
            <div key={o.name} className="stat-card clickable"
              onClick={() => { const ow = owners.find(x => x.name === o.name); if (ow) { setFilterOwner(ow.id); setPagination(p => ({...p, page:1})); } }}>
              <div className="stat-number" style={{ color: o.color }}>{o.count}</div>
              <div className="stat-label">{o.icon} {o.name}</div>
            </div>
          ))}
          <div className="stat-card">
            <div className="stat-number">{formatBytes(stats.totalSize)}</div>
            <div className="stat-label">Storage Used</div>
          </div>
        </div>
      )}

      {/* Expiring soon banner */}
      {stats && stats.expiringSoon && stats.expiringSoon.length > 0 && (
        <div className="expiring-banner">
          <strong>⚠️ Expiring Soon:</strong>
          {stats.expiringSoon.map((d, i) => (
            <span key={i}> {d.owner_icon} {d.title} ({formatDate(d.expiration_date)}){i < stats.expiringSoon.length - 1 ? ' · ' : ''}</span>
          ))}
        </div>
      )}

      <div className="dashboard-content">
        {/* Main document area */}
        <div className="dashboard-main">
          {/* Search */}
          <div className="search-bar">
            <span className="search-icon">🔍</span>
            <input type="text" placeholder="Search documents, vendors, notes..."
              value={searchInput}
              onChange={e => { setSearchInput(e.target.value); setPagination(p => ({...p, page: 1})); }} />
          </div>

          {/* Filters */}
          <div className="filter-row">
            <button className={`chip ${filterOwner === '' ? 'active' : ''}`}
              onClick={() => { setFilterOwner(''); setPagination(p => ({...p, page: 1})); }}>All</button>
            {owners.map(o => (
              <button key={o.id} className={`chip ${filterOwner === o.id ? 'active' : ''}`}
                onClick={() => { setFilterOwner(filterOwner === o.id ? '' : o.id); setPagination(p => ({...p, page: 1})); }}
                style={filterOwner === o.id ? {} : { borderColor: o.color, color: o.color }}>
                {o.icon} {o.name}
              </button>
            ))}
          </div>

          <div className="filter-row">
            <button className={`chip ${filterType === '' ? 'active' : ''}`}
              onClick={() => { setFilterType(''); setPagination(p => ({...p, page: 1})); }}>All Types</button>
            {types.map(t => (
              <button key={t.id} className={`chip ${filterType === t.id ? 'active' : ''}`}
                onClick={() => { setFilterType(filterType === t.id ? '' : t.id); setPagination(p => ({...p, page: 1})); }}>
                {t.icon} {t.name}
              </button>
            ))}
          </div>

          <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)', marginBottom: '12px' }}>
            {pagination.total} document{pagination.total !== 1 ? 's' : ''}
            {search && ` matching "${search}"`}
          </div>

          {/* Document grid */}
          {loading ? <div className="spinner" /> : documents.length === 0 ? (
            <div className="empty-state">
              <div className="icon">📁</div>
              <p>{search ? 'No documents match your search' : 'No documents yet'}</p>
              {!search && <button className="btn btn-primary" onClick={() => navigate('/scan')}>📷 Scan your first document</button>}
            </div>
          ) : (
            <>
              <div className="doc-grid">
                {documents.map(doc => (
                  <div key={doc.id} className="card doc-card" onClick={() => navigate(`/doc/${doc.id}`)}>
                    <div className="thumb">
                      {doc.thumbnail_path
                        ? <img src={`/thumbnails/${doc.thumbnail_path}`} alt="" loading="lazy" />
                        : doc.type_icon || '📄'}
                    </div>
                    <div className="info">
                      <div className="title">{doc.title}</div>
                      <div className="meta">
                        <span className="owner-badge" style={{ background: `${doc.owner_color}20`, color: doc.owner_color }}>
                          {doc.owner_icon} {doc.owner_name}
                        </span>
                        {' · '}{doc.type_name}
                        {doc.amount ? ` · $${Number(doc.amount).toFixed(2)}` : ''}
                        {doc.attachment_count > 0 && <span style={{ marginLeft: '6px', color: 'var(--text-dim)' }}>📎{doc.attachment_count + 1}</span>}
                      </div>
                      <div className="meta">
                        {formatDate(doc.submitted_at)}
                        {doc.vendor && ` · ${doc.vendor}`}
                        {doc.status !== 'active' && <span className={`status-badge status-${doc.status}`} style={{ marginLeft: '6px' }}>{doc.status}</span>}
                      </div>
                      {doc.tags && doc.tags.length > 0 && (
                        <div className="meta" style={{ marginTop: '4px' }}>
                          {doc.tags.map(t => (
                            <span key={t} style={{ background: 'var(--bg-input)', padding: '1px 6px', borderRadius: '4px', fontSize: '0.7rem', marginRight: '4px' }}>{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {pagination.totalPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '16px' }}>
                  <button className="btn btn-secondary" disabled={pagination.page <= 1}
                    onClick={() => setPagination(p => ({...p, page: p.page - 1}))}>← Prev</button>
                  <span style={{ display: 'flex', alignItems: 'center', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
                    {pagination.page} / {pagination.totalPages}
                  </span>
                  <button className="btn btn-secondary" disabled={pagination.page >= pagination.totalPages}
                    onClick={() => setPagination(p => ({...p, page: p.page + 1}))}>Next →</button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Desktop sidebar: recent activity + top types */}
        {stats && (
          <div className="dashboard-sidebar">
            {stats.byType.length > 0 && (
              <div className="sidebar-section">
                <h3>Top Document Types</h3>
                {stats.byType.map(t => (
                  <div key={t.name} className="sidebar-stat-row">
                    <span>{t.icon} {t.name}</span>
                    <span className="sidebar-stat-count">{t.count}</span>
                  </div>
                ))}
              </div>
            )}

            {stats.recentActivity.length > 0 && (
              <div className="sidebar-section">
                <h3>Recent Activity</h3>
                {stats.recentActivity.map(a => (
                  <div key={a.id} className="sidebar-activity"
                    style={{ cursor: a.document_id ? 'pointer' : 'default' }}
                    onClick={() => a.document_id && navigate(`/doc/${a.document_id}`)}>
                    <div className="sidebar-activity-text">{formatDetail(a.action, a.detail)}</div>
                    <div className="sidebar-activity-time">{formatDate(a.created_at)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
