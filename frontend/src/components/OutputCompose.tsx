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

import { useState, useMemo } from 'react';
import type { UnifiedConfig } from '../types';
import { generateComposeFiles, defaultComposeOptions } from '../generators/compose';
import type { ComposeOptions } from '../generators/compose';
import { downloadZip } from '../generators/zip';
import { hasMysql, hasPostgres, hasDynamo, extractEnvVars } from '../generators/common';

interface Props {
  config: UnifiedConfig;
}

function generateCommands(config: UnifiedConfig, options: ComposeOptions): { label: string; cmd: string }[] {
  const cmds: { label: string; cmd: string }[] = [];
  const dbProfile = options.dbMode === 'internal' ? ' --profile db' : '';
  const envVars = extractEnvVars(config);

  // --- Secret / env var setup ---
  const envLines: string[] = [];
  for (const [key, value] of Object.entries(envVars)) {
    envLines.push(`${key}=${value}`);
  }
  if (envLines.length > 0) {
    cmds.push({
      label: 'Edit .env to set credentials (included in ZIP)',
      cmd: [
        '# .env contains all env vars with sample defaults.',
        '# Replace values for production before starting:',
        '#',
        ...envLines.map((l) => `# ${l}`),
      ].join('\n'),
    });

    // Override at runtime
    const secretVars = Object.keys(envVars).filter(
      (k) => k.includes('PASSWORD') || k.includes('SECRET') || k.includes('API_KEY') || k.includes('HMAC'),
    );
    if (secretVars.length > 0) {
      cmds.push({
        label: 'Override secrets at startup (alternative to editing .env)',
        cmd: secretVars.map((k) => `${k}=<your-value> \\`).join('\n')
          + `\n  docker compose${dbProfile} up -d`,
      });
    }
  }

  cmds.push({
    label: 'Start all services',
    cmd: `docker compose${dbProfile} up -d`,
  });

  cmds.push({
    label: 'Check status',
    cmd: 'docker compose ps',
  });

  cmds.push({
    label: 'View RE logs (follow)',
    cmd: 'docker compose logs -f re-1 re-2 re-3',
  });

  cmds.push({
    label: 'View init logs',
    cmd: 'docker compose logs scalar-re-init',
  });

  cmds.push({
    label: 'Schema reset (destructive)',
    cmd: [
      `docker compose${dbProfile} down`,
      `docker compose${dbProfile} run --rm scalar-re-init --recreate-schema`,
      `docker compose${dbProfile} up -d`,
    ].join('\n'),
  });

  cmds.push({
    label: 'Stop all services',
    cmd: `docker compose${dbProfile} down`,
  });

  cmds.push({
    label: 'Stop and remove volumes (full reset)',
    cmd: `docker compose${dbProfile} down -v`,
  });

  if (options.lbHostPort !== 8080) {
    cmds.push({
      label: 'Override LB port at startup',
      cmd: `SCALAR_RE_LB_HOST_PORT=${options.lbHostPort} docker compose${dbProfile} up -d`,
    });
  }

  return cmds;
}

export default function OutputCompose({ config }: Props) {
  const [options, setOptions] = useState<ComposeOptions>(defaultComposeOptions);
  const [activeTab, setActiveTab] = useState(0);
  const [saveStatus, setSaveStatus] = useState('');

  const files = useMemo(() => generateComposeFiles(config, options), [config, options]);
  const commands = useMemo(() => generateCommands(config, options), [config, options]);

  const tabs = files.map((f) => f.path);

  async function handleSave() {
    try {
      await downloadZip(files, 'scalar-re-docker-compose.zip');
      setSaveStatus('Downloaded scalar-re-docker-compose.zip');
    } catch (err) {
      setSaveStatus(`Download failed: ${err}`);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Docker Compose Output</div>
        <button className="btn btn-primary" onClick={handleSave}>Save ZIP</button>
      </div>

      {saveStatus && (
        <div style={{ marginBottom: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
          {saveStatus}
        </div>
      )}

      <div className="form-section">
        <div className="form-section-title">Compose Settings</div>
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">RE Node Count</label>
            <input
              type="number"
              className="form-input"
              min={1}
              max={10}
              value={options.nodeCount}
              onChange={(e) => setOptions({ ...options, nodeCount: Math.max(1, Number(e.target.value)) })}
            />
          </div>
          <div className="form-group">
            <label className="form-label">LB Host Port</label>
            <input
              type="number"
              className="form-input"
              value={options.lbHostPort}
              onChange={(e) => setOptions({ ...options, lbHostPort: Number(e.target.value) })}
            />
          </div>
          <div className="form-group">
            <label className="form-label">DB Mode</label>
            <select
              className="form-select"
              value={options.dbMode}
              onChange={(e) => setOptions({ ...options, dbMode: e.target.value as 'internal' | 'external' })}
            >
              <option value="internal">Internal (containers)</option>
              <option value="external">External</option>
            </select>
          </div>
        </div>
        {options.dbMode === 'internal' && (
          <div className="form-grid" style={{ marginTop: 8 }}>
            {hasMysql(config) && (
              <div className="form-checkbox">
                <input
                  type="checkbox"
                  checked={options.mysqlPersistent}
                  onChange={(e) => setOptions({ ...options, mysqlPersistent: e.target.checked })}
                />
                <label>MySQL Persistent Volume</label>
              </div>
            )}
            {hasPostgres(config) && (
              <div className="form-checkbox">
                <input
                  type="checkbox"
                  checked={options.postgresPersistent}
                  onChange={(e) => setOptions({ ...options, postgresPersistent: e.target.checked })}
                />
                <label>PostgreSQL Persistent Volume</label>
              </div>
            )}
            {hasDynamo(config) && (
              <div className="form-checkbox">
                <input
                  type="checkbox"
                  checked={options.dynamoPersistent}
                  onChange={(e) => setOptions({ ...options, dynamoPersistent: e.target.checked })}
                />
                <label>DynamoDB Persistent Volume</label>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="form-section">
        <div className="form-section-title">Usage Commands</div>
        {commands.map((c, i) => (
          <div key={i}>
            <div className="command-label">{c.label}</div>
            <div className="command-block">{c.cmd}</div>
          </div>
        ))}
      </div>

      <div className="preview-tabs">
        {tabs.map((tab, i) => (
          <div
            key={tab}
            className={`preview-tab ${activeTab === i ? 'active' : ''}`}
            onClick={() => setActiveTab(i)}
          >
            {tab}
          </div>
        ))}
      </div>

      <div className="preview-content">
        {files[activeTab]?.content || ''}
      </div>
    </div>
  );
}
