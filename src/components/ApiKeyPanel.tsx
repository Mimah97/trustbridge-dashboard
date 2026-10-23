'use client';

import { useCallback, useEffect, useState } from 'react';

interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface ApiKeyPanelProps {
  initialKeys?: ApiKeyRecord[];
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'Never';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }
  return date.toLocaleString();
}

export default function ApiKeyPanel({ initialKeys = [] }: ApiKeyPanelProps) {
  const [keys, setKeys] = useState<ApiKeyRecord[]>(initialKeys);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/settings/api-keys', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(`Failed to load API keys (${response.status})`);
      }
      const data = (await response.json()) as { keys?: ApiKeyRecord[] };
      setKeys(Array.isArray(data.keys) ? data.keys : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API keys');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialKeys.length === 0) {
      void loadKeys();
    }
  }, [initialKeys.length, loadKeys]);

  return (
    <section className="api-key-panel">
      <header className="api-key-panel__header">
        <h2>API Keys</h2>
        <button type="button" onClick={() => void loadKeys()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {error ? (
        <p className="api-key-panel__error" role="alert">
          {error}
        </p>
      ) : null}

      {keys.length === 0 ? (
        <p className="api-key-panel__empty">No API keys yet.</p>
      ) : (
        <table className="api-key-panel__table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Prefix</th>
              <th scope="col">Created</th>
              <th scope="col">Last used</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td>{key.name}</td>
                <td>
                  <code>{key.prefix}</code>
                </td>
                <td>{formatTimestamp(key.createdAt)}</td>
                <td>{formatTimestamp(key.lastUsedAt)}</td>
                <td>{key.revokedAt ? 'Revoked' : 'Active'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
