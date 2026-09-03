import { useState, useEffect, useMemo, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getReportSummary, getReportDashboard, getReportByTag,
  getReportByMonth, getReportByDayOfWeek, getReportByVendor,
  getReportByOwner, getReportTrend, getReportExpiring, getReportCsvUrl, getReportPdfUrl, getTags, getOwners
} from '../services/api';

let Recharts = null;

const TAG_COLORS = [
  '#ff9800', '#4a9eff', '#3ad98e', '#b388ff', '#4dd0e1',
  '#ff6b9d', '#ffd54f', '#7c4dff', '#69f0ae', '#ff8a65',
  '#81d4fa', '#e6ee9c', '#ef5350', '#ab47bc', '#26a69a'
];
function tagColor(i) { return TAG_COLORS[i % TAG_COLORS.length]; }

function getPresetRange(preset) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate(), dow = now.getDay();
  const fmt = dt => dt.toISOString().slice(0, 10);
  const pad = n => String(n).padStart(2, '0');
  switch (preset) {
    case 'this-week': return { start: fmt(new Date(y, m, d - dow)), end: fmt(now) };
    case 'last-week': return { start: fmt(new Date(y, m, d - dow - 7)), end: fmt(new Date(y, m, d - dow - 1)) };
    case 'this-month': return { start: `${y}-${pad(m + 1)}-01`, end: fmt(now) };
    case 'last-month': return { start: fmt(new Date(y, m - 1, 1)), end: fmt(new Date(y, m, 0)) };
    case 'this-year': return { start: `${y}-01-01`, end: fmt(now) };
    case 'last-year': return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
    default: return { start: '', end: '' };
  }
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

