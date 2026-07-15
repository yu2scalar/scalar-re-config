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

// Throwaway: generate the CURRENT-version scalar-re-config.yml straight from
// the live defaults + helpers (defaults.ts) and the live serializer
// (generators/common.ts configToYaml). Unlike verify-compose-output.ts, the
// input is NOT a hand-written/stale config — it is built from defaultConfig +
// newStorage()/newNamespace() so the emitted keys reflect exactly what the
// shipping tool produces today. Covers all 3 storage types and all 6
// delivery-types so a key-completeness audit misses nothing.
//   cd frontend && npx tsx gen-current-config.ts
import { writeFileSync } from 'node:fs';
import { defaultConfig, newStorage, newNamespace } from './src/defaults';
import { configToYaml } from './src/generators/common';
import type { UnifiedConfig, EventTypeConfig } from './src/types';

const cfg: UnifiedConfig = structuredClone(defaultConfig);

cfg.scalardb['default-storage'] = 'mysql';

cfg.storages = {
  mysql: newStorage('mysql', 'jdbc', 'mysql'),
  postgres: newStorage('postgres', 'jdbc', 'postgresql'),
  dynamo: newStorage('dynamo', 'dynamo'),
};

const et = (
  deliveryType: EventTypeConfig['delivery-type'],
  extra: Partial<EventTypeConfig> = {},
): EventTypeConfig => ({ enabled: true, 'delivery-type': deliveryType, ...extra });

// scalarre = management namespace, no event-types
cfg.namespaces = {
  scalarre: { ...newNamespace('mysql', 'scalarre'), 'event-types': {} },
  ns_mysql: {
    ...newNamespace('mysql', 'ns_mysql'),
    'event-types': {
      MysqlAtomic: et('atomic'),
      MysqlPartial: et('partial'),
      MysqlRelay: et('relay'),
      MysqlPull: et('pull', { destination: 'ns_postgres' }),
      MysqlQpull: et('qpull', { 'partition-count': 2 }),
      MysqlSpull: et('spull', { 'partition-count': 2 }),
      MysqlOrderedAtomic: et('ordered_atomic', { 'partition-count': 2 }),
    },
  },
  ns_postgres: {
    ...newNamespace('postgres', 'ns_postgres'),
    'event-types': {
      PostgresAtomic: et('atomic'),
      PostgresPull: et('pull', { destination: 'ns_mysql' }),
    },
  },
  ns_dynamo: {
    ...newNamespace('dynamo', 'ns_dynamo'),
    'event-types': {
      DynamoAtomic: et('atomic'),
      DynamoPull: et('pull', { destination: 'ns_mysql' }),
    },
  },
};

const yaml = configToYaml(cfg);
writeFileSync('current-scalar-re-config.yml', yaml);
console.log(yaml);
console.error(`\n[written] frontend/current-scalar-re-config.yml (${yaml.length} bytes)`);
