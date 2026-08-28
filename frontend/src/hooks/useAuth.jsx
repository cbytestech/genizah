import { createContext, useContext, useState, useEffect } from 'react';
import { getMe, isLoggedIn, logout as apiLogout } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check for SSO token in URL (Authentik callback)
    const params = new URLSearchParams(window.location.search);
    const ssoToken = params.get('token');
    if (ssoToken) {
      localStorage.setItem('genizah_token', ssoToken);
      window.history.replaceState({}, '', '/');
    }

    if (isLoggedIn()) {
      getMe()
        .then(data => setUser(data.user))
        .catch(() => setUser(null))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const logout = () => { setUser(null); apiLogout(); };
  const setAuth = (userData) => setUser(userData);

  return (
    <AuthContext.Provider value={{ user, loading, logout, setAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
