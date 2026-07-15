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

import type { UnifiedConfig } from '../types';
import PropLabel from './PropLabel';

// Display-only labels for the Management Tables rows. The re_hold table
// (queue-stage DLQ) co-locates with re_queue — queueHoldNamespace()
// resolves to resolveReTableNamespace(RE_QUEUE) — so the UI shows them together.
// The data key stays 're_queue'; only the visible label differs (changing the
// key would break core's validator.go required-key check + UnifiedConfigLoader).
const TABLE_LABELS: Record<string, string> = {
  re_queue: 're_queue / re_hold',
};

interface Props {
  config: UnifiedConfig;
  onChange: (config: UnifiedConfig) => void;
}

export default function GlobalSettings({ config, onChange }: Props) {
  const g = config.global || {};
  const sdb = config.scalardb || {};
  const storageNames = Object.keys(config.storages);
  const namespaceNames = Object.keys(config.namespaces);

  function updateGlobal(patch: Record<string, unknown>) {
    onChange({ ...config, global: { ...g, ...patch } });
  }

  function updateScalarDb(patch: Record<string, unknown>) {
    onChange({ ...config, scalardb: { ...sdb, ...patch } });
  }

  function updateNested(section: string, patch: Record<string, unknown>) {
    const current = (g as Record<string, unknown>)[section] as Record<string, unknown> || {};
    updateGlobal({ [section]: { ...current, ...patch } });
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-title">General</div>
      </div>

      <div className="form-section">
        <div className="form-section-title">License</div>
        <div className="form-grid">
          <div className="form-group">
            <PropLabel label="Max Nodes" prop="scalar-re.license.max-nodes" />
            <input
              type="number"
              className="form-input"
              value={g.license?.['max-nodes'] ?? ''}
              onChange={(e) => updateNested('license', { 'max-nodes': e.target.value ? Number(e.target.value) : undefined })}
            />
          </div>
          <div className="form-group">
            <PropLabel label="Expires At" prop="scalar-re.license.expires-at" />
            <input
              type="date"
              className="form-input"
              value={g.license?.['expires-at'] || ''}
              onChange={(e) => updateNested('license', { 'expires-at': e.target.value })}
            />
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">ScalarDB</div>
        <div className="form-grid">
          <div className="form-group">
            <PropLabel label="Default Storage" prop="scalar.db.multi_storage.default_storage" />
            <select
              className="form-select"
              value={sdb['default-storage'] || ''}
              onChange={(e) => updateScalarDb({ 'default-storage': e.target.value })}
            >
              <option value="">-- Select --</option>
              {storageNames.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <PropLabel label="Isolation Level" prop="scalar.db.consensus_commit.isolation_level" />
            <select
              className="form-select"
              value={sdb['isolation-level'] || 'READ_COMMITTED'}
              onChange={(e) => updateScalarDb({ 'isolation-level': e.target.value })}
            >
              <option value="SNAPSHOT">SNAPSHOT</option>
              <option value="READ_COMMITTED">READ_COMMITTED</option>
              <option value="SERIALIZABLE">SERIALIZABLE</option>
            </select>
          </div>
          <div className="form-group">
            <PropLabel label="Transaction Manager" prop="scalar.db.transaction_manager" />
            <select
              className="form-select"
              value={sdb['transaction-manager'] || 'consensus-commit'}
              onChange={(e) => updateScalarDb({ 'transaction-manager': e.target.value })}
            >
              <option value="consensus-commit">consensus-commit</option>
            </select>
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">Management Tables</div>
        {['re_node_heartbeat', 're_completed', 're_queue', 're_subscription'].map((tableName) => {
          return (
            <div key={tableName} className="form-grid" style={{ marginBottom: 4 }}>
              <div className="form-group">
                <PropLabel label={TABLE_LABELS[tableName] ?? tableName} prop={`scalar-re.re-tables.${tableName}.namespace`} />
              </div>
              <div className="form-group">
                <select
                  className="form-select"
                  value={(g['re-tables'] as Record<string, any>)?.[tableName]?.namespace || ''}
                  onChange={(e) => {
                    const reTables = { ...(g['re-tables'] || {}) } as Record<string, any>;
                    reTables[tableName] = { ...(reTables[tableName] || {}), namespace: e.target.value };
                    updateGlobal({ 're-tables': reTables });
                  }}
                >
                  <option value="">-- Select --</option>
                  {namespaceNames.map((ns) => (
                    <option key={ns} value={ns}>{ns}</option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
      </div>

      <div className="form-section">
        <div className="form-section-title">Auth</div>
        <div className="form-group">
          <PropLabel label="API Key" prop="scalar-re.auth.api-key" />
          <input
            className="form-input"
            value={g.auth?.['api-key'] || ''}
            placeholder="${SCALAR_RE_API_KEY:change-me}"
            onChange={(e) => updateNested('auth', { 'api-key': e.target.value })}
          />
        </div>
      </div>

      <div className="form-grid" style={{ marginBottom: 0 }}>
        <div className="form-section">
          <div className="form-section-title">Internal Queue</div>
          <div className="form-grid">
            <div className="form-group">
              <PropLabel label="Worker Threads" prop="scalar-re.internal-queue.worker-threads" />
              <input
                type="number"
                className="form-input"
                value={g['internal-queue']?.['worker-threads'] ?? 10}
                onChange={(e) => updateNested('internal-queue', { 'worker-threads': Number(e.target.value) })}
              />
            </div>
            <div className="form-group">
              <PropLabel label="Queue Capacity" prop="scalar-re.internal-queue.queue-capacity" />
              <input
                type="number"
                className="form-input"
                value={g['internal-queue']?.['queue-capacity'] ?? 10000}
                onChange={(e) => updateNested('internal-queue', { 'queue-capacity': Number(e.target.value) })}
              />
            </div>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Retry</div>
          <div className="form-grid">
            <div className="form-group">
              <PropLabel label="Max Attempts" prop="retry.max-attempts" />
              <input
                type="number"
                className="form-input"
                value={g.retry?.['max-attempts'] ?? 3}
                onChange={(e) => updateNested('retry', { 'max-attempts': Number(e.target.value) })}
              />
            </div>
            <div className="form-group">
              <PropLabel label="Initial Delay (ms)" prop="retry.initial-delay-ms" />
              <input
                type="number"
                className="form-input"
                value={g.retry?.['initial-delay-ms'] ?? 100}
                onChange={(e) => updateNested('retry', { 'initial-delay-ms': Number(e.target.value) })}
              />
            </div>
            <div className="form-group">
              <PropLabel label="Max Delay (ms)" prop="retry.max-delay-ms" />
              <input
                type="number"
                className="form-input"
                value={g.retry?.['max-delay-ms'] ?? 5000}
                onChange={(e) => updateNested('retry', { 'max-delay-ms': Number(e.target.value) })}
              />
            </div>
            <div className="form-group">
              <PropLabel label="Multiplier" prop="retry.multiplier" />
              <input
                type="number"
                step="0.1"
                className="form-input"
                value={g.retry?.multiplier ?? 2.0}
                onChange={(e) => updateNested('retry', { multiplier: Number(e.target.value) })}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="form-grid">
        <div className="form-section">
          <div className="form-section-title">Cluster</div>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <PropLabel label="Cluster ID" prop="scalar-re.cluster.cluster-id" />
            <input
              className="form-input"
              value={g.cluster?.['cluster-id'] || 'default'}
              onChange={(e) => updateNested('cluster', { 'cluster-id': e.target.value })}
            />
          </div>
          <div className="form-grid">
            <div className="form-group">
              <PropLabel label="Heartbeat Interval (ms)" prop="scalar-re.cluster.heartbeat-interval-ms" />
              <input
                type="number"
                className="form-input"
                value={g.cluster?.['heartbeat-interval-ms'] ?? 30000}
                onChange={(e) => updateNested('cluster', { 'heartbeat-interval-ms': Number(e.target.value) })}
              />
            </div>
            <div className="form-group">
              <PropLabel label="Heartbeat Expiry (ms)" prop="scalar-re.cluster.heartbeat-expiry-ms" />
              <input
                type="number"
                className="form-input"
                value={g.cluster?.['heartbeat-expiry-ms'] ?? 60000}
                onChange={(e) => updateNested('cluster', { 'heartbeat-expiry-ms': Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="form-group" style={{ marginTop: 10 }}>
            <PropLabel label="Cleanup Retention (ms)" prop="scalar-re.cluster.cleanup-retention-ms" />
            <input
              type="number"
              className="form-input"
              value={g.cluster?.['cleanup-retention-ms'] ?? 86400000}
              onChange={(e) => updateNested('cluster', { 'cleanup-retention-ms': Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Server</div>
          <div className="form-group">
            <PropLabel label="Tomcat Max Threads" prop="server.tomcat.threads.max" />
            <input
              type="number"
              className="form-input"
              value={g.server?.['tomcat-max-threads'] ?? 200}
              onChange={(e) => updateNested('server', { 'tomcat-max-threads': Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Polling (ring dedup / backoff)</div>
          <div className="form-checkbox" style={{ marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={g.polling?.['dedup-enabled'] !== false}
              onChange={(e) => updateNested('polling', { 'dedup-enabled': e.target.checked })}
            />
            <label>Dedup Enabled<code className="prop-name" title="Corresponding RE property">scalar-re.polling.dedup-enabled</code></label>
          </div>
          <div className="form-group">
            <PropLabel label="Peer Timeout (ms)" prop="scalar-re.polling.dedup-peer-timeout-ms" />
            <input
              type="number"
              className="form-input"
              value={g.polling?.['dedup-peer-timeout-ms'] ?? 3000}
              onChange={(e) => updateNested('polling', { 'dedup-peer-timeout-ms': Number(e.target.value) })}
            />
          </div>
          <div className="form-checkbox" style={{ marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={g.polling?.['backoff-enabled'] !== false}
              onChange={(e) => updateNested('polling', { 'backoff-enabled': e.target.checked })}
            />
            <label>Backoff Enabled<code className="prop-name" title="Corresponding RE property">scalar-re.polling.backoff-enabled</code></label>
          </div>
          <div className="form-group">
            <PropLabel label="Backoff Max Interval (ms)" prop="scalar-re.polling.backoff-max-interval-ms" />
            <input
              type="number"
              className="form-input"
              value={g.polling?.['backoff-max-interval-ms'] ?? 30000}
              onChange={(e) => updateNested('polling', { 'backoff-max-interval-ms': Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Replay</div>
          <div className="form-checkbox" style={{ marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={g.replay?.enabled !== false}
              onChange={(e) => updateNested('replay', { enabled: e.target.checked })}
            />
            <label>Replay Enabled<code className="prop-name" title="Corresponding RE property">scalar-re.replay.enabled</code></label>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <PropLabel label="Worker Threads" prop="scalar-re.replay.worker-threads" />
              <input
                type="number"
                className="form-input"
                min={1}
                value={g.replay?.['worker-threads'] ?? 2}
                onChange={(e) => updateNested('replay', { 'worker-threads': Number(e.target.value) })}
              />
            </div>
            <div className="form-group">
              <PropLabel label="Queue Capacity" prop="scalar-re.replay.queue-capacity" />
              <input
                type="number"
                className="form-input"
                min={1}
                value={g.replay?.['queue-capacity'] ?? 100000}
                onChange={(e) => updateNested('replay', { 'queue-capacity': Number(e.target.value) })}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">Subscription (SPull)</div>
        <div className="form-group">
          <PropLabel label="Cache Refresh Interval (ms)" prop="scalar-re.subscription.cache-refresh-interval-ms" />
          <input
            type="number"
            className="form-input"
            value={g.subscription?.['cache-refresh-interval-ms'] ?? 60000}
            onChange={(e) => updateNested('subscription', { 'cache-refresh-interval-ms': Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="form-grid" style={{ marginBottom: 0 }}>
        <div className="form-section">
          <div className="form-section-title">Completed</div>
          <div className="form-group">
            <PropLabel label="Completed TTL (seconds)" prop="scalar-re.completed-ttl-seconds" />
            <input
              type="number"
              className="form-input"
              min={0}
              value={g['completed-ttl-seconds'] ?? 604800}
              onChange={(e) => updateGlobal({ 'completed-ttl-seconds': Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Recovery</div>
          <div className="form-grid">
            <div className="form-group">
              <PropLabel label="Prepared Age Threshold (ms)" prop="scalar-re.recovery.prepared-age-threshold-ms" />
              <input
                type="number"
                className="form-input"
                min={0}
                value={g.recovery?.['prepared-age-threshold-ms'] ?? 15000}
                onChange={(e) => updateNested('recovery', { 'prepared-age-threshold-ms': Number(e.target.value) })}
              />
            </div>
            <div className="form-group">
              <PropLabel label="Inbox Recovery Interval (ms)" prop="scalar-re.recovery.inbox-recovery-interval-ms" />
              <input
                type="number"
                className="form-input"
                min={1000}
                value={g.recovery?.['inbox-recovery-interval-ms'] ?? 15000}
                onChange={(e) => updateNested('recovery', { 'inbox-recovery-interval-ms': Number(e.target.value) })}
              />
            </div>
            <div className="form-group">
              <PropLabel label="Inbox Recovery Batch Size" prop="scalar-re.recovery.inbox-recovery-batch-size" />
              <input
                type="number"
                className="form-input"
                min={1}
                value={g.recovery?.['inbox-recovery-batch-size'] ?? 100}
                onChange={(e) => updateNested('recovery', { 'inbox-recovery-batch-size': Number(e.target.value) })}
              />
            </div>
            <div className="form-group">
              <PropLabel label="Relay Ack Timeout Interval (ms)" prop="scalar-re.recovery.relay-ack-timeout-interval-ms" />
              <input
                type="number"
                className="form-input"
                min={1000}
                value={g.recovery?.['relay-ack-timeout-interval-ms'] ?? 60000}
                onChange={(e) => updateNested('recovery', { 'relay-ack-timeout-interval-ms': Number(e.target.value) })}
              />
            </div>
            <div className="form-group">
              <PropLabel label="Relay Ack Timeout Batch Size" prop="scalar-re.recovery.relay-ack-timeout-batch-size" />
              <input
                type="number"
                className="form-input"
                min={1}
                value={g.recovery?.['relay-ack-timeout-batch-size'] ?? 100}
                onChange={(e) => updateNested('recovery', { 'relay-ack-timeout-batch-size': Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="form-grid" style={{ marginTop: 8 }}>
            <div className="form-checkbox">
              <input
                type="checkbox"
                checked={g.recovery?.['inbox-recovery-enabled'] !== false}
                onChange={(e) => updateNested('recovery', { 'inbox-recovery-enabled': e.target.checked })}
              />
              <label>Inbox Recovery Enabled<code className="prop-name" title="Corresponding RE property">scalar-re.recovery.inbox-recovery-enabled</code></label>
            </div>
            <div className="form-checkbox">
              <input
                type="checkbox"
                checked={g.recovery?.['relay-ack-timeout-enabled'] !== false}
                onChange={(e) => updateNested('recovery', { 'relay-ack-timeout-enabled': e.target.checked })}
              />
              <label>Relay Ack Timeout Enabled<code className="prop-name" title="Corresponding RE property">scalar-re.recovery.relay-ack-timeout-enabled</code></label>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
