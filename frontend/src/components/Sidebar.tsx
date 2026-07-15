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

import type { UnifiedConfig, SidebarSection } from '../types';

interface Props {
  config: UnifiedConfig;
  selected: SidebarSection;
  onSelect: (section: SidebarSection) => void;
  onAddStorage: () => void;
  onAddNamespace: () => void;
}

function isActive(selected: SidebarSection, check: SidebarSection): boolean {
  if (selected.type !== check.type) return false;
  if ('name' in selected && 'name' in check) return selected.name === check.name;
  return true;
}

export default function Sidebar({ config, selected, onSelect, onAddStorage, onAddNamespace }: Props) {
  return (
    <div className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          Storages
        </div>
        {Object.keys(config.storages).map((name) => (
          <div
            key={name}
            className={`sidebar-item ${isActive(selected, { type: 'storage', name }) ? 'active' : ''}`}
            onClick={() => onSelect({ type: 'storage', name })}
          >
            {name}
          </div>
        ))}
        <div className="sidebar-add" onClick={onAddStorage}>+ Add Storage</div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-header">
          Namespaces
        </div>
        {Object.keys(config.namespaces).map((name) => (
          <div
            key={name}
            className={`sidebar-item ${isActive(selected, { type: 'namespace', name }) ? 'active' : ''}`}
            onClick={() => onSelect({ type: 'namespace', name })}
          >
            {name}
          </div>
        ))}
        <div className="sidebar-add" onClick={onAddNamespace}>+ Add Namespace</div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-header">Settings</div>
        <div
          className={`sidebar-item ${isActive(selected, { type: 'global' }) ? 'active' : ''}`}
          onClick={() => onSelect({ type: 'global' })}
        >
          General
        </div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-header">Output</div>
        <div
          className={`sidebar-item ${isActive(selected, { type: 'output-base' }) ? 'active' : ''}`}
          onClick={() => onSelect({ type: 'output-base' })}
        >
          Base (YAML)
        </div>
        <div
          className={`sidebar-item ${isActive(selected, { type: 'output-compose' }) ? 'active' : ''}`}
          onClick={() => onSelect({ type: 'output-compose' })}
        >
          Docker Compose
        </div>
        <div
          className={`sidebar-item ${isActive(selected, { type: 'output-k8s' }) ? 'active' : ''}`}
          onClick={() => onSelect({ type: 'output-k8s' })}
        >
          Kubernetes
        </div>
      </div>
    </div>
  );
}
