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

import { useState, useEffect } from 'react';
import type { UnifiedConfig } from '../types';
import { preview } from '../api';
import * as yaml from 'yaml';

interface Props {
  config: UnifiedConfig;
}

type Tab = 'unified' | 'scalardb';

function orderedConfig(config: UnifiedConfig): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  const keyOrder = ['schema-version', 'global', 'scalardb', 'storages', 'namespaces'];
  for (const key of keyOrder) {
    if (key in config) {
      ordered[key] = config[key as keyof UnifiedConfig];
    }
  }
  for (const key of Object.keys(config)) {
    if (!keyOrder.includes(key)) {
      ordered[key] = config[key as keyof UnifiedConfig];
    }
  }
  return ordered;
}

export function buildOrderedYaml(config: UnifiedConfig): string {
  const doc = new yaml.Document(orderedConfig(config));
  return doc.toString({ indent: 2 });
}

export default function OutputBase({ config }: Props) {
  const [tab, setTab] = useState<Tab>('unified');
  const [scalardbProps, setScalardbProps] = useState('');

  useEffect(() => {
    if (tab === 'scalardb') {
      preview(config).then((res) => {
        setScalardbProps(res.scalardb_properties);
      }).catch((err) => {
        setScalardbProps(`Error: ${err.message}`);
      });
    }
  }, [tab, config]);

  const unifiedYaml = buildOrderedYaml(config);

  function handleSave() {
    const blob = new Blob([unifiedYaml], { type: 'application/x-yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scalar-re-config.yml';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Base Output</div>
        <button className="btn btn-primary" onClick={handleSave}>Save YAML</button>
      </div>

      <div className="preview-tabs">
        <div
          className={`preview-tab ${tab === 'unified' ? 'active' : ''}`}
          onClick={() => setTab('unified')}
        >
          scalar-re-config.yml
        </div>
        <div
          className={`preview-tab ${tab === 'scalardb' ? 'active' : ''}`}
          onClick={() => setTab('scalardb')}
        >
          ScalarDB Properties
        </div>
      </div>

      <div className="preview-content">
        {tab === 'unified' ? unifiedYaml : scalardbProps}
      </div>

      {tab === 'scalardb' && (
        <div className="preview-note">
          This is a read-only preview of what RE generates internally. You do NOT need to create this file.
        </div>
      )}
    </div>
  );
}
