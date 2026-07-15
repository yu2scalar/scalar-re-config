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

import type { UnifiedConfig, StorageConfig, NamespaceConfig } from './types';

// --- Env var placeholder helpers ---

function envVar(storageName: string, field: string): string {
  return `SCALAR_RE_DB_${storageName.toUpperCase()}_${field.toUpperCase()}`;
}

function envPlaceholder(storageName: string, field: string, defaultValue: string): string {
  return `\${${envVar(storageName, field)}:${defaultValue}}`;
}

function hmacEnvVar(namespaceName: string): string {
  return `SCALAR_RE_HMAC_KEY_${namespaceName.toUpperCase()}`;
}

function hmacPlaceholder(namespaceName: string): string {
  // Distinct fallback per namespace: HMAC keys MUST differ per namespace (a shared
  // key masks destination-key resolution and weakens namespace isolation).
  return `\${${hmacEnvVar(namespaceName)}:demo-hmac-key-${namespaceName.toLowerCase()}}`;
}

function hmacPrevPlaceholder(namespaceName: string): string {
  return `\${${hmacEnvVar(namespaceName)}_PREV:}`;
}

// --- Default config ---

export const defaultConfig: UnifiedConfig = {
  'schema-version': '1.0',
  global: {
    // re-tables: management tables live in the scalarre namespace. Inner keys are
    // snake_case (= physical table names / ReTableNames); parent stays kebab for
    // Spring relaxed binding.
    're-tables': {
      re_node_heartbeat: { namespace: 'scalarre' },
      re_completed: { namespace: 'scalarre' },
      re_queue: { namespace: 'scalarre' },
      re_subscription: { namespace: 'scalarre' },
    },
    // Completed-record TTL. Default 7 days (604800s). 0 = disabled.
    'completed-ttl-seconds': 604800,
    subscription: {
      'cache-refresh-interval-ms': 60000,
    },
    auth: { 'api-key': '${SCALAR_RE_API_KEY:change-me}' },
    retry: {
      'max-attempts': 3,
      'initial-delay-ms': 100,
      'max-delay-ms': 5000,
      multiplier: 2.0,
    },
    'internal-queue': {
      'worker-threads': 10,
      'queue-capacity': 10000,
    },
    cluster: {
      'cluster-id': 'default',
      'heartbeat-interval-ms': 30000,
      'heartbeat-expiry-ms': 60000,
      'cleanup-retention-ms': 86400000,
    },
    license: {
      'max-nodes': 3,
      'expires-at': '2027-12-31',
    },
    server: {
      'tomcat-max-threads': 200,
    },
    polling: {
      'dedup-enabled': true,
      'dedup-peer-timeout-ms': 3000,
      'backoff-enabled': true,
      'backoff-max-interval-ms': 30000,
    },
    replay: {
      enabled: true,
      'worker-threads': 2,
      'queue-capacity': 100000,
    },
    // Recovery: all recovery.* keys are wired YAML→scalar-re.recovery.* on the core
    // side (UnifiedConfigLoader), read by InboxRecoveryScanner /
    // RelayAckTimeoutScanner. Defaults mirror the core @Value defaults.
    recovery: {
      'prepared-age-threshold-ms': 15000,
      'inbox-recovery-enabled': true,
      'inbox-recovery-interval-ms': 15000,
      'inbox-recovery-batch-size': 100,
      'relay-ack-timeout-enabled': true,
      'relay-ack-timeout-interval-ms': 60000,
      'relay-ack-timeout-batch-size': 100,
    },
  },
  storages: {},
  scalardb: {
    'transaction-manager': 'consensus-commit',
    'isolation-level': 'READ_COMMITTED',
    'default-storage': '',
  },
  namespaces: {},
};

const defaultPorts: Record<string, number> = {
  mysql: 3306,
  postgresql: 5432,
  oracle: 1521,
  sqlserver: 1433,
};

export function getDefaultPort(driver: string): number {
  return defaultPorts[driver] || 3306;
}

/**
 * Create a new storage with env var placeholders based on the storage name.
 */
