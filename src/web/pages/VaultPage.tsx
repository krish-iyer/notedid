import { type FormEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { askConfirm } from '../dialogs.ts';
import { MarkdownEditor } from '../editor/MarkdownEditor.tsx';
import { updateSettings, useSettings } from '../stores.ts';
import { showToast } from '../toast.ts';
import { messageOf, randomId, timeAgo } from '../util.ts';
import { createVault, decryptNote, encryptNote, isKeyFile, setPassphrase, titleOf, unlockVault, type VaultKeyFile, type VaultNote } from '../vault/crypto.ts';

interface OpenVault {
  key: CryptoKey;
  keyFile: VaultKeyFile;
  keyHash: string;
  items: Map<string, { note: VaultNote; hash: string }>;
}

// ---- The open vault lives only in this tab's memory, until it locks. ---------------------------

let current: { vault: OpenVault | null; version: number } = { vault: null, version: 0 };
const listeners = new Set<() => void>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let lastArmed = 0;
let lockAfterMinutes = 10;

function publish(vault: OpenVault | null): void {
  current = { vault, version: current.version + 1 };
  for (const listener of listeners) listener();
}

function armIdleLock(): void {
  lastArmed = Date.now();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!current.vault) return;
    lockVault();
    showToast('The vault locked itself after a while without use.');
  }, lockAfterMinutes * 60_000);
}

function openTheVault(vault: OpenVault): void {
  publish(vault);
  armIdleLock();
}

export function lockVault(): void {
  current.vault?.items.clear();
  clearTimeout(idleTimer);
  publish(null);
}

for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
  window.addEventListener(type, () => current.vault && Date.now() - lastArmed > 15_000 && armIdleLock(), { passive: true });
}

function useVault() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

async function loadItems(key: CryptoKey): Promise<OpenVault['items']> {
  const items: OpenVault['items'] = new Map();
  const list = await api.vaultItems();
  await Promise.all(
    list.map(async (info) => {
      const { bytes, hash } = await api.vaultItem(info.id);
      try {
        items.set(info.id, { note: await decryptNote(key, info.id, bytes), hash });
      } catch {
        console.warn(`vault item ${info.id} could not be decrypted`);
      }
    }),
  );
  return items;
}

// ---- Screens ------------------------------------------------------------------------------

function Intro() {
  return (
    <p className="muted">
      Notes in the vault are encrypted in this browser before they are saved. The server, your notes folder, its history and any AI tool only ever see scrambled data. Without the passphrase or the
      recovery code, nobody can open them, you included.
    </p>
  );
}

function PassphraseFields({ first, second, onFirst, onSecond, label }: { first: string; second: string; onFirst: (v: string) => void; onSecond: (v: string) => void; label: string }) {
  return (
    <>
      <label className="field">
        {label}
        <input type="password" className="text-input" autoComplete="new-password" value={first} onChange={(e) => onFirst(e.target.value)} />
      </label>
      <label className="field">
        Type it again
        <input type="password" className="text-input" autoComplete="new-password" value={second} onChange={(e) => onSecond(e.target.value)} />
      </label>
      <p className="muted small">At least 12 characters. A few unrelated words work well, and are easier to remember.</p>
    </>
  );
}

function checkNewPassphrase(first: string, second: string): string | null {
  if (first.length < 12) return 'Use at least 12 characters.';
  if (first !== second) return 'The two passphrases are different.';
  return null;
}

function Setup() {
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ code: string; vault: OpenVault } | null>(null);
  const [kept, setKept] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = checkNewPassphrase(first, second);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      const { keyFile, recoveryCode, key } = await createVault(first);
      const { hash } = await api.saveVaultKey(JSON.stringify(keyFile, null, 2), null);
      setCreated({ code: recoveryCode, vault: { key, keyFile, keyHash: hash, items: new Map() } });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="page narrow vault-gate">
        <h1>Save your recovery code</h1>
        <p>If you forget the passphrase, this code is the only way back into the vault. Keep it somewhere safe outside this computer, such as on paper or in a password manager.</p>
        <code className="recovery-code">{created.code}</code>
        <div className="toolbar">
          <button type="button" onClick={() => void navigator.clipboard?.writeText(created.code).then(() => showToast('Copied'))}>
            Copy
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} /> I’ve saved the recovery code
        </label>
        <button type="button" className="primary" disabled={!kept} onClick={() => openTheVault(created.vault)}>
          Open the vault
        </button>
      </div>
    );
  }

  return (
    <form className="page narrow vault-gate" onSubmit={(e) => void submit(e)}>
      <h1>
        <Icon name="vault" /> Set up the vault
      </h1>
      <Intro />
      <PassphraseFields first={first} second={second} onFirst={setFirst} onSecond={setSecond} label="Choose a passphrase" />
      {error && <p className="error">{error}</p>}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Creating the keys…' : 'Create the vault'}
      </button>
    </form>
  );
}

