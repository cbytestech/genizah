import { Routes, Route, NavLink, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ScanPage from './pages/ScanPage';
import DocumentPage from './pages/DocumentPage';
import ActivityPage from './pages/ActivityPage';
import SettingsPage from './pages/SettingsPage';
import ReportsPage from './pages/ReportsPage';
import { useEffect, useState } from 'react';
import { getSyncStatus } from './services/api';

export default function App() {
  const { user, loading, logout } = useAuth();

  if (loading) return <div className="app-layout"><div className="spinner" /></div>;

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" />} />
      </Routes>
    );
  }

  return (
    <>
      {/* Desktop: sidebar layout */}
      <div className="desktop-layout">
        <Sidebar user={user} onLogout={logout} />
        <div className="desktop-main">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/scan" element={<ScanPage />} />
            <Route path="/doc/:id" element={<DocumentPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </div>
      </div>

      {/* Mobile: bottom nav layout */}
      <div className="mobile-layout">
        <MobileTopBar user={user} onLogout={logout} />
        <div className="app-content">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/scan" element={<ScanPage />} />
            <Route path="/doc/:id" element={<DocumentPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </div>
        <BottomNav />
      </div>
    </>
  );
}

function Sidebar({ user, onLogout }) {
  const [syncHealth, setSyncHealth] = useState('unknown');

  useEffect(() => {
    getSyncStatus().then(d => setSyncHealth(d.health || 'unknown')).catch(() => {});
  }, []);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <h1>GENIZAH</h1>
        <span className={`sync-badge sync-${syncHealth}`} title={`Backup: ${syncHealth}`} />
      </div>
      <p className="sidebar-subtitle">Digital Filing Cabinet</p>

      <nav className="sidebar-nav">
        <NavLink to="/" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`} end>
          <span>📂</span> Dashboard
        </NavLink>
        <NavLink to="/scan" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          <span>📷</span> Scan / Upload
        </NavLink>
        <NavLink to="/activity" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          <span>🔔</span> Activity
        </NavLink>
        <NavLink to="/reports" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          <span>📊</span> Reports
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
          <span>⚙️</span> Settings
        </NavLink>
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-user">{user.displayName}</div>
        <button className="btn btn-ghost" onClick={onLogout} style={{ fontSize: '0.8rem', padding: '4px 8px' }}>
          Log out
        </button>
      </div>
    </aside>
  );
}

function MobileTopBar({ user, onLogout }) {
  const [syncHealth, setSyncHealth] = useState('unknown');
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    getSyncStatus().then(d => setSyncHealth(d.health || 'unknown')).catch(() => {});
  }, []);

  function navTo(path) { navigate(path); setMenuOpen(false); }

  return (
    <>
      <div className="top-bar">
        <h1>GENIZAH <span className={`sync-badge sync-${syncHealth}`} /></h1>
        <button className="hamburger-btn" onClick={() => setMenuOpen(!menuOpen)}>
          {menuOpen ? '✕' : '☰'}
        </button>
      </div>

      {menuOpen && (
        <>
          <div className="menu-overlay" onClick={() => setMenuOpen(false)} />
          <div className="slide-menu">
            <div className="slide-menu-user">{user.displayName}</div>
            <button className="slide-menu-item" onClick={() => navTo('/')}>📂 Dashboard</button>
            <button className="slide-menu-item" onClick={() => navTo('/scan')}>📷 Scan / Upload</button>
            <button className="slide-menu-item" onClick={() => navTo('/activity')}>🔔 Activity</button>
            <button className="slide-menu-item" onClick={() => navTo('/reports')}>📊 Reports</button>
            <button className="slide-menu-item" onClick={() => navTo('/settings')}>⚙️ Settings</button>
            <div style={{ borderTop: '1px solid var(--border)', margin: '8px 0' }} />
            <button className="slide-menu-item" onClick={onLogout}>🚪 Log out</button>
          </div>
        </>
      )}
    </>
  );
}

function BottomNav() {
  const navigate = useNavigate();
  return (
    <nav className="bottom-nav">
      <NavLink to="/" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} end>
        <span className="icon">📂</span>Docs
      </NavLink>
      <button className="nav-scan" onClick={() => navigate('/scan')}>📷</button>
      <NavLink to="/activity" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
        <span className="icon">🔔</span>Activity
      </NavLink>
    </nav>
  );
}