export function newStorage(
  name: string,
  type: StorageConfig['type'] = 'jdbc',
  driver?: StorageConfig['driver'],
): StorageConfig {
  if (type === 'dynamo') {
    return {
      type: 'dynamo',
      region: envPlaceholder(name, 'REGION', 'fakeRegion'),
      'access-key-id': envPlaceholder(name, 'ACCESS_KEY', 'fakeAccessKey'),
      'secret-access-key': envPlaceholder(name, 'SECRET_KEY', 'fakeSecretKey'),
      options: {
        'namespace-prefix': 'scalarre_',
        'endpoint-override': envPlaceholder(name, 'ENDPOINT', 'http://dynamodb:8000'),
      },
    };
  }
  const d = driver || 'mysql';
  const port = getDefaultPort(d);
  return {
    type: 'jdbc',
    driver: d,
    host: envPlaceholder(name, 'HOST', 'localhost'),
    port: envPlaceholder(name, 'PORT', String(port)),
    database: d === 'postgresql' ? envPlaceholder(name, 'DATABASE', `db_${name}`) : undefined,
    username: envPlaceholder(name, 'USERNAME', 'scalaradmin'),
    password: envPlaceholder(name, 'PASSWORD', 'scalaradmin'),
    options: {
      'connection-pool-max-total': 200,
      'metadata-cache-expiration-secs': 60,
    },
  };
}

/**
 * Create a new namespace with HMAC key placeholder based on the namespace name.
 */
export function newNamespace(storage: string, name: string): NamespaceConfig {
  return {
    storage,
    destination: {
      'worker-threads': 30,
      'queue-capacity': 100000,
      'throughput-tps': 2000,
    },
    polling: {
      'outbox-poll-interval-ms': 5000,
      'outbox-poll-delay-ms': 5000,
      'outbox-batch-size': 100,
      // inbox-poll-interval-ms / inbox-batch-size removed in v2.8.
    },
    'completed-enabled': true,
    hmac: {
      key: hmacPlaceholder(name),
      'key-previous': hmacPrevPlaceholder(name),
      'key-previous-expires-at': 0,
    },
    'event-types': {},
  };
}

/**
 * Update env var names in a storage config when the storage is renamed.
 * Preserves the default values, only changes the variable name part.
 */
export function updateStorageEnvVars(
  storage: StorageConfig,
  oldName: string,
  newName: string,
): StorageConfig {
  const oldPrefix = `SCALAR_RE_DB_${oldName.toUpperCase()}_`;
  const newPrefix = `SCALAR_RE_DB_${newName.toUpperCase()}_`;

  function rewrite(value: string | undefined): string | undefined {
    if (!value) return value;
    return value.replace(oldPrefix, newPrefix);
  }

  function rewriteNumOrStr(value: number | string | undefined): number | string | undefined {
    if (typeof value === 'string') return value.replace(oldPrefix, newPrefix);
    return value;
  }

  const updated = { ...storage };
  if (storage.type === 'jdbc') {
    updated.host = rewrite(storage.host);
    updated.port = rewriteNumOrStr(storage.port);
    updated.username = rewrite(storage.username);
    updated.password = rewrite(storage.password);
    if (storage.database !== undefined) {
      updated.database = rewrite(storage.database);
    }
  } else if (storage.type === 'dynamo') {
    updated.region = rewrite(storage.region);
    updated['access-key-id'] = rewrite(storage['access-key-id']);
    updated['secret-access-key'] = rewrite(storage['secret-access-key']);
    if (storage.options) {
      updated.options = { ...storage.options };
      if (storage.options['endpoint-override']) {
        updated.options['endpoint-override'] = rewrite(storage.options['endpoint-override']);
      }
    }
  }

  return updated;
}

/**
 * Update env var name in a namespace's HMAC config when the namespace is renamed.
 */
export function updateNamespaceHmacEnvVars(
  ns: NamespaceConfig,
  oldName: string,
  newName: string,
): NamespaceConfig {
  if (!ns.hmac) return ns;
  const oldKey = `SCALAR_RE_HMAC_KEY_${oldName.toUpperCase()}`;
  const newKey = `SCALAR_RE_HMAC_KEY_${newName.toUpperCase()}`;

  function rewrite(value: string | undefined): string | undefined {
    if (!value) return value;
    return value.replace(oldKey, newKey);
  }

  return {
    ...ns,
    hmac: {
      ...ns.hmac,
      key: rewrite(ns.hmac.key),
      'key-previous': rewrite(ns.hmac['key-previous']),
    },
  };
}
