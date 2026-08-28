import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { login, register, getAuthConfig, getGoogleLoginUrl } from '../services/api';

export default function LoginPage() {
  const { setAuth } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState('login'); // login | setup
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [authConfig, setAuthConfig] = useState({ local: true, authentik: false, google: false });

  useEffect(() => {
    getAuthConfig().then(setAuthConfig).catch(() => {});

    // Check for Google OAuth errors in URL
    const params = new URLSearchParams(window.location.search);
    const googleError = params.get('google_error');
    if (googleError) {
      const messages = {
        no_account: 'No account is linked to that Google account. Log in with your username first, then link Google in Settings.',
        access_denied: 'Google sign-in was cancelled.',
        token_exchange_failed: 'Could not complete Google sign-in. Try again.',
        invalid_state: 'Session expired. Please try again.',
        server_error: 'Something went wrong with Google sign-in.'
      };
      setError(messages[googleError] || `Google sign-in error: ${googleError}`);
      window.history.replaceState({}, '', '/login');
    }
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

  const hasSso = authConfig.authentik || authConfig.google;

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

        {hasSso && (
          <>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              margin: '24px 0', color: 'var(--text-dim)', fontSize: '0.8rem'
            }}>
              <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
              or
              <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
            </div>

            {authConfig.google && (
              <button
                onClick={() => { window.location.href = getGoogleLoginUrl(); }}
                className="btn btn-block"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '10px',
                  padding: '10px 16px',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  fontSize: '0.9rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'border-color 0.2s, background 0.2s'
                }}
              >
                <svg width="18" height="18" viewBox="0 0 48 48">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </svg>
                Sign in with Google
              </button>
            )}

            {authConfig.authentik && (
              <a
                href={authConfig.authentikUrl}
                className="btn btn-sso"
                style={{ marginTop: authConfig.google ? '8px' : 0 }}
              >
                🔐 Sign in with Authentik
              </a>
            )}
          </>
        )}

        {authConfig.google && (
          <p style={{
            textAlign: 'center',
            fontSize: '0.72rem',
            color: 'var(--text-dim)',
            marginTop: '20px',
            lineHeight: 1.4
          }}>
            Link your Google account in Settings first,<br/>
            then you can sign in with Google here.
          </p>
        )}
      </div>
    </div>
  );
}
