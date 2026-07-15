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

import { useState, useEffect, useCallback, useRef } from 'react';
import type { UnifiedConfig, SidebarSection, ValidationError } from './types';
import { defaultConfig, newStorage, newNamespace, updateStorageEnvVars, updateNamespaceHmacEnvVars } from './defaults';
import { validate, getMeta } from './api';
import * as yaml from 'yaml';
import Sidebar from './components/Sidebar';
import GlobalSettings from './components/GlobalSettings';
import StorageEditor from './components/StorageEditor';
import NamespaceEditor from './components/NamespaceEditor';
import OutputBase from './components/OutputBase';
import OutputCompose from './components/OutputCompose';
import OutputK8s from './components/OutputK8s';

function errorPathToSection(path: string): SidebarSection | null {
  if (path.startsWith('storages.')) {
    const name = path.split('.')[1];
    if (name) return { type: 'storage', name };
  }
  if (path.startsWith('namespaces.')) {
    const name = path.split('.')[1];
    if (name) return { type: 'namespace', name };
  }
  if (path.startsWith('global') || path.startsWith('scalardb')) return { type: 'global' };
  return null;
}

function App() {
  const [config, setConfig] = useState<UnifiedConfig>(defaultConfig);
  const [selected, setSelected] = useState<SidebarSection>({ type: 'global' });
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [warnings, setWarnings] = useState<ValidationError[]>([]);
  const [saveStatus, setSaveStatus] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  // Gate destructive DB ops (recreate) on admin auth. Default false until
  // /api/meta resolves, so the Recreate button never flashes enabled.
  const [destructiveOpsAllowed, setDestructiveOpsAllowed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const runValidation = useCallback(async (cfg: UnifiedConfig) => {
    try {
      const result = await validate(cfg);
      setErrors(result.errors || []);
      setWarnings(result.warnings || []);
    } catch {
      // Backend not available, skip validation
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => runValidation(config), 300);
    return () => clearTimeout(timer);
  }, [config, runValidation]);

  useEffect(() => {
    getMeta()
      .then((m) => setDestructiveOpsAllowed(m.destructiveOpsAllowed))
      .catch(() => setDestructiveOpsAllowed(false));
  }, []);

  function handleChange(newConfig: UnifiedConfig) {
    setConfig(newConfig);
    setSaveStatus('');
  }

  let counter = 0;

  function handleAddStorage() {
    let name = 'new_storage';
    while (config.storages[name]) {
      name = `new_storage_${++counter}`;
    }
    handleChange({
      ...config,
      storages: { ...config.storages, [name]: newStorage(name) },
    });
    setSelected({ type: 'storage', name });
  }

  function handleAddNamespace() {
    let name = 'new_namespace';
    while (config.namespaces[name]) {
      name = `new_namespace_${++counter}`;
    }
    const firstStorage = Object.keys(config.storages)[0] || '';
    handleChange({
      ...config,
      namespaces: { ...config.namespaces, [name]: newNamespace(firstStorage, name) },
    });
    setSelected({ type: 'namespace', name });
  }

  function handleRenameStorage(oldName: string, newName: string) {
    const { [oldName]: storage, ...restStorages } = config.storages;
    // Update env var names in the storage config
    const updatedStorage = updateStorageEnvVars(storage, oldName, newName);
    const updatedNamespaces = { ...config.namespaces };
    for (const [nsName, ns] of Object.entries(updatedNamespaces)) {
      if (ns.storage === oldName) {
        updatedNamespaces[nsName] = { ...ns, storage: newName };
      }
    }
    handleChange({
      ...config,
      storages: { ...restStorages, [newName]: updatedStorage },
      namespaces: updatedNamespaces,
    });
    setSelected({ type: 'storage', name: newName });
  }

  function handleRenameNamespace(oldName: string, newName: string) {
    const { [oldName]: ns, ...restNamespaces } = config.namespaces;
    // Update HMAC env var names
    const updatedNs = updateNamespaceHmacEnvVars(ns, oldName, newName);
    const updatedNamespaces = { ...restNamespaces, [newName]: updatedNs };
    for (const [nsName, nsConfig] of Object.entries(updatedNamespaces)) {
      const eventTypes = nsConfig['event-types'];
      if (!eventTypes) continue;
      let changed = false;
      const updatedEts = { ...eventTypes };
      for (const [etName, et] of Object.entries(updatedEts)) {
        if (et.destination === oldName) {
          updatedEts[etName] = { ...et, destination: newName };
          changed = true;
        }
      }
      if (changed) {
        updatedNamespaces[nsName] = { ...nsConfig, 'event-types': updatedEts };
      }
    }
    handleChange({
      ...config,
      namespaces: updatedNamespaces,
    });
    setSelected({ type: 'namespace', name: newName });
  }

  function handleDeleteStorage(name: string) {
    const { [name]: _, ...rest } = config.storages;
    handleChange({ ...config, storages: rest });
    setSelected({ type: 'global' });
  }

  function handleDeleteNamespace(name: string) {
    const { [name]: _, ...rest } = config.namespaces;
    handleChange({ ...config, namespaces: rest });
    setSelected({ type: 'global' });
  }

  function handleNew() {
    if (!confirm('Create a new configuration? Unsaved changes will be lost.')) return;
    setConfig(defaultConfig);
    setSelected({ type: 'global' });
    setSaveStatus('New configuration created');
  }

  function handleOpen() {
    fileInputRef.current?.click();
  }

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = yaml.parse(reader.result as string) as UnifiedConfig;
        if (parsed.namespaces) {
          for (const [, ns] of Object.entries(parsed.namespaces)) {
            if (!ns.destination) {
              ns.destination = { 'worker-threads': 30, 'queue-capacity': 100000, 'throughput-tps': 2000 };
            }
          }
        }
        // Strip deprecated fields on load
        if (parsed.global) {
          const g = parsed.global as Record<string, unknown>;
          delete g['auto-create-tables'];
          delete g['drop-and-recreate-tables'];
          delete g['native-polling'];
          // These keys are not read by the current product.
          // management-* were never bound; offload-completed-table was dropped
          // (re_completed is always placed in scalarre). Strip on load so an old
          // config does not carry them straight through to the emitted yaml.
          delete g['management-namespace'];
          delete g['management-storage'];
          delete g['offload-completed-table'];
          // re-tables inner keys are physical table names = snake_case. Normalize
          // any legacy kebab key (re-node-heartbeat → re_node_heartbeat) so a
          // loaded config does not retain kebab (or duplicate kebab + snake).
          const reTables = g['re-tables'] as Record<string, unknown> | undefined;
          if (reTables) {
            for (const key of Object.keys(reTables)) {
              const snake = key.replace(/-/g, '_');
              if (snake !== key) {
                if (!(snake in reTables)) reTables[snake] = reTables[key];
                delete reTables[key];
              }
            }
          }
        }
        // HMAC keys on load: values are preserved as-is. HMAC keys MUST differ
        // per namespace, but re-distinct-ing a loaded config silently is an
        // operator decision — a legacy all-same-key config is left untouched
        // (operator responsibility). Auto-normalization is deferred to the
        // allowlist/load-migration work in the Spring Boot migration (see
        // docs/spring-boot-migration-plan.md). New namespaces created in the UI
        // already get distinct fallbacks via defaults.ts hmacPlaceholder().
        // v2.8: per-namespace inbox polling knobs removed
        // (see docs/migration-v27-to-v28.md). UnifiedConfigLoader throws
        // on startup if these fields remain in the emitted yaml.
        if (parsed.namespaces) {
          for (const ns of Object.values(parsed.namespaces)) {
            const polling = ns.polling as Record<string, unknown> | undefined;
            if (polling) {
              delete polling['inbox-poll-interval-ms'];
              delete polling['inbox-batch-size'];
            }
          }
        }
        setConfig(parsed);
        setSaveStatus(`Loaded ${file.name}`);
        setSelected({ type: 'global' });
      } catch (err) {
        setSaveStatus(`Load failed: ${err}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function renderMain() {
    switch (selected.type) {
      case 'global':
        return <GlobalSettings config={config} onChange={handleChange} />;
      case 'storage':
        return (
          <StorageEditor
            key={selected.name}
            name={selected.name}
            config={config}
            onChange={handleChange}
            onDelete={() => handleDeleteStorage(selected.name)}
            onNavigate={setSelected}
            onRename={handleRenameStorage}
          />
        );
      case 'namespace':
        return (
          <NamespaceEditor
            key={selected.name}
            name={selected.name}
            config={config}
            onChange={handleChange}
            onDelete={() => handleDeleteNamespace(selected.name)}
            onRename={handleRenameNamespace}
            destructiveOpsAllowed={destructiveOpsAllowed}
          />
        );
      case 'output-base':
        return <OutputBase config={config} />;
      case 'output-compose':
        return <OutputCompose config={config} />;
      case 'output-k8s':
        return <OutputK8s config={config} />;
      default:
        return null;
    }
  }

  return (
    <div className="app">
      <div className="header">
        <div className="header-title">ScalarRE Config Tool</div>
        <div className="header-actions">
          <button className="btn" onClick={handleNew}>New</button>
          <button className="btn" onClick={handleOpen}>Open</button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".yml,.yaml"
        style={{ display: 'none' }}
        onChange={handleFileSelected}
      />

      <div className="body">
        <Sidebar
          config={config}
          selected={selected}
          onSelect={setSelected}
          onAddStorage={handleAddStorage}
          onAddNamespace={handleAddNamespace}
        />
        <div className="main">
          {renderMain()}
        </div>
      </div>

      {showErrors && (errors.length > 0 || warnings.length > 0) && (
        <div className="error-panel">
          {errors.map((err, i) => (
            <div
              key={`e${i}`}
              className="error-panel-item error-panel-error"
              onClick={() => {
                const section = errorPathToSection(err.path);
                if (section) setSelected(section);
                setShowErrors(false);
              }}
            >
              <span className="error-panel-path">{err.path}</span>
              <span>{err.message}</span>
            </div>
          ))}
          {warnings.map((w, i) => (
            <div
              key={`w${i}`}
              className="error-panel-item error-panel-warning"
              onClick={() => {
                const section = errorPathToSection(w.path);
                if (section) setSelected(section);
                setShowErrors(false);
              }}
            >
              <span className="error-panel-path">{w.path}</span>
              <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}

      <div className="footer">
        {errors.length === 0 ? (
          <span className="status-valid">Valid</span>
        ) : (
          <span
            className="status-error"
            style={{ cursor: 'pointer' }}
            onClick={() => setShowErrors(!showErrors)}
          >
            {errors.length} error(s)
          </span>
        )}
        {warnings.length > 0 && (
          <span
            className="status-warning"
            style={{ cursor: 'pointer' }}
            onClick={() => setShowErrors(!showErrors)}
          >
            {warnings.length} warning(s)
          </span>
        )}
        {saveStatus && <span style={{ color: 'var(--text-secondary)' }}>{saveStatus}</span>}
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>
          Schema v{config['schema-version']}
        </span>
      </div>
    </div>
  );
}

export default App;