function Unlock({ keyFile, keyHash }: { keyFile: VaultKeyFile; keyHash: string }) {
  const [mode, setMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [passphrase, setPassphraseText] = useState('');
  const [code, setCode] = useState('');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const key = await unlockVault(keyFile, passphrase);
      openTheVault({ key, keyFile, keyHash, items: await loadItems(key) });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const recover = async (event: FormEvent) => {
    event.preventDefault();
    const problem = checkNewPassphrase(first, second);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      const result = await setPassphrase(keyFile, { slot: 'recovery', secret: code }, first);
      const { hash } = await api.saveVaultKey(JSON.stringify(result.keyFile, null, 2), keyHash);
      openTheVault({ key: result.key, keyFile: result.keyFile, keyHash: hash, items: await loadItems(result.key) });
      showToast('New passphrase set. The recovery code still works.');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'recovery') {
    return (
      <form className="page narrow vault-gate" onSubmit={(e) => void recover(e)}>
        <h1>Use the recovery code</h1>
        <label className="field">
          Recovery code
          <input className="text-input mono" autoFocus value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
        </label>
        <PassphraseFields first={first} second={second} onFirst={setFirst} onSecond={setSecond} label="New passphrase" />
        {error && <p className="error">{error}</p>}
        <div className="toolbar">
          <button type="submit" className="primary" disabled={busy || !code.trim()}>
            {busy ? 'Checking…' : 'Set the new passphrase'}
          </button>
          <button type="button" className="link-button" onClick={() => setMode('passphrase')}>
            Back
          </button>
        </div>
      </form>
    );
  }

  return (
    <form className="page narrow vault-gate" onSubmit={(e) => void unlock(e)}>
      <h1>
        <Icon name="lock" /> The vault is locked
      </h1>
      <Intro />
      <label className="field">
        Passphrase
        <input type="password" className="text-input" autoFocus autoComplete="current-password" value={passphrase} onChange={(e) => setPassphraseText(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="toolbar">
        <button type="submit" className="primary" disabled={busy || !passphrase}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        <button type="button" className="link-button" onClick={() => setMode('recovery')}>
          Forgot it? Use the recovery code
        </button>
      </div>
    </form>
  );
}

function ChangePassphrase({ vault, onDone }: { vault: OpenVault; onDone: () => void }) {
  const [old, setOld] = useState('');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = checkNewPassphrase(first, second);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const result = await setPassphrase(vault.keyFile, { slot: 'passphrase', secret: old }, first);
      const { hash } = await api.saveVaultKey(JSON.stringify(result.keyFile, null, 2), vault.keyHash);
      vault.keyFile = result.keyFile;
      vault.keyHash = hash;
      showToast('Passphrase changed');
      onDone();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="vault-settings" onSubmit={(e) => void submit(e)}>
      <h2>Change the passphrase</h2>
      <label className="field">
        Current passphrase
        <input type="password" className="text-input" autoComplete="current-password" value={old} onChange={(e) => setOld(e.target.value)} />
      </label>
      <PassphraseFields first={first} second={second} onFirst={setFirst} onSecond={setSecond} label="New passphrase" />
      {error && <p className="error">{error}</p>}
      <div className="toolbar">
        <button type="submit" className="primary" disabled={busy || !old}>
          {busy ? 'Changing…' : 'Change'}
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function VaultEditor({ vault, id, onSaved }: { vault: OpenVault; id: string; onSaved: () => void }) {
  const item = vault.items.get(id);
  const [status, setStatus] = useState<'saved' | 'unsaved' | 'saving' | 'error' | 'conflict'>('saved');
  const draft = useRef(item?.note.body ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const save = () => {
    clearTimeout(timer.current);
    queue.current = queue.current.then(async () => {
      const latest = vault.items.get(id);
      if (!latest || latest.note.body === draft.current) return;
      setStatus('saving');
      const note: VaultNote = { ...latest.note, body: draft.current, title: titleOf(draft.current), updated: new Date().toISOString() };
      try {
        const { hash } = await api.saveVaultItem(id, await encryptNote(vault.key, id, note), latest.hash);
        vault.items.set(id, { note, hash });
        setStatus('saved');
        onSaved();
      } catch (err) {
        setStatus(err instanceof ApiError && err.status === 409 ? 'conflict' : 'error');
        if (!(err instanceof ApiError && err.status === 409)) timer.current = setTimeout(save, 5000);
      }
    });
  };

  useEffect(() => () => save(), []);

  if (!item) return null;
  return (
    <div className="vault-editor">
      <p className="meta">
        <span className={`save-status save-${status}`}>{{ saved: 'Saved, encrypted', unsaved: 'Editing', saving: 'Encrypting and saving…', error: 'Not saved, retrying', conflict: 'Changed in another tab: reload to see it' }[status]}</span>
        <span className="muted small">created {timeAgo(Date.parse(item.note.created))}</span>
      </p>
      <MarkdownEditor
        content={item.note.body}
        version={1}
        notePath={null}
        registryKey={`vault:${id}`}
        privateMode
        autoFocus
        label={`Vault note ${item.note.title}`}
        onChange={(text) => {
          draft.current = text;
          setStatus('unsaved');
          clearTimeout(timer.current);
          timer.current = setTimeout(save, 800);
        }}
      />
    </div>
  );
}

function OpenVaultScreen({ vault, version }: { vault: OpenVault; version: number }) {
  const settings = useSettings();
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [changing, setChanging] = useState(false);
  const [, forceRender] = useState(0);

  const entries = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return [...vault.items.entries()]
      .filter(([, item]) => !f || item.note.title.toLowerCase().includes(f) || item.note.body.toLowerCase().includes(f))
      .sort((a, b) => b[1].note.updated.localeCompare(a[1].note.updated));
  }, [vault, version, filter, selected]);

  useEffect(() => {
    if (!selected || !vault.items.has(selected)) setSelected(entries[0]?.[0] ?? null);
  }, [entries, selected, vault]);

  const create = async () => {
    const id = randomId(16);
    const now = new Date().toISOString();
    const note: VaultNote = { title: 'Untitled', body: '# Untitled\n\n', created: now, updated: now };
    try {
      const { hash } = await api.saveVaultItem(id, await encryptNote(vault.key, id, note), null);
      vault.items.set(id, { note, hash });
      setSelected(id);
      forceRender((n) => n + 1);
    } catch (err) {
      showToast(`Could not create the note: ${messageOf(err)}`, 'error');
    }
  };

  const remove = async (id: string) => {
    const item = vault.items.get(id);
    if (!item || !(await askConfirm({ title: `Delete “${item.note.title}”?`, message: 'It moves to the vault’s trash folder, still encrypted.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.deleteVaultItem(id);
      vault.items.delete(id);
      setSelected(null);
      forceRender((n) => n + 1);
    } catch (err) {
      showToast(`Could not delete: ${messageOf(err)}`, 'error');
    }
  };

  return (
    <div className="vault-open">
      <aside className="vault-list" aria-label="Vault notes">
        <div className="vault-list-head">
          <h1>
            <Icon name="vault" /> Vault
          </h1>
          <button type="button" className="icon-button" title="Lock now" aria-label="Lock the vault" onClick={lockVault}>
            <Icon name="lock" />
          </button>
        </div>
        <button type="button" className="primary" onClick={() => void create()}>
          <Icon name="plus" size={16} /> New vault note
        </button>
        <input className="text-input" value={filter} placeholder="Search the vault" aria-label="Search the vault" onChange={(e) => setFilter(e.target.value)} />
        <ul>
          {entries.map(([id, item]) => (
            <li key={id}>
              <button type="button" className={id === selected ? 'vault-item active' : 'vault-item'} onClick={() => setSelected(id)}>
                <span>{item.note.title}</span>
                <span className="muted small">{timeAgo(Date.parse(item.note.updated))}</span>
              </button>
            </li>
          ))}
          {entries.length === 0 && <li className="muted small">{filter ? 'Nothing matches.' : 'Empty so far.'}</li>}
        </ul>
        <div className="vault-footer">
          <label className="field small">
            Lock after
            <select
              value={settings?.vaultAutoLockMinutes ?? 10}
              onChange={(e) => {
                lockAfterMinutes = Number(e.target.value);
                armIdleLock();
                void updateSettings((s) => ({ ...s, vaultAutoLockMinutes: Number(e.target.value) }));
              }}
            >
              {[2, 5, 10, 30, 60].map((m) => (
                <option key={m} value={m}>
                  {m} minutes idle
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="link-button small" onClick={() => setChanging(true)}>
            Change passphrase
          </button>
        </div>
      </aside>
      <section className="vault-main">
        {changing ? (
          <ChangePassphrase vault={vault} onDone={() => setChanging(false)} />
        ) : selected ? (
          <>
            <div className="vault-toolbar">
              <button type="button" className="icon-button" title="Delete this note" aria-label="Delete this note" onClick={() => void remove(selected)}>
                <Icon name="trash" />
              </button>
            </div>
            <VaultEditor key={selected} vault={vault} id={selected} onSaved={() => forceRender((n) => n + 1)} />
          </>
        ) : (
          <p className="muted">Create a note to start.</p>
        )}
      </section>
    </div>
  );
}

export function VaultPage() {
  const { vault, version } = useVault();
  const settings = useSettings();
  const [key, setKey] = useState<{ keyFile: VaultKeyFile | null; hash: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) lockAfterMinutes = settings.vaultAutoLockMinutes;
  }, [settings]);

  useEffect(() => {
    if (vault) return;
    let cancelled = false;
    api
      .vaultKey()
      .then(({ text, hash }) => {
        if (cancelled) return;
        if (text === null) return setKey({ keyFile: null, hash: null });
        const parsed: unknown = JSON.parse(text);
        if (!isKeyFile(parsed)) throw new Error('The vault key file is not in a format this app understands.');
        setKey({ keyFile: parsed, hash });
      })
      .catch((err: unknown) => !cancelled && setError(messageOf(err)));
    return () => {
      cancelled = true;
    };
  }, [vault]);

  if (vault) return <OpenVaultScreen vault={vault} version={version} />;
  if (error) return <p className="error page">{error}</p>;
  if (!key) return <p className="muted page">Loading…</p>;
  if (!key.keyFile || !key.hash) return <Setup />;
  return <Unlock keyFile={key.keyFile} keyHash={key.hash} />;
}
