/*
 * Copyright 2026 Scalar Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useState } from 'react';
import type { UnifiedConfig, StorageConfig } from '../types';
import { newStorage, getDefaultPort } from '../defaults';
import { dbStorageVerify, type StorageVerifyResult } from '../api';

interface Props {
  name: string;
  config: UnifiedConfig;
  onChange: (config: UnifiedConfig) => void;
  onDelete: () => void;
  onNavigate: (section: { type: 'namespace'; name: string }) => void;
  onRename: (oldName: string, newName: string) => void;
}

export default function StorageEditor({ name, config, onChange, onDelete, onNavigate, onRename }: Props) {
  const storage = config.storages[name];
  if (!storage) return <div>Storage not found</div>;

  function update(patch: Partial<StorageConfig>) {
    onChange({
      ...config,
      storages: {
        ...config.storages,
        [name]: { ...storage, ...patch },
      },
    });
  }

  function updateOptions(patch: Record<string, unknown>) {
    update({ options: { ...storage.options, ...patch } });
  }

  const [verifyResult, setVerifyResult] = useState<StorageVerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  async function handleTestConnection() {
    setVerifying(true);
    setVerifyResult(null);
    try {
      setVerifyResult(await dbStorageVerify(name, config));
    } catch (e) {
      setVerifyResult({
        storage: name, reachable: false, namespaces: [], elapsedMs: 0,
        error: { type: 'NetworkError', message: e instanceof Error ? e.message : String(e) },
      });
    } finally {
      setVerifying(false);
    }
  }

  // Non-destructive connection test at the bottom-right of the Connection group (shared by jdbc/dynamo).
  const testConnBlock = (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          className="btn btn-sm"
          data-testid="test-connection"
          disabled={verifying}
          onClick={handleTestConnection}
        >
          {verifying ? 'Testing…' : 'Test Connection'}
        </button>
      </div>
      {verifyResult && (
        <div data-testid="storage-verify-result" style={{ marginTop: 8, textAlign: 'right' }}>
          <div style={{ color: verifyResult.reachable ? '#2e7d32' : '#c62828' }}>
            {verifyResult.reachable
              ? `✓ reachable (${verifyResult.elapsedMs}ms) — namespaces: ${verifyResult.namespaces.join(', ') || '(none)'}`
              : `✗ ${verifyResult.error?.type}: ${verifyResult.error?.message}`}
          </div>
          {verifyResult.target && (
            <div style={{ marginTop: 2, fontSize: 12, color: '#555' }}>
              Target: <code>{verifyResult.target}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );

  function handleTypeChange(newType: StorageConfig['type']) {
    const created = newStorage(name, newType);
    onChange({
      ...config,
      storages: {
        ...config.storages,
        [name]: created,
      },
    });
  }

  function handleDriverChange(newDriver: StorageConfig['driver']) {
    const created = newStorage(name, 'jdbc', newDriver);
    onChange({
      ...config,
      storages: {
        ...config.storages,
        [name]: created,
      },
    });
  }

  function handleRename(newName: string) {
    const trimmed = newName.trim();
    if (trimmed && trimmed !== name && !config.storages[trimmed]) {
      onRename(name, trimmed);
    }
  }

  // Find references
  const referencedByNamespaces = Object.entries(config.namespaces)
    .filter(([, ns]) => ns.storage === name)
    .map(([nsName]) => nsName);
  const hasReferences = referencedByNamespaces.length > 0;

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Storage</div>
        <button
          className="btn btn-danger btn-sm"
          onClick={onDelete}
          disabled={hasReferences}
          title={hasReferences ? 'Cannot delete: referenced by namespaces or global settings' : ''}
        >
          Delete Storage
        </button>
      </div>

      <div className="form-section">
        <div className="form-group" style={{ marginBottom: 12 }}>
          <label className="form-label">Name</label>
          <input
            className="form-input"
            defaultValue={name}
            onBlur={(e) => handleRename(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRename((e.target as HTMLInputElement).value)}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 12 }}>
          <label className="form-label">Type</label>
          <select
            className="form-select"
            value={storage.type}
            onChange={(e) => handleTypeChange(e.target.value as StorageConfig['type'])}
          >
            <option value="jdbc">JDBC (MySQL / PostgreSQL)</option>
            <option value="dynamo">DynamoDB</option>
            <option value="cosmos">Cosmos DB</option>
          </select>
        </div>
      </div>

      {storage.type === 'jdbc' && (
        <>
          <div className="form-section">
            <div className="form-section-title">Connection</div>
            <div className="form-group" style={{ marginBottom: 10 }}>
              <label className="form-label">Driver</label>
              <select
                className="form-select"
                value={storage.driver || 'mysql'}
                onChange={(e) => handleDriverChange(e.target.value as StorageConfig['driver'])}
              >
                <option value="mysql">MySQL</option>
                <option value="postgresql">PostgreSQL</option>
                <option value="oracle">Oracle</option>
                <option value="sqlserver">SQL Server</option>
              </select>
            </div>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Host</label>
                <input
                  className="form-input"
                  placeholder={`\${SCALAR_RE_DB_${name.toUpperCase()}_HOST:localhost}`}
                  value={storage.host || ''}
                  onChange={(e) => update({ host: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Port</label>
                <input
                  className="form-input"
                  value={storage.port ?? getDefaultPort(storage.driver || 'mysql')}
                  onChange={(e) => {
                    const v = e.target.value;
                    update({ port: /^\d+$/.test(v) ? Number(v) : v });
                  }}
                />
              </div>
            </div>
            {(storage.driver === 'postgresql' || storage.driver === 'oracle' || storage.driver === 'sqlserver') && (
              <div className="form-group" style={{ marginTop: 10 }}>
                <label className="form-label">
                  Database
                  {storage.driver === 'postgresql' && <span style={{ color: 'var(--danger)', marginLeft: 4 }}>*</span>}
                </label>
                <input
                  className="form-input"
                  placeholder={storage.driver === 'postgresql' ? 'Required for PostgreSQL' : ''}
                  value={storage.database || ''}
                  onChange={(e) => update({ database: e.target.value })}
                />
              </div>
            )}
            <div className="form-grid" style={{ marginTop: 10 }}>
              <div className="form-group">
                <label className="form-label">Username</label>
                <input
                  className="form-input"
                  value={storage.username || ''}
                  onChange={(e) => update({ username: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Password</label>
                <input
                  className="form-input"
                  value={storage.password || ''}
                  placeholder={`\${SCALAR_RE_DB_${name.toUpperCase()}_PASSWORD:scalaradmin}`}
                  onChange={(e) => update({ password: e.target.value })}
                />
              </div>
            </div>
            {testConnBlock}
          </div>

          <div className="form-section">
            <div className="form-section-title">Options</div>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Connection Pool Max Total</label>
                <input
                  type="number"
                  className="form-input"
                  value={storage.options?.['connection-pool-max-total'] ?? 200}
                  onChange={(e) => updateOptions({ 'connection-pool-max-total': Number(e.target.value) })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Metadata Cache Expiration (sec)</label>
                <input
                  type="number"
                  className="form-input"
                  value={storage.options?.['metadata-cache-expiration-secs'] ?? 60}
                  onChange={(e) => updateOptions({ 'metadata-cache-expiration-secs': Number(e.target.value) })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Connection Params</label>
                <input
                  className="form-input"
                  placeholder="e.g. sslMode=REQUIRED"
                  value={storage.options?.['connection-params'] ?? ''}
                  onChange={(e) => updateOptions({ 'connection-params': e.target.value })}
                />
              </div>
            </div>
          </div>
        </>
      )}

      {storage.type === 'dynamo' && (
        <>
          <div className="form-section">
            <div className="form-section-title">Connection</div>
            <div className="form-group" style={{ marginBottom: 10 }}>
              <label className="form-label">Region</label>
              <input
                className="form-input"
                placeholder="ap-northeast-1"
                value={storage.region || ''}
                onChange={(e) => update({ region: e.target.value })}
              />
            </div>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Access Key ID</label>
                <input
                  className="form-input"
                  value={storage['access-key-id'] || ''}
                  placeholder={`\${SCALAR_RE_DB_${name.toUpperCase()}_ACCESS_KEY:fakeAccessKey}`}
                  onChange={(e) => update({ 'access-key-id': e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Secret Access Key</label>
                <input
                  className="form-input"
                  value={storage['secret-access-key'] || ''}
                  placeholder={`\${SCALAR_RE_DB_${name.toUpperCase()}_SECRET_KEY:fakeSecretKey}`}
                  onChange={(e) => update({ 'secret-access-key': e.target.value })}
                />
              </div>
            </div>
            {testConnBlock}
          </div>

          <div className="form-section">
            <div className="form-section-title">DynamoDB Options</div>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Namespace Prefix</label>
                <input
                  className="form-input"
                  value={storage.options?.['namespace-prefix'] ?? 'scalarre_'}
                  onChange={(e) => updateOptions({ 'namespace-prefix': e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Endpoint Override</label>
                <input
                  className="form-input"
                  placeholder="http://localhost:8000 (for DynamoDB Local)"
                  value={storage.options?.['endpoint-override'] ?? ''}
                  onChange={(e) => updateOptions({ 'endpoint-override': e.target.value })}
                />
              </div>
            </div>
          </div>
        </>
      )}

      {referencedByNamespaces.length > 0 && (
        <div className="referenced-by">
          <span>Referenced by:</span>
          {referencedByNamespaces.map((ns) => (
            <span key={ns} className="tag" onClick={() => onNavigate({ type: 'namespace', name: ns })}>
              {ns}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
