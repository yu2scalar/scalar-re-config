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

// Throwaway verification script. Invokes the compose generator end-to-end
// with a representative unified config (four namespaces across mysql /
// postgres / dynamo) and dumps every emitted file to ./verify-output/. Run
// with:
//   cd frontend && npx tsx verify-compose-output.ts
// Safe to delete once the plan is committed; not part of the build.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateComposeFiles, defaultComposeOptions } from './src/generators/compose';
import { generateK8sFiles, defaultK8sOptions } from './src/generators/k8s';
import type { UnifiedConfig } from './src/types';

const config: UnifiedConfig = {
  'schema-version': '1.0',
  global: {
    'management-namespace': 'scalarre',
    'management-storage': '',
    'offload-completed-table': true,
    subscription: { 'cache-refresh-interval-ms': 60000 },
    auth: { 'api-key': '${SCALAR_RE_API_KEY:change-me}' },
    retry: { 'max-attempts': 3, 'initial-delay-ms': 100, 'max-delay-ms': 5000, multiplier: 2 },
    'internal-queue': { 'worker-threads': 10, 'queue-capacity': 10000 },
    cluster: {
      'cluster-id': 'default',
      'heartbeat-interval-ms': 30000,
      'heartbeat-expiry-ms': 60000,
      'cleanup-retention-ms': 86400000,
    },
    license: { 'max-nodes': 3, 'expires-at': '2027-12-31' },
    server: { 'tomcat-max-threads': 200 },
    replay: { enabled: true, 'worker-threads': 2, 'queue-capacity': 100000 },
    're-tables': {
      're_node_heartbeat': { namespace: 'scalarre' },
      're_completed': { namespace: 'scalarre' },
      're_queue': { namespace: 'scalarre' },
      're_subscription': { namespace: 'scalarre' },
    },
  },
  scalardb: {
    'transaction-manager': 'consensus-commit',
    'isolation-level': 'READ_COMMITTED',
    'default-storage': 'postgres',
  },
  storages: {
    mysql: {
      type: 'jdbc',
      driver: 'mysql',
      host: '${SCALAR_RE_DB_MYSQL_HOST:mysql}',
      port: '${SCALAR_RE_DB_MYSQL_PORT:3306}' as unknown as number,
      username: '${SCALAR_RE_DB_MYSQL_USERNAME:scalaradmin}',
      password: '${SCALAR_RE_DB_MYSQL_PASSWORD:scalaradmin}',
    },
    postgres: {
      type: 'jdbc',
      driver: 'postgresql',
      host: '${SCALAR_RE_DB_POSTGRES_HOST:postgres}',
      port: '${SCALAR_RE_DB_POSTGRES_PORT:5432}' as unknown as number,
      database: '${SCALAR_RE_DB_POSTGRES_DATABASE:db_postgres}',
      username: '${SCALAR_RE_DB_POSTGRES_USERNAME:scalaradmin}',
      password: '${SCALAR_RE_DB_POSTGRES_PASSWORD:scalaradmin}',
    },
    dynamo: {
      type: 'dynamo',
      region: '${SCALAR_RE_DB_DYNAMO_REGION:fakeRegion}',
      'access-key-id': '${SCALAR_RE_DB_DYNAMO_ACCESS_KEY:fakeAccessKey}',
      'secret-access-key': '${SCALAR_RE_DB_DYNAMO_SECRET_KEY:fakeSecretKey}',
      options: {
        'namespace-prefix': 'scalardb_',
        'endpoint-override': '${SCALAR_RE_DB_DYNAMO_ENDPOINT:http://dynamodb:8000}',
      },
    },
  },
  namespaces: {
    scalarre: {
      storage: 'postgres',
      destination: { 'worker-threads': 30, 'queue-capacity': 100000, 'throughput-tps': 2000 },
      hmac: { key: '${SCALAR_RE_HMAC_KEY_SCALARRE:demo-hmac-key}', 'key-previous': '', 'key-previous-expires-at': 0 },
      'event-types': {},
    },
    ns_mysql: {
      storage: 'mysql',
      destination: { 'worker-threads': 30, 'queue-capacity': 100000, 'throughput-tps': 2000 },
      hmac: { key: '${SCALAR_RE_HMAC_KEY_NS_MYSQL:demo-hmac-key}', 'key-previous': '', 'key-previous-expires-at': 0 },
      'event-types': {},
    },
    ns_postgres: {
      storage: 'postgres',
      destination: { 'worker-threads': 30, 'queue-capacity': 100000, 'throughput-tps': 2000 },
      hmac: { key: '${SCALAR_RE_HMAC_KEY_NS_POSTGRES:demo-hmac-key}', 'key-previous': '', 'key-previous-expires-at': 0 },
      'event-types': {},
    },
    ns_dynamo: {
      storage: 'dynamo',
      destination: { 'worker-threads': 30, 'queue-capacity': 100000, 'throughput-tps': 2000 },
      hmac: { key: '${SCALAR_RE_HMAC_KEY_NS_DYNAMO:demo-hmac-key}', 'key-previous': '', 'key-previous-expires-at': 0 },
      'event-types': {},
    },
  },
};

const outDir = join(process.cwd(), 'verify-output');
const composeEntries = generateComposeFiles(config, {
  ...defaultComposeOptions,
  dynamoPersistent: true, // Match user's current config/docker-compose.yml setting
});
const k8sEntries = generateK8sFiles(config, defaultK8sOptions);

console.log(`Compose: ${composeEntries.length} file(s)`);
for (const entry of composeEntries) {
  const path = join(outDir, 'compose', entry.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entry.content);
  console.log(`  compose/${entry.path}  (${entry.content.length} bytes)`);
}

console.log(`K8s: ${k8sEntries.length} file(s)`);
for (const entry of k8sEntries) {
  const path = join(outDir, 'k8s', entry.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entry.content);
  console.log(`  k8s/${entry.path}  (${entry.content.length} bytes)`);
}
console.log(`Done. Inspect ./verify-output/`);
