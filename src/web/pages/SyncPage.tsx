import { type FormEvent, useEffect, useState } from 'react';
import { authorizeUrl, pkcePair } from '../../shared/dropboxAuth.ts';
import { api } from '../api.ts';
import { askConfirm } from '../dialogs.ts';
import { Link, noteHref } from '../router.ts';
import { refreshSyncStatus, setSyncStatus, syncNow, useSyncFailure, useSyncStatus } from '../sync.ts';
import { showToast } from '../toast.ts';
import { messageOf, timeAgo } from '../util.ts';

const APP_KEY = 'notesapp-dropbox-app-key';
const PENDING = 'notesapp-dropbox-pending';

function remembered(key: string): string {
  try {
    return localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

/** Connecting: the app key, then Dropbox's page in a new tab, then the code it shows. */
function Connect() {
  const [appKey, setAppKey] = useState(() => remembered(APP_KEY));
  // The verifier must survive the trip to Dropbox (a phone may reload the app meanwhile).
  const [verifier, setVerifier] = useState(() => remembered(PENDING));
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const open = () => {
    const key = appKey.trim();
    if (!key) return;
    const pair = pkcePair();
    try {
      localStorage.setItem(APP_KEY, key);
      sessionStorage.setItem(PENDING, pair.verifier);
    } catch {
      // kept in memory only
    }
    setVerifier(pair.verifier);
    window.open(authorizeUrl(key, pair.challenge), '_blank', 'noopener');
  };

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (!verifier || !code.trim()) return;
    setBusy(true);
    try {
      setSyncStatus(await api.syncConnect(appKey.trim(), code.trim(), verifier));
      try {
        sessionStorage.removeItem(PENDING);
      } catch {
        // nothing kept
      }
      showToast('Connected to Dropbox. Syncing…');
      void syncNow();
    } catch (err) {
      showToast(`Could not connect: ${messageOf(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        Sync keeps your notes the same on all your devices, through your Dropbox. The app gets a folder of its own there (<strong>Apps/</strong> and the name you give it below) and can’t
        see anything else in your Dropbox. Everything syncs: notes, versions, PDFs, files, settings, and the vault, which stays encrypted.
      </p>
      <h2>Set it up once</h2>
      <ol className="sync-steps">
        <li>
          At{' '}
          <a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noreferrer">
            dropbox.com/developers/apps
          </a>
          , choose <strong>Create app</strong>, then <strong>Scoped access</strong> and <strong>App folder</strong>, and give it a name nobody has taken (for example
          “notedid-” and your initials).
        </li>
        <li>
          On its <strong>Permissions</strong> tab, tick <strong>files.content.write</strong> and <strong>files.content.read</strong>, and press <strong>Submit</strong>.
        </li>
        <li>
          On its <strong>Settings</strong> tab, copy the <strong>App key</strong>:
          <input className="sync-input" value={appKey} onChange={(e) => setAppKey(e.target.value)} placeholder="App key" aria-label="App key" autoComplete="off" spellCheck={false} />
        </li>
      </ol>
      <h2>Connect this device</h2>
      <form className="sync-steps" onSubmit={(e) => void connect(e)}>
        <p>
          <button type="button" disabled={!appKey.trim()} onClick={open}>
            Open Dropbox
          </button>{' '}
          and allow the app. Dropbox then shows a code: copy it, come back here, and paste it.
        </p>
        <p className="sync-code">
          <input className="sync-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code from Dropbox" aria-label="Code from Dropbox" autoComplete="off" spellCheck={false} />
          <button type="submit" className="primary" disabled={busy || !verifier || !code.trim()}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </p>
      </form>
      <p className="muted small">
        On your other devices, open the app, come here and do the same with the same app key. The first sync on a device brings all your notes, and files both sides already have the
        same aren’t copied again.
      </p>
    </>
  );
}

export function SyncPage() {
  const status = useSyncStatus();
  const failure = useSyncFailure();
  const [syncing, setSyncing] = useState(false);
  useEffect(() => void refreshSyncStatus(), []);

  const run = async (deletes?: 'allow' | 'restore') => {
    setSyncing(true);
    await syncNow({ deletes });
    setSyncing(false);
  };

  const disconnect = async () => {
    const ok = await askConfirm({
      title: 'Disconnect from Dropbox?',
      message: 'This device stops syncing. Nothing is deleted, here or on Dropbox, and you can connect again at any time.',
      confirmLabel: 'Disconnect',
    });
    if (!ok) return;
    try {
      setSyncStatus(await api.syncDisconnect());
    } catch (err) {
      showToast(`Could not disconnect: ${messageOf(err)}`, 'error');
    }
  };

  return (
    <div className="page narrow sync-page">
      <header className="page-head">
        <h1>Sync with Dropbox</h1>
      </header>
      {!status ? (
        <p className="muted">{failure ?? 'Loading…'}</p>
      ) : !status.connected ? (
        <Connect />
      ) : (
        <>
          <p>
            Syncing with the Dropbox of <strong>{status.account?.name}</strong>
            {status.account?.email ? ` (${status.account.email})` : ''}.
          </p>
          <p className="muted">
            {status.running || syncing ? 'Syncing now…' : status.lastSync ? `Last synced ${timeAgo(Date.parse(status.lastSync))}.` : 'Not synced yet.'}
            {status.last && !(status.running || syncing) ? ` ${status.last.up} sent, ${status.last.down} received, ${status.last.deleted} deleted.` : ''}
          </p>
          {(status.lastError ?? failure) && <p className="sync-error">{status.lastError ?? failure}</p>}
          {status.confirmDeletes !== null && (
            <div className="sync-confirm">
              <p>
                <strong>
                  {status.confirmDeletes} files that were synced are no longer on this device.
                </strong>{' '}
                If you deleted them, delete them on Dropbox too. If this device lost them (its browser storage was cleared, say), bring them back.
              </p>
              <p>
                <button type="button" onClick={() => void run('restore')}>
                  Bring them back here
                </button>{' '}
                <button type="button" className="danger" onClick={() => void run('allow')}>
                  Delete them on Dropbox
                </button>
              </p>
            </div>
          )}
          <p>
            <button type="button" className="primary" disabled={syncing || status.running} onClick={() => void run()}>
              Sync now
            </button>{' '}
            <button type="button" onClick={() => void disconnect()}>
              Disconnect
            </button>
          </p>
          {status.conflicts.length > 0 && (
            <>
              <h2>Changed on two devices</h2>
              <p className="muted small">These notes changed in the same place on two devices. The newer text stayed; the other is in the note’s History, to compare or restore.</p>
              <ul className="sync-conflicts">
                {status.conflicts.map((c) => (
                  <li key={c.path}>
                    <Link to={noteHref(c.path)}>{c.path}</Link> <span className="muted small">{timeAgo(Date.parse(c.at))}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="muted small">
            The app syncs when it opens, a few seconds after you change something, every minute while it is open, and when you come back to it. Changes made while offline go out once
            you are online again.
          </p>
        </>
      )}
    </div>
  );
}
