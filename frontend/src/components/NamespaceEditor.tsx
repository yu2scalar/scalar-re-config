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
import type { UnifiedConfig, NamespaceConfig, EventTypeConfig } from '../types';
import PropLabel from './PropLabel';
import {
  dbNamespaceStatus, dbNamespaceCreate, dbNamespaceRecreate,
  type NamespaceStatusResult, type NamespaceOpResult,
} from '../api';

interface Props {
  name: string;
  config: UnifiedConfig;
  onChange: (config: UnifiedConfig) => void;
  onDelete: () => void;
  onRename: (oldName: string, newName: string) => void;
  /** Recreate (destructive) is only allowed when admin auth is enabled. */
  destructiveOpsAllowed: boolean;
}

export default function NamespaceEditor({ name, config, onChange, onDelete, onRename, destructiveOpsAllowed }: Props) {
  const ns = config.namespaces[name];

  if (!ns) return <div>Namespace not found</div>;

  const storageNames = Object.keys(config.storages);
  const namespaceNames = Object.keys(config.namespaces).filter((n) => n !== name);

  function update(patch: Partial<NamespaceConfig>) {
    onChange({
      ...config,
      namespaces: {
        ...config.namespaces,
        [name]: { ...ns, ...patch },
      },
    });
  }

  function updateNested(section: keyof NamespaceConfig, patch: Record<string, unknown>) {
    const current = (ns[section] as Record<string, unknown>) || {};
    update({ [section]: { ...current, ...patch } } as Partial<NamespaceConfig>);
  }

  function updateEventType(etName: string, patch: Partial<EventTypeConfig>) {
    const eventTypes = { ...ns['event-types'] };
    eventTypes[etName] = { ...eventTypes[etName], ...patch };
    update({ 'event-types': eventTypes });
  }

  function renameEventType(oldName: string, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    const eventTypes = { ...ns['event-types'] };
    if (eventTypes[trimmed]) return; // Name already exists
    const et = eventTypes[oldName];
    delete eventTypes[oldName];
    eventTypes[trimmed] = et;
    update({ 'event-types': eventTypes });
  }

  function addEventType() {
    const eventTypes = { ...ns['event-types'] };
    // Generate a temporary unique name
    let idx = 1;
    let tempName = 'NewEventType';
    while (eventTypes[tempName]) {
      tempName = `NewEventType${idx++}`;
    }
    eventTypes[tempName] = { 'delivery-type': 'atomic', enabled: true };
    update({ 'event-types': eventTypes });
  }

  function toPascalCase(s: string): string {
    return s.split(/[_\-\s]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
  }

  function generateAllEventTypes() {
    const deliveryTypes: EventTypeConfig['delivery-type'][] = ['atomic', 'partial', 'relay', 'pull', 'qpull', 'spull', 'ordered_atomic'];
    const prefix = toPascalCase(name);
    const eventTypes = { ...ns['event-types'] };
    for (const dt of deliveryTypes) {
      const etName = prefix + toPascalCase(dt);
      if (!eventTypes[etName]) {
        eventTypes[etName] = { 'delivery-type': dt, enabled: true };
      }
    }
    update({ 'event-types': eventTypes });
  }

  function deleteEventType(etName: string) {
    const eventTypes = { ...ns['event-types'] };
    delete eventTypes[etName];
    update({ 'event-types': eventTypes });
  }

  function handleRename(newName: string) {
    const trimmed = newName.trim();
    if (trimmed && trimmed !== name && !config.namespaces[trimmed]) {
      onRename(name, trimmed);
    }
  }

  const [dbStatus, setDbStatus] = useState<NamespaceStatusResult | null>(null);
  const [dbOp, setDbOp] = useState<NamespaceOpResult | null>(null);
  const [dbBusy, setDbBusy] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  async function runDb<T>(fn: () => Promise<T>, set: (v: T) => void, otherReset: () => void) {
    setDbBusy(true);
    otherReset();
    try {
      set(await fn());
    } finally {
      setDbBusy(false);
    }
  }

  // DB ops shown at the bottom-right of the Name/Storage section (deploy/admin: acts on the real DB).
  const dbOpsBlock = (
    <div data-testid="namespace-db-ops" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-sm" disabled={dbBusy}
          onClick={() => runDb(() => dbNamespaceStatus(name, config), setDbStatus, () => setDbOp(null))}>
          Check Status
        </button>
        <button className="btn btn-sm" disabled={dbBusy}
          onClick={() => runDb(() => dbNamespaceCreate(name, config), setDbOp, () => setDbStatus(null))}>
          Create
        </button>
        <input className="form-input" style={{ maxWidth: 180 }}
          placeholder={destructiveOpsAllowed ? `type "${name}" to recreate` : 'recreate disabled'}
          value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
          disabled={!destructiveOpsAllowed} />
        <button className="btn btn-danger btn-sm"
          disabled={dbBusy || !destructiveOpsAllowed || confirmText !== name}
          title={destructiveOpsAllowed
            ? 'Destructive: drops the namespace and its RE tables, then recreates'
            : 'Set ADMIN_PASSWORD to enable destructive operations'}
          onClick={() => { runDb(() => dbNamespaceRecreate(name, config), setDbOp, () => setDbStatus(null)); setConfirmText(''); }}>
          Recreate
        </button>
      </div>
      {dbStatus && (
        <div data-testid="namespace-status-result" style={{ marginTop: 8, textAlign: 'right', fontSize: 13 }}>
          <span style={{ color: dbStatus.healthy ? '#2e7d32' : '#c62828' }}>
            {dbStatus.error
              ? `✗ ${dbStatus.error.type}: ${dbStatus.error.message}`
              : `namespace ${dbStatus.namespaceExists ? 'exists' : 'MISSING'} / ${dbStatus.healthy ? 'healthy' : 'incomplete'}`}
          </span>
          {!dbStatus.error && (
            <div style={{ marginTop: 4 }}>
              {dbStatus.tables.map((t) => (
                <span key={t.table} style={{ marginLeft: 8, color: t.exists ? '#2e7d32' : '#c62828' }}>
                  {t.table} {t.exists ? '✓' : '✗'}
                </span>
              ))}
            </div>
          )}
          {dbStatus.target && (
            <div style={{ marginTop: 4, fontSize: 12, color: '#555' }}>Target: <code>{dbStatus.target}</code></div>
          )}
        </div>
      )}
      {dbOp && (
        <div data-testid="namespace-op-result" style={{ marginTop: 8, textAlign: 'right', fontSize: 13 }}>
          <div style={{ color: dbOp.ok ? '#2e7d32' : '#c62828' }}>
            {dbOp.ok
              ? `✓ ${dbOp.mode}: created ${dbOp.created.length} / skipped ${dbOp.skipped.length} / dropped ${dbOp.dropped.length} (${dbOp.elapsedMs}ms)`
              : `✗ ${dbOp.error?.type}: ${dbOp.error?.message}`}
          </div>
          {dbOp.target && (
            <div style={{ marginTop: 2, fontSize: 12, color: '#555' }}>Target: <code>{dbOp.target}</code></div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Namespace</div>
        <button className="btn btn-danger btn-sm" onClick={onDelete}>
          Delete Namespace
        </button>
      </div>

      <div className="form-section">
        <div className="form-group" style={{ marginBottom: 10 }}>
          <label className="form-label">Name</label>
          <input
            className="form-input"
            defaultValue={name}
            onBlur={(e) => handleRename(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRename((e.target as HTMLInputElement).value)}
          />
        </div>
        <div className="form-group">
          <PropLabel label="Storage" prop="scalar.db.multi_storage.namespace_mapping" />
          <select
            className="form-select"
            value={ns.storage}
            onChange={(e) => update({ storage: e.target.value })}
          >
            <option value="">-- Select --</option>
            {storageNames.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        {dbOpsBlock}
      </div>

      <div className="form-section">
        <div className="form-section-title">Destination Queue</div>
        <div className="form-grid-3">
          <div className="form-group">
            <PropLabel label="Worker Threads" prop={`scalar-re.namespaces.${name}.destination-config.worker-threads`} />
            <input
              type="number"
              className="form-input"
              value={ns.destination?.['worker-threads'] ?? 30}
              onChange={(e) => updateNested('destination', { 'worker-threads': Number(e.target.value) })}
            />
          </div>
          <div className="form-group">
            <PropLabel label="Queue Capacity" prop={`scalar-re.namespaces.${name}.destination-config.queue-capacity`} />
            <input
              type="number"
              className="form-input"
              value={ns.destination?.['queue-capacity'] ?? 100000}
              onChange={(e) => updateNested('destination', { 'queue-capacity': Number(e.target.value) })}
            />
          </div>
          <div className="form-group">
            <PropLabel label="Throughput TPS" prop={`scalar-re.namespaces.${name}.destination-config.throughput-tps`} />
            <input
              type="number"
              className="form-input"
              value={ns.destination?.['throughput-tps'] ?? 2000}
              onChange={(e) => updateNested('destination', { 'throughput-tps': Number(e.target.value) })}
            />
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">Polling</div>
        <div className="form-grid">
          <div className="form-group">
            <PropLabel label="Outbox Poll Interval (ms)" prop={`scalar-re.namespaces.${name}.config.outbox-poll-interval-ms`} />
            <input
              type="number"
              className="form-input"
              value={ns.polling?.['outbox-poll-interval-ms'] ?? 5000}
              onChange={(e) => updateNested('polling', { 'outbox-poll-interval-ms': Number(e.target.value) })}
            />
          </div>
          <div className="form-group">
            <PropLabel label="Outbox Poll Delay (ms)" prop={`scalar-re.namespaces.${name}.config.outbox-poll-delay-ms`} />
            <input
              type="number"
              className="form-input"
              value={ns.polling?.['outbox-poll-delay-ms'] ?? 5000}
              onChange={(e) => updateNested('polling', { 'outbox-poll-delay-ms': Number(e.target.value) })}
            />
          </div>
          <div className="form-group">
            <PropLabel label="Outbox Batch Size" prop={`scalar-re.namespaces.${name}.config.outbox-batch-size`} />
            <input
              type="number"
              className="form-input"
              value={ns.polling?.['outbox-batch-size'] ?? 100}
              onChange={(e) => updateNested('polling', { 'outbox-batch-size': Number(e.target.value) })}
            />
          </div>
          {/* Inbox poll fields removed in v2.8. The new InboxRecoveryScanner
              runs cluster-wide (leader-only scheduled + startup burst) with
              global knobs under scalar-re.recovery.* — there is no
              per-namespace override. See docs/migration-v27-to-v28.md. */}
        </div>
      </div>

      <div className="form-section">
        <div className="form-checkbox">
          <input
            type="checkbox"
            checked={ns['completed-enabled'] !== false}
            onChange={(e) => update({ 'completed-enabled': e.target.checked })}
          />
          <label>Completed Enabled<code className="prop-name" title="Corresponding RE property">{`scalar-re.namespaces.${name}.config.completed-enabled`}</code></label>
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">HMAC</div>
        <div className="form-group full-width" style={{ marginBottom: 10 }}>
          <PropLabel label="Key" prop={`scalar-re.namespaces.${name}.config.hmac-key`} />
          <input
            className="form-input"
            value={ns.hmac?.key ?? ''}
            placeholder={`\${SCALAR_RE_HMAC_KEY_${name.toUpperCase()}:demo-hmac-key-${name.toLowerCase()}}`}
            onChange={(e) => updateNested('hmac', { key: e.target.value })}
          />
        </div>
        <div className="form-grid">
          <div className="form-group">
            <PropLabel label="Key Previous" prop={`scalar-re.namespaces.${name}.config.hmac-key-previous`} />
            <input
              className="form-input"
              value={ns.hmac?.['key-previous'] ?? ''}
              onChange={(e) => updateNested('hmac', { 'key-previous': e.target.value })}
            />
          </div>
          <div className="form-group">
            <PropLabel label="Previous Expires At" prop={`scalar-re.namespaces.${name}.config.hmac-key-previous-expires-at`} />
            <input
              type="number"
              className="form-input"
              value={ns.hmac?.['key-previous-expires-at'] ?? 0}
              onChange={(e) => updateNested('hmac', { 'key-previous-expires-at': Number(e.target.value) })}
            />
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">Event Types</div>
        <table className="event-table">
          <thead>
            {/* Property names are relative to scalar-re.namespaces.{name}.event-types.<EventTypeName>.* */}
            <tr>
              <th style={{ width: '20%' }}>Name<code className="prop-name">…event-types.&lt;name&gt;</code></th>
              <th style={{ width: '12%' }}>Delivery Type<code className="prop-name">.delivery-type</code></th>
              <th style={{ width: '20%' }}>Destination(s)<code className="prop-name">.destination</code></th>
              <th style={{ width: '10%' }}>Partitions<code className="prop-name">.partition-count</code></th>
              <th style={{ width: '8%' }}>Enabled<code className="prop-name">.enabled</code></th>
              <th style={{ width: '5%' }}></th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(ns['event-types'] || {}).map(([etName, et]) => (
              <tr key={etName}>
                <td>
                  <input
                    className="form-input"
                    style={{ fontSize: 13 }}
                    defaultValue={etName}
                    onBlur={(e) => renameEventType(etName, e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && renameEventType(etName, (e.target as HTMLInputElement).value)}
                  />
                </td>
                <td>
                  <select
                    className="form-select"
                    value={et['delivery-type']}
                    onChange={(e) => updateEventType(etName, { 'delivery-type': e.target.value as EventTypeConfig['delivery-type'] })}
                  >
                    <option value="atomic">atomic</option>
                    <option value="partial">partial</option>
                    <option value="relay">relay</option>
                    <option value="pull">pull</option>
                    <option value="qpull">qpull</option>
                    <option value="spull">spull</option>
                    <option value="ordered_atomic">ordered_atomic</option>
                  </select>
                </td>
                <td>
                  {et['delivery-type'] === 'pull' ? (
                    <select
                      className="form-select"
                      value={et.destination || ''}
                      onChange={(e) => updateEventType(etName, { destination: e.target.value })}
                    >
                      <option value="">-- Select --</option>
                      {namespaceNames.map((ns) => (
                        <option key={ns} value={ns}>{ns}</option>
                      ))}
                    </select>
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>--</span>
                  )}
                </td>
                <td>
                  {['qpull', 'atomic', 'partial', 'relay', 'pull', 'ordered_atomic'].includes(et['delivery-type']) ? (
                    <input
                      type="number"
                      className="form-input"
                      style={{ fontSize: 12, width: '100%' }}
                      value={et['partition-count'] ?? 1}
                      min={1}
                      max={10000}
                      title="Allowed range: 1..10000"
                      onChange={(e) => updateEventType(etName, { 'partition-count': Number(e.target.value) })}
                    />
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>--</span>
                  )}
                </td>
                <td style={{ textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={et.enabled !== false}
                    onChange={(e) => updateEventType(etName, { enabled: e.target.checked })}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                </td>
                <td>
                  <button className="btn-icon" onClick={() => deleteEventType(etName)} title="Delete">
                    x
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={addEventType}>+ Add Event Type</button>
          <button className="btn btn-sm" onClick={generateAllEventTypes}>Generate All Types</button>
        </div>
      </div>
    </div>
  );
}
