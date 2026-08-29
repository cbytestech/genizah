import { useState, useEffect } from 'react';
import { getGmailSenderRules, addGmailSenderRule, removeGmailSenderRule, getGmailRecentSenders } from '../services/api';

export default function GmailSenderRules() {
  const [rules, setRules] = useState([]);
  const [recentSenders, setRecentSenders] = useState([]);
  const [showRecent, setShowRecent] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchRules = async () => {
    try {
      const data = await getGmailSenderRules();
      setRules(data.rules || []);
    } catch (e) {}
    setLoading(false);
  };

  const fetchRecentSenders = async () => {
    try {
      const data = await getGmailRecentSenders();
      setRecentSenders(data.senders || []);
    } catch (e) {}
  };

  useEffect(() => { fetchRules(); }, []);

  const handleAdd = async (email, name = null) => {
    try {
      await addGmailSenderRule(email, name, 'block');
      fetchRules();
      setNewEmail('');
    } catch (e) {}
  };

  const handleRemove = async (id) => {
    try {
      await removeGmailSenderRule(id);
      fetchRules();
    } catch (e) {}
  };

  const toggleRecent = () => {
    if (!showRecent) fetchRecentSenders();
    setShowRecent(!showRecent);
  };

  if (loading) return null;

  return (
    <div className="settings-section" style={{ marginTop: '8px' }}>
      <h4 style={{ margin: '0 0 10px', color: 'var(--text-primary, #eee)', fontSize: '15px' }}>
        🚫 Blocked Senders
      </h4>
      <p style={{ fontSize: '12px', color: 'var(--text-secondary, #888)', margin: '0 0 12px' }}>
        Emails from blocked senders will be skipped during scans.
      </p>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        <input
          type="email"
          value={newEmail}
          onChange={e => setNewEmail(e.target.value)}
          placeholder="sender@example.com"
          onKeyDown={e => e.key === 'Enter' && newEmail && handleAdd(newEmail)}
          style={{
            flex: 1, padding: '8px 12px',
            background: 'var(--bg-secondary, #1e1e1e)',
            border: '1px solid var(--border, #333)',
            borderRadius: '6px', color: 'var(--text-primary, #eee)',
            fontSize: '14px',
          }}
        />
        <button
          onClick={() => newEmail && handleAdd(newEmail)}
          disabled={!newEmail}
          style={{
            padding: '8px 16px',
            background: newEmail ? '#e74c3c' : '#555',
            color: '#fff', border: 'none', borderRadius: '6px',
            fontSize: '13px', fontWeight: 600, cursor: newEmail ? 'pointer' : 'default',
          }}
        >
          Block
        </button>
      </div>

      {rules.length > 0 && (
        <div style={{ marginBottom: '12px' }}>
          {rules.map(rule => (
            <div key={rule.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '6px 10px', borderBottom: '1px solid var(--border, #333)',
              fontSize: '13px',
            }}>
              <span style={{ color: 'var(--text-primary, #ddd)' }}>
                {rule.sender_email}
                {rule.sender_name && (
                  <span style={{ color: 'var(--text-secondary, #777)', marginLeft: '6px' }}>
                    ({rule.sender_name})
                  </span>
                )}
              </span>
              <button
                onClick={() => handleRemove(rule.id)}
                style={{
                  background: 'none', border: 'none', color: '#e74c3c',
                  cursor: 'pointer', fontSize: '13px', padding: '2px 6px',
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={toggleRecent}
        style={{
          background: 'none', border: 'none', color: 'var(--accent-blue, #3498db)',
          cursor: 'pointer', fontSize: '13px', padding: '4px 0',
        }}
      >
        {showRecent ? '▼ Hide recent senders' : '▶ Show recent senders (block from list)'}
      </button>

      {showRecent && recentSenders.length > 0 && (
        <div style={{
          marginTop: '8px', maxHeight: '200px', overflowY: 'auto',
          background: 'var(--bg-secondary, #1e1e1e)', borderRadius: '8px',
          padding: '4px',
        }}>
          {recentSenders
            .filter(s => s.rule !== 'block')
            .map(sender => (
              <div key={sender.sender} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '6px 10px', fontSize: '13px',
                borderBottom: '1px solid var(--border, #333)',
              }}>
                <div>
                  <span style={{ color: 'var(--text-primary, #ddd)' }}>{sender.sender}</span>
                  <span style={{ color: 'var(--text-secondary, #666)', marginLeft: '8px', fontSize: '11px' }}>
                    {sender.count} email{sender.count !== 1 ? 's' : ''}
                  </span>
                </div>
                <button
                  onClick={() => handleAdd(sender.sender)}
                  style={{
                    background: '#e74c3c22', border: '1px solid #e74c3c55',
                    color: '#e74c3c', borderRadius: '4px', cursor: 'pointer',
                    fontSize: '11px', padding: '2px 8px',
                  }}
                >
                  Block
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
