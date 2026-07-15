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

import type { UnifiedConfig, ValidationError } from './types';

const BASE = '/api';

export interface MetaInfo {
  /** ADMIN_PASSWORD set at startup (HTTP Basic enabled). */
  authEnabled: boolean;
  /** destructive DB ops (recreate) allowed — gated by admin auth. */
  destructiveOpsAllowed: boolean;
}

/** Server capabilities. No-auth endpoint; used to gate the Recreate UI. */
export async function getMeta(): Promise<MetaInfo> {
  const res = await fetch(`${BASE}/meta`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function validate(config: UnifiedConfig): Promise<{
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}> {
  const res = await fetch(`${BASE}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return res.json();
}

export async function preview(config: UnifiedConfig): Promise<{
  scalardb_properties: string;
}> {
  const res = await fetch(`${BASE}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return res.json();
}

export async function saveConfig(path: string, config: UnifiedConfig): Promise<{ status: string; path: string }> {
  const res = await fetch(`${BASE}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, config }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function loadConfig(path: string): Promise<UnifiedConfig> {
  const res = await fetch(`${BASE}/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function importLegacy(
  scalardbPath: string,
  appYmlPath: string
): Promise<UnifiedConfig> {
  const res = await fetch(`${BASE}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scalardb_properties_path: scalardbPath,
      application_yml_path: appYmlPath,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --- DB ops (deploy/admin: acts on the real DB) ---

export interface DbError {
  type: string;
  message: string;
}
export interface StorageVerifyResult {
  storage: string;
  reachable: boolean;
  namespaces: string[];
  /** resolved connection target (what was actually tried / makes env override visible) */
  target?: string;
  elapsedMs: number;
  error?: DbError;
}
export interface NamespaceStatusResult {
  namespace: string;
  ok: boolean;
  namespaceExists: boolean;
  healthy: boolean;
  tables: { table: string; exists: boolean }[];
  target?: string;
  elapsedMs: number;
  error?: DbError;
}
export interface NamespaceOpResult {
  namespace: string;
  ok: boolean;
  mode: string;
  created: string[];
  skipped: string[];
  dropped: string[];
  indexes: string[];
  target?: string;
  elapsedMs: number;
  error?: DbError;
}

async function postConfig<T>(path: string, config: UnifiedConfig): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return res.json();
}

/** Connectivity check for a single storage (non-destructive). */
export function dbStorageVerify(name: string, config: UnifiedConfig): Promise<StorageVerifyResult> {
  return postConfig(`/db/storages/${encodeURIComponent(name)}/verify`, config);
}

/** Namespace status check (existence of the namespace + expected RE tables, non-destructive). */
export function dbNamespaceStatus(name: string, config: UnifiedConfig): Promise<NamespaceStatusResult> {
  return postConfig(`/db/namespaces/${encodeURIComponent(name)}/status`, config);
}

/** Create a namespace (idempotent). */
export function dbNamespaceCreate(name: string, config: UnifiedConfig): Promise<NamespaceOpResult> {
  return postConfig(`/db/namespaces/${encodeURIComponent(name)}/create`, config);
}

/** Recreate a namespace (destructive; requires confirm=true). */
export function dbNamespaceRecreate(name: string, config: UnifiedConfig): Promise<NamespaceOpResult> {
  return postConfig(`/db/namespaces/${encodeURIComponent(name)}/recreate?confirm=true`, config);
}