export default function ReportsPage() {
  const navigate = useNavigate();
  const [preset, setPreset] = useState('this-month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [allTags, setAllTags] = useState([]);
  const [selectedTags, setSelectedTags] = useState([]);
  const [allOwners, setAllOwners] = useState([]);
  const [selectedOwners, setSelectedOwners] = useState([]);
  const [summary, setSummary] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [byTag, setByTag] = useState(null);
  const [byMonth, setByMonth] = useState(null);
  const [byDow, setByDow] = useState(null);
  const [byVendor, setByVendor] = useState(null);
  const [byOwner, setByOwner] = useState(null);
  const [trend, setTrend] = useState(null);
  const [expiring, setExpiring] = useState(null);
  const [loading, setLoading] = useState(true);
  const [chartsReady, setChartsReady] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [showFilters, setShowFilters] = useState(false);
  const [comparePreset, setComparePreset] = useState('');
  const [compareSummary, setCompareSummary] = useState(null);
  const [compareByTag, setCompareByTag] = useState(null);

  useEffect(() => {
    import('recharts').then(mod => { Recharts = mod; setChartsReady(true); }).catch(() => {});
  }, []);

  useEffect(() => {
    getTags().then(t => setAllTags(t.map(tag => tag.name || tag))).catch(() => {});
    getOwners().then(o => setAllOwners(o)).catch(() => {});
  }, []);

  const queryParams = useMemo(() => {
    let start, end;
    if (preset === 'custom') { start = customStart; end = customEnd; }
    else { const r = getPresetRange(preset); start = r.start; end = r.end; }
    const p = {};
    if (start) p.start = start;
    if (end) p.end = end;
    if (selectedTags.length > 0) p.tags = selectedTags.join(',');
    if (selectedOwners.length > 0) p.owners = selectedOwners.join(',');
    return p;
  }, [preset, customStart, customEnd, selectedTags, selectedOwners]);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getReportSummary(queryParams), getReportDashboard(queryParams),
      getReportByTag(queryParams), getReportByMonth(queryParams),
      getReportByDayOfWeek(queryParams), getReportByVendor(queryParams),
      getReportByOwner(queryParams), getReportTrend(queryParams),
      getReportExpiring(90)
    ]).then(([s, d, t, m, dow, v, o, tr, exp]) => {
      setSummary(s); setDashboard(d); setByTag(t); setByMonth(m);
      setByDow(dow); setByVendor(v); setByOwner(o); setTrend(tr);
      setExpiring(exp);
    }).catch(err => console.error('Reports error:', err))
      .finally(() => setLoading(false));
  }, [queryParams]);

  // Comparison mode: fetch data for the compare preset
  useEffect(() => {
    if (!comparePreset) { setCompareSummary(null); setCompareByTag(null); return; }
    const range = getPresetRange(comparePreset);
    const cp = {};
    if (range.start) cp.start = range.start;
    if (range.end) cp.end = range.end;
    if (selectedTags.length > 0) cp.tags = selectedTags.join(',');
    if (selectedOwners.length > 0) cp.owners = selectedOwners.join(',');
    Promise.all([getReportSummary(cp), getReportByTag(cp)])
      .then(([s, t]) => { setCompareSummary(s); setCompareByTag(t); })
      .catch(() => {});
  }, [comparePreset, selectedTags, selectedOwners]);

  function pctDelta(current, prior) {
    if (!prior || prior === 0) return null;
    return Math.round(((current - prior) / prior) * 1000) / 10;
  }

  const presetLabels = {
    'this-week': 'This Week', 'last-week': 'Last Week',
    'this-month': 'This Month', 'last-month': 'Last Month',
    'this-year': 'This Year', 'last-year': 'Last Year',
    'all': 'All Time', 'custom': 'Custom'
  };

  return (
    <div className="reports-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <h2 style={{ fontSize: '1.3rem', fontWeight: 700 }}>📊 Reports</h2>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button className="btn btn-ghost" style={{ fontSize: '0.78rem', padding: '4px 10px' }}
            onClick={() => setShowFilters(!showFilters)}>
            🔽 Filters {(selectedTags.length > 0 || selectedOwners.length > 0) ? `(${selectedTags.length + selectedOwners.length})` : ''}
          </button>
          <a href={getReportPdfUrl(queryParams)} className="btn btn-ghost" style={{ fontSize: '0.78rem', padding: '4px 10px', textDecoration: 'none' }}>📄 PDF</a>
          <a href={getReportCsvUrl(queryParams)} className="btn btn-ghost" style={{ fontSize: '0.78rem', padding: '4px 10px', textDecoration: 'none' }}>📥 CSV</a>
        </div>
      </div>

      {/* Timeframe */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
        {Object.entries(presetLabels).map(([key, label]) => (
          <button key={key} className={`chip ${preset === key ? 'active' : ''}`}
            onClick={() => setPreset(key)}
            style={preset === key ? {} : { borderColor: 'var(--border)', color: 'var(--text-dim)' }}>
            {label}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)}
            style={{ flex: 1, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', padding: '6px 10px', fontSize: '0.85rem' }} />
          <span style={{ color: 'var(--text-dim)', alignSelf: 'center' }}>to</span>
          <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)}
            style={{ flex: 1, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', padding: '6px 10px', fontSize: '0.85rem' }} />
        </div>
      )}

      {/* Filters */}
      {showFilters && (
        <div className="card" style={{ marginBottom: '16px', padding: '12px 16px' }}>
          <div style={{ marginBottom: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-dim)' }}>Tags</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn btn-ghost" style={{ fontSize: '0.7rem', padding: '2px 6px' }} onClick={() => setSelectedTags(allTags.slice())}>All</button>
                <button className="btn btn-ghost" style={{ fontSize: '0.7rem', padding: '2px 6px' }} onClick={() => setSelectedTags([])}>Clear</button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {allTags.map(tag => (
                <button key={tag} className={`chip ${selectedTags.includes(tag) ? 'active' : ''}`}
                  style={{ fontSize: '0.75rem', padding: '2px 8px', ...(selectedTags.includes(tag) ? {} : { borderColor: 'var(--border)', color: 'var(--text-dim)' }) }}
                  onClick={() => setSelectedTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag])}>
                  {tag}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-dim)', marginBottom: '6px', display: 'block' }}>Owners</span>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {allOwners.map(o => (
                <button key={o.id} className={`chip ${selectedOwners.includes(o.id) ? 'active' : ''}`}
                  style={{ fontSize: '0.78rem', ...(selectedOwners.includes(o.id) ? {} : { borderColor: o.color, color: o.color }) }}
                  onClick={() => setSelectedOwners(prev => prev.includes(o.id) ? prev.filter(x => x !== o.id) : [...prev, o.id])}>
                  {o.icon} {o.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Summary Row */}
      {summary && (
        <div className="report-summary-row">
          <div className="report-stat-card">
            <div className="stat-value" style={{ color: 'var(--accent-green)' }}>+${summary.total_income.toFixed(2)}</div>
            <div className="stat-label">Income</div>
          </div>
          <div className="report-stat-card">
            <div className="stat-value" style={{ color: 'var(--accent-red)' }}>${summary.total_expenses.toFixed(2)}</div>
            <div className="stat-label">Expenses</div>
          </div>
          <div className="report-stat-card">
            <div className="stat-value" style={{ color: summary.net >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>{summary.net >= 0 ? '+' : ''}{summary.net.toFixed(2)}</div>
            <div className="stat-label">Net</div>
          </div>
          <div className="report-stat-card">
            <div className="stat-value">{summary.doc_count}</div>
            <div className="stat-label">Docs</div>
          </div>
        </div>
      )}

      {/* Comparison Mode */}
      <div style={{ marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-dim)', fontWeight: 500 }}>Compare to:</span>
          {[['', 'Off'], ['last-week', 'Last Week'], ['last-month', 'Last Month'], ['last-year', 'Last Year']].map(([key, label]) => (
            <button key={key} className={`chip ${comparePreset === key ? 'active' : ''}`}
              onClick={() => setComparePreset(key)}
              style={{ fontSize: '0.72rem', padding: '2px 8px', ...(comparePreset === key ? {} : { borderColor: 'var(--border)', color: 'var(--text-dim)' }) }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Comparison Summary */}
      {compareSummary && summary && (
        <div className="card" style={{ marginBottom: '16px', padding: '12px 16px' }}>
          <h4 style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '10px', color: 'var(--text-dim)' }}>
            {presetLabels[preset]} vs {presetLabels[comparePreset] || comparePreset}
          </h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr auto', gap: '6px 16px', fontSize: '0.82rem', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-dim)', fontWeight: 500 }}>Metric</span>
            <span style={{ color: 'var(--text-dim)', fontWeight: 500, textAlign: 'right' }}>Current</span>
            <span style={{ color: 'var(--text-dim)', fontWeight: 500, textAlign: 'right' }}>Compare</span>
            <span style={{ color: 'var(--text-dim)', fontWeight: 500, textAlign: 'right' }}>Change</span>

            <span>Income</span>
            <span style={{ textAlign: 'right', color: 'var(--accent-green)' }}>${summary.total_income.toFixed(2)}</span>
            <span style={{ textAlign: 'right', color: 'var(--accent-green)' }}>${compareSummary.total_income.toFixed(2)}</span>
            <DeltaBadge current={summary.total_income} prior={compareSummary.total_income} invert={false} />

            <span>Expenses</span>
            <span style={{ textAlign: 'right', color: 'var(--accent-red)' }}>${summary.total_expenses.toFixed(2)}</span>
            <span style={{ textAlign: 'right', color: 'var(--accent-red)' }}>${compareSummary.total_expenses.toFixed(2)}</span>
            <DeltaBadge current={summary.total_expenses} prior={compareSummary.total_expenses} invert={true} />

            <span>Net</span>
            <span style={{ textAlign: 'right' }}>${summary.net.toFixed(2)}</span>
            <span style={{ textAlign: 'right' }}>${compareSummary.net.toFixed(2)}</span>
            <DeltaBadge current={summary.net} prior={compareSummary.net} invert={false} />

            <span>Docs</span>
            <span style={{ textAlign: 'right' }}>{summary.doc_count}</span>
            <span style={{ textAlign: 'right' }}>{compareSummary.doc_count}</span>
            <DeltaBadge current={summary.doc_count} prior={compareSummary.doc_count} invert={false} />
          </div>

          {/* Tag-by-tag comparison */}
          {compareByTag && byTag && compareByTag.tags.length > 0 && (
            <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--border)' }}>
              <h4 style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '8px', color: 'var(--text-dim)' }}>By Tag</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr auto', gap: '4px 16px', fontSize: '0.78rem', alignItems: 'center' }}>
                {(() => {
                  const allTagNames = [...new Set([...byTag.tags.map(t => t.tag), ...compareByTag.tags.map(t => t.tag)])];
                  return allTagNames.map(tagName => {
                    const curr = byTag.tags.find(t => t.tag === tagName);
                    const comp = compareByTag.tags.find(t => t.tag === tagName);
                    const currVal = curr ? curr.expense : 0;
                    const compVal = comp ? comp.expense : 0;
                    if (currVal === 0 && compVal === 0) return null;
                    return (
                      <Fragment key={tagName}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tagName}</span>
                        <span style={{ textAlign: 'right' }}>${currVal.toFixed(2)}</span>
                        <span style={{ textAlign: 'right' }}>${compVal.toFixed(2)}</span>
                        <DeltaBadge current={currVal} prior={compVal} invert={true} />
                      </Fragment>
                    );
                  });
                })()}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="report-tabs">
        {[['dashboard','🏠 Dashboard'],['charts','📊 Charts'],['breakdown','📋 Breakdown']].map(([k,l]) => (
          <button key={k} className={`report-tab ${activeTab === k ? 'active' : ''}`} onClick={() => setActiveTab(k)}>{l}</button>
        ))}
      </div>

      {loading ? <div className="spinner" style={{ margin: '40px auto' }} /> : (
        <>
          {activeTab === 'dashboard' && dashboard && (
            <div className="dashboard-grid">
              {dashboard.last_purchase && (
                <div className="dash-card" onClick={() => navigate(`/doc/${dashboard.last_purchase.id}`)} style={{ cursor: 'pointer' }}>
                  <div className="dash-card-icon">🛒</div>
                  <div className="dash-card-title">Last Purchase</div>
                  <div className="dash-card-value">${dashboard.last_purchase.amount?.toFixed(2)}</div>
                  <div className="dash-card-sub">{dashboard.last_purchase.vendor}</div>
                  <div className="dash-card-meta">{timeAgo(dashboard.last_purchase.created_at)}</div>
                </div>
              )}
              {dashboard.top_vendor && (
                <div className="dash-card">
                  <div className="dash-card-icon">🏆</div>
                  <div className="dash-card-title">Top Vendor</div>
                  <div className="dash-card-value">{dashboard.top_vendor.vendor}</div>
                  <div className="dash-card-sub">{dashboard.top_vendor.visit_count} visits · ${dashboard.top_vendor.total_spent.toFixed(2)}</div>
                  {dashboard.top_vendor.spark.length > 0 && (
                    <div className="dash-spark">
                      {dashboard.top_vendor.spark.map((s, i) => (
                        <div key={i} className="spark-bar" style={{ height: `${Math.max(4, (s.total / Math.max(...dashboard.top_vendor.spark.map(x => x.total || 1))) * 28)}px` }} title={`${s.month}: $${s.total}`} />
                      ))}
                    </div>
                  )}
                </div>
              )}
              {dashboard.biggest_expense && (
                <div className="dash-card" onClick={() => navigate(`/doc/${dashboard.biggest_expense.id}`)} style={{ cursor: 'pointer' }}>
                  <div className="dash-card-icon">💸</div>
                  <div className="dash-card-title">Biggest Expense</div>
                  <div className="dash-card-value" style={{ color: 'var(--accent-red)' }}>${dashboard.biggest_expense.amount.toFixed(2)}</div>
                  <div className="dash-card-sub">{dashboard.biggest_expense.vendor}</div>
                  <div className="dash-card-meta">{dashboard.biggest_expense.date}</div>
                </div>
              )}
              <div className="dash-card">
                <div className="dash-card-icon">🔥</div>
                <div className="dash-card-title">Daily Burn Rate</div>
                <div className="dash-card-value">${dashboard.daily_burn_rate.toFixed(2)}<span style={{ fontSize: '0.6em', color: 'var(--text-dim)' }}>/day</span></div>
                <div className="dash-card-sub">{dashboard.burn_days} days in range</div>
              </div>
              {dashboard.busiest_day && (
                <div className="dash-card">
                  <div className="dash-card-icon">📅</div>
                  <div className="dash-card-title">Busiest Day</div>
                  <div className="dash-card-value">{dashboard.busiest_day.day}</div>
                  <div className="dash-card-sub">${dashboard.busiest_day.total_expense.toFixed(2)} · {dashboard.busiest_day.doc_count} purchases</div>
                </div>
              )}
              {dashboard.biggest_spender && (
                <div className="dash-card">
                  <div className="dash-card-icon">{dashboard.biggest_spender.icon}</div>
                  <div className="dash-card-title">Biggest Spender</div>
                  <div className="dash-card-value" style={{ color: dashboard.biggest_spender.color }}>{dashboard.biggest_spender.owner}</div>
                  <div className="dash-card-sub">${dashboard.biggest_spender.total_expense.toFixed(2)} · {dashboard.biggest_spender.doc_count} docs</div>
                </div>
              )}
              {dashboard.vs_last_period && dashboard.vs_last_period.change_pct !== null && (
                <div className="dash-card">
                  <div className="dash-card-icon">📈</div>
                  <div className="dash-card-title">vs Last Period</div>
                  <div className="dash-card-value" style={{ color: dashboard.vs_last_period.direction === 'up' ? 'var(--accent-red)' : dashboard.vs_last_period.direction === 'down' ? 'var(--accent-green)' : 'var(--text-dim)' }}>
                    {dashboard.vs_last_period.direction === 'up' ? '↑' : dashboard.vs_last_period.direction === 'down' ? '↓' : '→'}{Math.abs(dashboard.vs_last_period.change_pct)}%
                  </div>
                  <div className="dash-card-sub">${dashboard.vs_last_period.current_expense.toFixed(2)} vs ${dashboard.vs_last_period.prior_expense.toFixed(2)}</div>
                </div>
              )}
              {dashboard.fun_facts.length > 0 && (
                <div className="dash-card dash-card-wide">
                  <div className="dash-card-icon">🍕</div>
                  <div className="dash-card-title">Fun Facts</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
                    {dashboard.fun_facts.slice(0, 4).map((f, i) => (
                      <div key={i} style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{f.icon} {f.text}</div>
                    ))}
                  </div>
                </div>
              )}

              {/* Expiring Soon */}
              {expiring && (expiring.expiring_soon.length > 0 || expiring.recently_expired.length > 0) && (
                <div className="dash-card dash-card-wide">
                  <div className="dash-card-icon">⏰</div>
                  <div className="dash-card-title">Expiring Soon</div>
                  {expiring.expiring_soon.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
                      {expiring.expiring_soon.slice(0, 5).map(d => {
                        const daysLeft = Math.ceil((new Date(d.expiration_date) - Date.now()) / 86400000);
                        const urgency = daysLeft <= 7 ? 'var(--accent-red)' : daysLeft <= 30 ? 'var(--accent-orange)' : 'var(--text-secondary)';
                        return (
                          <div key={d.id} onClick={() => navigate(`/doc/${d.id}`)} style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                            <span style={{ fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: 8 }}>
                              {d.type_icon} {d.title}
                            </span>
                            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: urgency, flexShrink: 0 }}>
                              {daysLeft <= 0 ? 'Today!' : daysLeft === 1 ? 'Tomorrow' : `${daysLeft}d`}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.82rem', color: 'var(--text-dim)', marginTop: '4px' }}>Nothing expiring in the next 90 days</div>
                  )}
                  {expiring.recently_expired.length > 0 && (
                    <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.7rem', color: 'var(--accent-red)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px', fontWeight: 600 }}>Recently Expired</div>
                      {expiring.recently_expired.slice(0, 3).map(d => (
                        <div key={d.id} onClick={() => navigate(`/doc/${d.id}`)} style={{ cursor: 'pointer', fontSize: '0.78rem', color: 'var(--text-dim)', padding: '2px 0' }}>
                          {d.type_icon} {d.title} ({d.expiration_date})
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'charts' && chartsReady && (
            <div>
              {byTag && byTag.tags.length > 0 && (
                <div className="card" style={{ marginBottom: '16px', padding: '16px' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '12px' }}>Spending by Tag</h3>
                  <div style={{ width: '100%', height: 300 }}>
                    <Recharts.ResponsiveContainer>
                      <Recharts.PieChart>
                        <Recharts.Pie data={byTag.tags.filter(t => t.expense > 0).map((t, i) => ({ name: t.tag, value: t.expense, fill: tagColor(i) }))}
                          cx="50%" cy="50%" innerRadius={50} outerRadius={100} paddingAngle={2} dataKey="value"
                          label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={true}>
                          {byTag.tags.filter(t => t.expense > 0).map((_, i) => (<Recharts.Cell key={i} fill={tagColor(i)} />))}
                        </Recharts.Pie>
                        <Recharts.Tooltip formatter={v => `$${v.toFixed(2)}`} />
                      </Recharts.PieChart>
                    </Recharts.ResponsiveContainer>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px', justifyContent: 'center' }}>
                    {byTag.tags.filter(t => t.expense > 0).map((t, i) => (
                      <span key={t.tag} style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ width: 10, height: 10, borderRadius: 2, background: tagColor(i), display: 'inline-block' }} />
                        {t.tag}: ${t.expense.toFixed(2)}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {byMonth && byMonth.months.length > 0 && (
                <div className="card" style={{ marginBottom: '16px', padding: '16px' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '12px' }}>Monthly Spending by Tag</h3>
                  <div style={{ width: '100%', height: 350, overflowX: 'auto' }}>
                    <Recharts.ResponsiveContainer width="100%" height="100%">
                      <Recharts.BarChart data={byMonth.months.map(m => {
                        const row = { month: m.month.slice(5) };
                        byMonth.all_tags.forEach(tag => { row[tag] = m.tags[tag]?.expense || 0; });
                        return row;
                      })}>
                        <Recharts.CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                        <Recharts.XAxis dataKey="month" tick={{ fill: '#8a8d9b', fontSize: 12 }} />
                        <Recharts.YAxis tick={{ fill: '#8a8d9b', fontSize: 11 }} tickFormatter={v => `$${v}`} />
                        <Recharts.Tooltip contentStyle={{ background: '#1e2230', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: '0.8rem' }}
                          formatter={v => `$${v.toFixed(2)}`} />
                        {byMonth.all_tags.map((tag, i) => (<Recharts.Bar key={tag} dataKey={tag} stackId="a" fill={tagColor(i)} />))}
                      </Recharts.BarChart>
                    </Recharts.ResponsiveContainer>
                  </div>
                </div>
              )}

              {trend && trend.trend.length > 0 && (
                <div className="card" style={{ marginBottom: '16px', padding: '16px' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '12px' }}>Income vs Expense Trend</h3>
                  <div style={{ width: '100%', height: 250 }}>
                    <Recharts.ResponsiveContainer>
                      <Recharts.LineChart data={trend.trend}>
                        <Recharts.CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                        <Recharts.XAxis dataKey="month" tick={{ fill: '#8a8d9b', fontSize: 12 }} />
                        <Recharts.YAxis tick={{ fill: '#8a8d9b', fontSize: 11 }} tickFormatter={v => `$${v}`} />
                        <Recharts.Tooltip contentStyle={{ background: '#1e2230', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }} formatter={v => `$${v.toFixed(2)}`} />
                        <Recharts.Line type="monotone" dataKey="income" stroke="#3ad98e" strokeWidth={2} dot={false} name="Income" />
                        <Recharts.Line type="monotone" dataKey="expense" stroke="#ff9800" strokeWidth={2} dot={false} name="Expenses" />
                        <Recharts.Legend />
                      </Recharts.LineChart>
                    </Recharts.ResponsiveContainer>
                  </div>
                </div>
              )}

              {byOwner && byOwner.owners.length > 0 && (
                <div className="card" style={{ padding: '16px' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '12px' }}>Spending by Owner</h3>
                  <div style={{ width: '100%', height: 200 }}>
                    <Recharts.ResponsiveContainer>
                      <Recharts.BarChart data={byOwner.owners} layout="vertical">
                        <Recharts.CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                        <Recharts.XAxis type="number" tick={{ fill: '#8a8d9b', fontSize: 11 }} tickFormatter={v => `$${v}`} />
                        <Recharts.YAxis type="category" dataKey="owner" tick={{ fill: '#8a8d9b', fontSize: 12 }} width={80} />
                        <Recharts.Tooltip formatter={v => `$${v.toFixed(2)}`} contentStyle={{ background: '#1e2230', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }} />
                        <Recharts.Bar dataKey="expense" name="Expenses" radius={[0, 4, 4, 0]}>
                          {byOwner.owners.map((o, i) => (<Recharts.Cell key={i} fill={o.color || tagColor(i)} />))}
                        </Recharts.Bar>
                      </Recharts.BarChart>
                    </Recharts.ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'breakdown' && (
            <div>
              {byDow && byDow.days.length > 0 && (
                <div className="card" style={{ marginBottom: '16px', padding: '16px', overflowX: 'auto' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '12px' }}>Day of Week Breakdown</h3>
                  <table className="report-table">
                    <thead><tr><th>Day</th><th style={{ textAlign: 'right' }}>#</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Avg</th><th>Top Tag</th></tr></thead>
                    <tbody>
                      {byDow.days.map(d => (
                        <tr key={d.day}>
                          <td style={{ fontWeight: 500 }}>{d.day}</td>
                          <td style={{ textAlign: 'right' }}>{d.doc_count}</td>
                          <td style={{ textAlign: 'right' }}>${d.expense.toFixed(2)}</td>
                          <td style={{ textAlign: 'right' }}>${d.avg_per_transaction.toFixed(2)}</td>
                          <td>{d.top_tag && <span style={{ background: 'rgba(255,152,0,0.12)', padding: '1px 6px', borderRadius: 4, fontSize: '0.75rem' }}>{d.top_tag}</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {byVendor && byVendor.vendors.length > 0 && (
                <div className="card" style={{ padding: '16px' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '12px' }}>Top Vendors</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {byVendor.vendors.slice(0, 15).map((v, i) => (
                      <div key={v.vendor} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-dim)', width: 24, textAlign: 'right' }}>{i + 1}.</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                            <span style={{ fontSize: '0.88rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {v.vendor}
                              {v.recurring && <span style={{ fontSize: '0.65rem', background: 'rgba(74,158,255,0.15)', color: '#4a9eff', padding: '1px 5px', borderRadius: 4, marginLeft: 6 }}>recurring</span>}
                            </span>
                            <span style={{ fontSize: '0.85rem', fontWeight: 600, flexShrink: 0 }}>${v.expense.toFixed(2)}</span>
                          </div>
                          <div style={{ height: 4, background: 'var(--bg-input)', borderRadius: 2, marginTop: 3 }}>
                            <div style={{ height: '100%', borderRadius: 2, background: tagColor(i), width: `${v.expense_pct}%`, transition: 'width 0.4s' }} />
                          </div>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: 2 }}>{v.doc_count} docs · {v.expense_pct}%</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Delta badge: shows ↑/↓ percentage with color ──
function DeltaBadge({ current, prior, invert = false }) {
  if (prior === 0 && current === 0) return <span style={{ textAlign: 'right', fontSize: '0.75rem', color: 'var(--text-dim)' }}>—</span>;
  if (prior === 0) return <span style={{ textAlign: 'right', fontSize: '0.75rem', color: 'var(--accent-blue)' }}>new</span>;
  const pct = Math.round(((current - prior) / Math.abs(prior)) * 1000) / 10;
  const isUp = pct > 0;
  // For expenses, up is bad (red). For income/net, up is good (green). "invert" flips this.
  const isGood = invert ? !isUp : isUp;
  const color = pct === 0 ? 'var(--text-dim)' : isGood ? 'var(--accent-green)' : 'var(--accent-red)';
  return (
    <span style={{ textAlign: 'right', fontSize: '0.75rem', fontWeight: 600, color }}>
      {pct > 0 ? '↑' : pct < 0 ? '↓' : '→'}{Math.abs(pct)}%
    </span>
  );
}