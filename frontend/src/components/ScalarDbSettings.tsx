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

interface Props {
  config: UnifiedConfig;
  onChange: (config: UnifiedConfig) => void;
}

export default function ScalarDbSettings({ config, onChange }: Props) {
  const sdb = config.scalardb || {};
  const storageNames = Object.keys(config.storages);

  function update(patch: Record<string, unknown>) {
    onChange({ ...config, scalardb: { ...sdb, ...patch } });
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-title">ScalarDB Advanced Settings</div>
      </div>

      <div className="form-section">
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">Transaction Manager</label>
            <select
              className="form-select"
              value={sdb['transaction-manager'] || 'consensus-commit'}
              onChange={(e) => update({ 'transaction-manager': e.target.value })}
            >
              <option value="consensus-commit">consensus-commit</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Isolation Level</label>
            <select
              className="form-select"
              value={sdb['isolation-level'] || 'READ_COMMITTED'}
              onChange={(e) => update({ 'isolation-level': e.target.value })}
            >
              <option value="SNAPSHOT">SNAPSHOT</option>
              <option value="READ_COMMITTED">READ_COMMITTED</option>
              <option value="SERIALIZABLE">SERIALIZABLE</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Default Storage</label>
            <select
              className="form-select"
              value={sdb['default-storage'] || ''}
              onChange={(e) => update({ 'default-storage': e.target.value })}
            >
              <option value="">-- Select --</option>
              {storageNames.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="preview-note">
        These settings are typically left at their defaults. Change only if you understand the ScalarDB transaction model.
      </div>
    </div>
  );
}
