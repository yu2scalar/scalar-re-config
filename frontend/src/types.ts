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

export interface StorageConfig {
  type: 'jdbc' | 'dynamo' | 'cosmos';
  // JDBC fields
  driver?: 'mysql' | 'postgresql' | 'oracle' | 'sqlserver';
  host?: string;
  port?: number | string;
  database?: string;
  username?: string;
  password?: string;
  // DynamoDB fields
  region?: string;
  'access-key-id'?: string;
  'secret-access-key'?: string;
  // Legacy (kept for import compatibility)
  'contact-points'?: string;
  options?: {
    'connection-pool-max-total'?: number;
    'metadata-cache-expiration-secs'?: number;
    'endpoint-override'?: string;
    'namespace-prefix'?: string;
    // Connection parameters appended to the JDBC URL (e.g. sslMode=REQUIRED).
    'connection-params'?: string;
  };
}

export interface EventTypeConfig {
  enabled?: boolean;
  'delivery-type': 'atomic' | 'partial' | 'relay' | 'pull' | 'qpull' | 'spull' | 'ordered_atomic';
  destination?: string;
  'partition-count'?: number;
}

export interface NamespaceConfig {
  storage: string;
  destination?: {
    'worker-threads'?: number;
    'queue-capacity'?: number;
    'throughput-tps'?: number;
  };
  polling?: {
    'outbox-poll-interval-ms'?: number;
    'outbox-poll-delay-ms'?: number;
    'outbox-batch-size'?: number;
    // inbox-poll-interval-ms / inbox-batch-size removed in v2.8;
    // the replacement knobs live at scalar-re.recovery.inbox-recovery-*.
  };
  'completed-enabled'?: boolean;
  hmac?: {
    key?: string;
    'key-previous'?: string;
    'key-previous-expires-at'?: number;
  };
  'event-types'?: Record<string, EventTypeConfig>;
}

export interface ReTableConfig {
  storage?: string;
  namespace?: string;
}

export interface GlobalConfig {
  // management-namespace / management-storage / offload-completed-table removed:
  // not bound by the current product (the offload feature was dropped; the others
  // were never read). re-tables (snake_case keys) carries the scalarre placement.
  're-tables'?: Record<string, ReTableConfig>;
  // Completed-record TTL (seconds, 0 = disabled). Read by core as
  // scalar-re.completed-ttl-seconds (ScalarReProperties).
  'completed-ttl-seconds'?: number;
  subscription?: {
    'cache-refresh-interval-ms'?: number;
  };
  auth?: {
    'api-key'?: string;
  };
  retry?: {
    'max-attempts'?: number;
    'initial-delay-ms'?: number;
    'max-delay-ms'?: number;
    multiplier?: number;
  };
  'internal-queue'?: {
    'worker-threads'?: number;
    'queue-capacity'?: number;
  };
  cluster?: {
    'cluster-id'?: string;
    'heartbeat-interval-ms'?: number;
    'heartbeat-expiry-ms'?: number;
    'cleanup-retention-ms'?: number;
  };
  license?: {
    'max-nodes'?: number;
    'expires-at'?: string;
  };
  server?: {
    'tomcat-max-threads'?: number;
  };
  polling?: {
    'dedup-enabled'?: boolean;
    'dedup-peer-timeout-ms'?: number;
    // Adaptive poll backoff on futile cycles (core PollingProperties, plan §1.33)
    'backoff-enabled'?: boolean;
    'backoff-max-interval-ms'?: number;
  };
  /**
   * Replay channel settings. Defaults: enabled=true, worker-threads=2, queue-capacity=100000.
   */
  replay?: {
    enabled?: boolean;
    'worker-threads'?: number;
    'queue-capacity'?: number;
  };
  /**
   * Recovery settings. core's UnifiedConfigLoader maps ALL recovery.* keys from the
   * unified YAML → scalar-re.recovery.* props (read by InboxRecoveryScanner /
   * RelayAckTimeoutScanner), so every key below is settable from the tool.
   * (Was previously documented as "only prepared-age-threshold-ms is mapped, others @Value-only" —
   * that predated the loader wiring and was wrong.)
   */
  recovery?: {
    'prepared-age-threshold-ms'?: number;
    'inbox-recovery-enabled'?: boolean;
    'inbox-recovery-interval-ms'?: number;
    'inbox-recovery-batch-size'?: number;
    'relay-ack-timeout-enabled'?: boolean;
    'relay-ack-timeout-interval-ms'?: number;
    'relay-ack-timeout-batch-size'?: number;
  };
}

export interface ScalarDbConfig {
  'transaction-manager'?: string;
  'isolation-level'?: string;
  'default-storage'?: string;
}

export interface UnifiedConfig {
  'schema-version': string;
  global?: GlobalConfig;
  storages: Record<string, StorageConfig>;
  scalardb?: ScalarDbConfig;
  namespaces: Record<string, NamespaceConfig>;
}

export interface ValidationError {
  level: string;
  path: string;
  message: string;
}

export type SidebarSection =
  | { type: 'global' }
  | { type: 'storage'; name: string }
  | { type: 'namespace'; name: string }
  | { type: 'output-base' }
  | { type: 'output-compose' }
  | { type: 'output-k8s' };
