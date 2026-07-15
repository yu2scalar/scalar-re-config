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

import type { UnifiedConfig, StorageConfig } from '../types';
import * as yaml from 'yaml';

/**
 * Build an ordered config object for YAML output.
 */
export function orderedConfig(config: UnifiedConfig): Record<string, unknown> {
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

/**
 * Convert config to ordered YAML string.
 */
export function configToYaml(config: UnifiedConfig): string {
  const doc = new yaml.Document(orderedConfig(config));
  return doc.toString({ indent: 2 });
}

/**
 * Rewrite env placeholder defaults for container environments.
 * e.g. ${VAR:old_default} → ${VAR:new_default}
 *
 * For Docker Compose and K8s, DB hosts become container service names.
 */
export function rewriteEnvDefaults(
  yamlStr: string,
  storages: Record<string, StorageConfig>,
): string {
  let result = yamlStr;

  for (const [name, st] of Object.entries(storages)) {
    if (st.type === 'jdbc') {
      // Rewrite host default to service name (storage name)
      // mysql → mysql, postgres → postgres
      const serviceName = st.driver === 'postgresql' ? 'postgres' : name;
      if (st.host) {
        const hostDefault = extractDefault(st.host);
        if (hostDefault && hostDefault !== serviceName) {
          result = result.replace(st.host, replaceDefault(st.host, serviceName));
        }
      }
    } else if (st.type === 'dynamo') {
      // Rewrite endpoint-override default
      const endpoint = st.options?.['endpoint-override'];
      if (endpoint) {
        const newEndpoint = `http://dynamodb:8000`;
        const currentDefault = extractDefault(endpoint);
        if (currentDefault && currentDefault !== newEndpoint) {
          result = result.replace(endpoint, replaceDefault(endpoint, newEndpoint));
        }
      }
    }
  }

  return result;
}

/**
 * Extract the default value from ${VAR:default} placeholder.
 * Returns the raw string if it's not a placeholder.
 */
function extractDefault(value: string): string {
  const match = value.match(/^\$\{[^:}]+:(.+)\}$/);
  return match ? match[1] : value;
}

/**
 * Replace the default value in ${VAR:default} placeholder.
 * If the value is not a placeholder, returns it unchanged.
 */
function replaceDefault(value: string, newDefault: string): string {
  const match = value.match(/^(\$\{[^:}]+:).+(\})$/);
  return match ? `${match[1]}${newDefault}${match[2]}` : value;
}

/**
 * Extract env var name → default value pairs from config for .env / Secret generation.
 * Parses ${VAR_NAME:default} placeholders from all relevant fields.
 */
export function extractEnvVars(config: UnifiedConfig): Record<string, string> {
  const vars: Record<string, string> = {};

  // Auth
  addPlaceholder(vars, config.global?.auth?.['api-key']);

  // Storages — scan all fields that may contain ${VAR:default} placeholders
  for (const [, st] of Object.entries(config.storages)) {
    if (st.type === 'jdbc') {
      addPlaceholder(vars, st.host);
      addPlaceholder(vars, st.port?.toString());
      addPlaceholder(vars, st.database);
      addPlaceholder(vars, st.username);
      addPlaceholder(vars, st.password);
    } else if (st.type === 'dynamo') {
      addPlaceholder(vars, st.region);
      addPlaceholder(vars, st['access-key-id']);
      addPlaceholder(vars, st['secret-access-key']);
      addPlaceholder(vars, st.options?.['endpoint-override']);
    }
  }

  // HMAC keys
  for (const [, ns] of Object.entries(config.namespaces)) {
    addPlaceholder(vars, ns.hmac?.key);
    addPlaceholder(vars, ns.hmac?.['key-previous']);
  }

  return vars;
}

/**
 * Parse a ${VAR_NAME:default} placeholder and add to the vars map.
 */
function addPlaceholder(vars: Record<string, string>, value: string | undefined) {
  if (!value) return;
  const match = value.match(/^\$\{([^:}]+):?(.*)\}$/);
  if (match) {
    vars[match[1]] = match[2] || '';
  }
}

/**
 * Get list of storage names that use a specific DB type.
 */
export function getStoragesByDriver(
  config: UnifiedConfig,
  driver: string,
): string[] {
  return Object.entries(config.storages)
    .filter(([, st]) => st.type === 'jdbc' && st.driver === driver)
    .map(([name]) => name);
}

export function hasMysql(config: UnifiedConfig): boolean {
  return getStoragesByDriver(config, 'mysql').length > 0;
}

export function hasPostgres(config: UnifiedConfig): boolean {
  return getStoragesByDriver(config, 'postgresql').length > 0;
}

export function hasDynamo(config: UnifiedConfig): boolean {
  return Object.values(config.storages).some((st) => st.type === 'dynamo');
}
