import { useEffect, useState } from 'react';

// "Connect LinkedIn" — same session-reuse pattern as the other platforms.
// LinkedIn Learning has no partner API, so the instructor portal is scraped
// with the signed-in session.
export default function ConnectLinkedIn({ onConnected }) {
  const [conn, setConn] = useState(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = () =>
    fetch('/api/linkedin/connection').then((r) => r.json()).then(setConn).catch(() => setConn({ connected: false }));
  useEffect(() => { refresh(); }, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      let cookies;
      try { cookies = JSON.parse(text); } catch { throw new Error('That is not valid JSON. Paste the full Cookie-Editor export.'); }
      const res = await fetch('/api/linkedin/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setOpen(false);
      setText('');
      await refresh();
      onConnected?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const disconnect = async () => { await fetch('/api/linkedin/disconnect', { method: 'POST' }); refresh(); };
  const connected = conn?.connected;

  return (
    <>
      {connected ? (
        <span className="conn ok" onClick={disconnect}>● LinkedIn connected · disconnect</span>
      ) : (
        <button className="ghost" onClick={() => setOpen(true)}>🔗 Connect LinkedIn</button>
      )}

      {open && (
        <div className="drawer-backdrop" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h2>Connect your LinkedIn account</h2>
              <button className="close" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div style={{ padding: '16px 20px' }}>
              <p className="muted" style={{ marginTop: 0 }}>
                LinkedIn has no "authorize app" flow either, so we reuse your existing login. One-time:
              </p>
              <ol className="muted" style={{ lineHeight: 1.7 }}>
                <li>Install the <b>Cookie-Editor</b> extension.</li>
                <li>Open <b>linkedin.com/learning/instructor-portal/analytics</b> logged in.</li>
                <li>Cookie-Editor → <b>Export</b> → <b>Export as JSON</b>.</li>
                <li>Paste below and Connect.</li>
              </ol>
              <p className="muted" style={{ fontSize: 12.5 }}>
                If a scrape later reports "page doesn't exist", that is an expired session — LinkedIn
                serves a missing-page shell instead of redirecting to a login. Reconnect here.
              </p>
              <textarea className="paste" placeholder="Paste the linkedin.com Cookie-Editor JSON here…" value={text} onChange={(e) => setText(e.target.value)} />
              {error && <div className="banner err" style={{ marginTop: 10 }}>❌ {error}</div>}
              <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
                <button onClick={connect} disabled={busy || !text.trim()}>{busy ? 'Connecting…' : 'Connect'}</button>
                <span className="muted" style={{ alignSelf: 'center' }}>Stored locally, gitignored.</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
