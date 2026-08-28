import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { login, register, getAuthConfig } from '../services/api';

export default function LoginPage() {
  const { setAuth } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState('login'); // login | setup
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [authConfig, setAuthConfig] = useState({ local: true, authentik: false });

  useEffect(() => {
    getAuthConfig().then(setAuthConfig).catch(() => {});
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let data;
      if (mode === 'setup') {
        if (!displayName.trim()) { setError('Display name required'); setLoading(false); return; }
        data = await register(username, password, displayName);
      } else {
        data = await login(username, password);
      }
      setAuth(data.user);
      navigate('/');
    } catch (err) {
      setError(err.message);
      // If login fails with "no users", switch to setup mode
      if (err.message.includes('Invalid credentials') && mode === 'login') {
        setError('No account found. Create the first account below.');
        setMode('setup');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      background: 'var(--bg-primary)'
    }}>
      <div style={{ width: '100%', maxWidth: '360px' }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{ fontSize: '3rem', marginBottom: '8px' }}>📁</div>
          <h1 style={{
            fontSize: '2rem',
            fontWeight: 700,
            letterSpacing: '2px',
            color: 'var(--accent-orange)'
          }}>GENIZAH</h1>
          <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem', marginTop: '4px' }}>
            Digital Filing Cabinet
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          {mode === 'setup' && (
            <div className="form-group">
              <label>Display Name</label>
              <input
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="e.g. Norm"
                autoComplete="name"
              />
            </div>
          )}

          <div className="form-group">
            <label>Username</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="Username"
              autoComplete="username"
              required
            />
          </div>

          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete="current-password"
              required
            />
          </div>

          {error && (
            <div style={{
              background: 'rgba(255,87,87,0.1)',
              border: '1px solid rgba(255,87,87,0.3)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 14px',
              marginBottom: '16px',
              fontSize: '0.85rem',
              color: 'var(--accent-red)'
            }}>
              {error}
            </div>
          )}

          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {loading ? 'Working...' : mode === 'setup' ? 'Create Account' : 'Log In'}
          </button>
        </form>

        {mode === 'login' && (
          <button
            onClick={() => setMode('setup')}
            className="btn btn-ghost btn-block"
            style={{ marginTop: '8px', fontSize: '0.8rem' }}
          >
            First time? Create account
          </button>
        )}
        {mode === 'setup' && (
          <button
            onClick={() => setMode('login')}
            className="btn btn-ghost btn-block"
            style={{ marginTop: '8px', fontSize: '0.8rem' }}
          >
            Already have an account? Log in
          </button>
        )}

        {authConfig.authentik && (
          <>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              margin: '24px 0', color: 'var(--text-dim)', fontSize: '0.8rem'
            }}>
              <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
              or
              <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
            </div>
            <a href={authConfig.authentikUrl} className="btn btn-sso">
              🔐 Sign in with Authentik
            </a>
          </>
        )}
      </div>
    </div>
  );
}
