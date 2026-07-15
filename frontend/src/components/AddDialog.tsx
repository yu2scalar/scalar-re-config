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

interface Props {
  title: string;
  label: string;
  placeholder: string;
  onAdd: (name: string) => void;
  onCancel: () => void;
  existingNames: string[];
}

export default function AddDialog({ title, label, placeholder, onAdd, onCancel, existingNames }: Props) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  function handleAdd() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(trimmed)) {
      setError('Must be lowercase letters, digits, and underscores');
      return;
    }
    if (existingNames.includes(trimmed)) {
      setError('Name already exists');
      return;
    }
    onAdd(trimmed);
  }

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        <div className="form-group">
          <label className="form-label">{label}</label>
          <input
            className={`form-input ${error ? 'error' : ''}`}
            placeholder={placeholder}
            value={name}
            onChange={(e) => { setName(e.target.value); setError(''); }}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            autoFocus
          />
          {error && <span style={{ color: 'var(--danger)', fontSize: 11 }}>{error}</span>}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={handleAdd}>Add</button>
        </div>
      </div>
    </div>
  );
}
