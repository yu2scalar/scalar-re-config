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

import type { UnifiedConfig } from '../types';
import { configToYaml, rewriteEnvDefaults, extractEnvVars, hasMysql, hasPostgres, hasDynamo } from './common';
import type { ZipEntry } from './zip';
import { reDashboard } from './dashboards/re-dashboard';

export interface ComposeOptions {
  nodeCount: number;
  lbHostPort: number;
  dbMode: 'internal' | 'external';
  mysqlPersistent: boolean;
  postgresPersistent: boolean;
  dynamoPersistent: boolean;
}

export const defaultComposeOptions: ComposeOptions = {
  nodeCount: 3,
  lbHostPort: 8080,
  dbMode: 'internal',
  mysqlPersistent: true,
  postgresPersistent: true,
  dynamoPersistent: false,
};

/**
 * Generate all Docker Compose files.
 */
export function generateComposeFiles(config: UnifiedConfig, options: ComposeOptions): ZipEntry[] {
  const entries: ZipEntry[] = [];

  entries.push({ path: 'docker-compose.yml', content: generateDockerCompose(config, options) });
  entries.push({ path: '.env', content: generateDotEnv(config, options) });
  entries.push({ path: 'nginx.conf', content: generateNginxConf(options) });
  entries.push({ path: 'scalar-re-config.yml', content: generateDockerConfig(config) });

  if (hasMysql(config)) {
    entries.push({ path: 'init-data/mysql-init.sql', content: generateMysqlInit() });
  }
  if (hasPostgres(config)) {
    entries.push({ path: 'init-data/postgres-init.sql', content: generatePostgresInit(config) });
  }

  entries.push({ path: 'prometheus.yml', content: generatePrometheusYml(options) });
  entries.push({ path: 'loki-config.yml', content: generateLokiConfig() });
  entries.push({ path: 'promtail-config.yml', content: generatePromtailConfig() });
  entries.push({
    path: 'grafana-provisioning/datasources/datasources.yml',
    content: generateGrafanaDatasources(),
  });
  entries.push({
    path: 'grafana-provisioning/dashboards/dashboards.yml',
    content: generateGrafanaDashboardProvider(),
  });
  entries.push({
    path: 'grafana-provisioning/dashboards/re-dashboard.json',
    content: generateGrafanaReDashboard(),
  });

  return entries;
}

function generateDockerCompose(config: UnifiedConfig, options: ComposeOptions): string {
  const lines: string[] = [];
  lines.push('services:');

  // --- Load Balancer ---
  lines.push('  # --- Load Balancer ---');
  lines.push('  nginx:');
  lines.push('    image: nginx:alpine');
  lines.push('    profiles: ["app"]');
  lines.push('    ports:');
  lines.push(`      - "\${SCALAR_RE_LB_HOST_PORT:-${options.lbHostPort}}:80"`);
  lines.push('    volumes:');
  lines.push('      - ./nginx.conf:/etc/nginx/nginx.conf:ro');
  lines.push('    depends_on:');
  for (let i = 1; i <= options.nodeCount; i++) {
    lines.push(`      re-${i}:`);
    lines.push('        condition: service_healthy');
  }
  lines.push('    restart: on-failure');

  // --- Schema initialization ---
  lines.push('');
  lines.push('  # --- Schema initialization (one-shot) ---');
  lines.push('  scalar-re-init:');
  lines.push('    image: scalar-re-init:latest');
  lines.push('    profiles: ["app"]');
  lines.push('    volumes:');
  lines.push('      - ./scalar-re-config.yml:/app/scalar-re-config.yml:ro');
  lines.push('    env_file: .env');
  if (hasDbDependency(config)) {
    lines.push('    depends_on:');
    appendDbDependsOn(lines, config, '      ');
  }
  lines.push('    restart: on-failure');

  // --- RE Nodes ---
  for (let i = 1; i <= options.nodeCount; i++) {
    lines.push('');
    lines.push(`  # --- ScalarRE Node ${i} ---`);
    lines.push(`  re-${i}:`);
    lines.push('    image: scalar-re:latest');
    lines.push('    profiles: ["app"]');
    const hostPort = 8180 + i;
    lines.push('    ports:');
    lines.push(`      - "${hostPort}:8080"`);
    lines.push('    volumes:');
    lines.push('      - ./scalar-re-config.yml:/app/scalar-re-config.yml:ro');
    lines.push('    env_file: .env');
    lines.push('    depends_on:');
    lines.push('      scalar-re-init:');
    lines.push('        condition: service_completed_successfully');
    appendDbDependsOn(lines, config, '      ');
    lines.push('    healthcheck:');
    lines.push('      test: ["CMD-SHELL", "curl -sf http://localhost:8080/actuator/health || exit 1"]');
    lines.push('      interval: 15s');
    lines.push('      timeout: 5s');
    lines.push('      retries: 10');
    lines.push('      start_period: 60s');
    lines.push('    restart: on-failure');
  }

  // --- Databases (profile: db) ---
  if (hasMysql(config)) {
    lines.push('');
    lines.push('  # --- MySQL ---');
    lines.push('  mysql:');
    lines.push('    image: mysql:8.0');
    // Raise max_connections above the default 151. With 3 RE nodes each
    // opening a pool against mysql and postgres, the defaults exhaust
    // quickly under load and transfers roll back with "Too many
    // connections". 1000 covers a typical 3-node test workload.
    //
    // max_connect_errors defaults to 100; under a repeating-retry
    // workload (benchmark scripts restarting Producer) MySQL blocks
    // the client IP and requires a manual flush-hosts. Raising the
    // ceiling removes that failure mode.
    lines.push('    command: ["--max-connections=1000", "--max-connect-errors=100000"]');
    lines.push('    profiles: ["db"]');
    lines.push('    ports:');
    lines.push('      - "3306:3306"');
    lines.push('    environment:');
    lines.push('      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:-rootpassword}');
    lines.push('    volumes:');
    lines.push('      - ./init-data/mysql-init.sql:/docker-entrypoint-initdb.d/init.sql:ro');
    if (options.mysqlPersistent) {
      lines.push('      - mysql-data:/var/lib/mysql');
    }
    lines.push('    healthcheck:');
    lines.push('      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]');
    lines.push('      interval: 10s');
    lines.push('      timeout: 5s');
    lines.push('      retries: 10');
    lines.push('      start_period: 30s');
    lines.push('    restart: on-failure');
  }

  if (hasPostgres(config)) {
    lines.push('');
    lines.push('  # --- PostgreSQL ---');
    lines.push('  postgres:');
    lines.push('    image: postgres:15');
    // Raise max_connections above the default 100 (see mysql note above).
    lines.push('    command: ["postgres", "-c", "max_connections=1000"]');
    lines.push('    profiles: ["db"]');
    lines.push('    ports:');
    lines.push('      - "5432:5432"');
    lines.push('    environment:');
    lines.push('      POSTGRES_PASSWORD: ${POSTGRES_ROOT_PASSWORD:-rootpassword}');
    lines.push('    volumes:');
    lines.push('      - ./init-data/postgres-init.sql:/docker-entrypoint-initdb.d/init.sql:ro');
    if (options.postgresPersistent) {
      lines.push('      - postgres-data:/var/lib/postgresql/data');
    }
    lines.push('    healthcheck:');
    lines.push('      test: ["CMD-SHELL", "pg_isready -U postgres"]');
    lines.push('      interval: 10s');
    lines.push('      timeout: 5s');
    lines.push('      retries: 10');
    lines.push('      start_period: 15s');
    lines.push('    restart: on-failure');
  }

  if (hasDynamo(config)) {
    lines.push('');
    lines.push('  # --- DynamoDB Local ---');
    lines.push('  dynamodb:');
    lines.push('    image: amazon/dynamodb-local:latest');
    lines.push('    profiles: ["db"]');
    lines.push('    ports:');
    lines.push('      - "8000:8000"');
    if (options.dynamoPersistent) {
      lines.push('    user: root');
      lines.push('    command: ["-jar", "DynamoDBLocal.jar", "-sharedDb", "-dbPath", "/data"]');
      lines.push('    volumes:');
      lines.push('      - dynamodb-data:/data');
    } else {
      lines.push('    command: ["-jar", "DynamoDBLocal.jar", "-sharedDb", "-inMemory"]');
    }
    lines.push('    restart: on-failure');
  }

  // --- Monitoring (profile: monitoring) ---
  lines.push('');
  lines.push('  # --- Monitoring ---');
  lines.push('  prometheus:');
  lines.push('    image: prom/prometheus:latest');
  lines.push('    profiles: ["monitoring"]');
  lines.push('    ports:');
  lines.push('      - "9090:9090"');
  lines.push('    volumes:');
  lines.push('      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro');
  lines.push('      - prometheus-data:/prometheus');
  lines.push('    restart: on-failure');
  lines.push('');
  // Grafana version pinned to 10.4 LTS so the provisioning schema matches the
  // v1 classic JSON dashboard we ship (re-dashboard.json).
  lines.push('  grafana:');
  lines.push('    image: grafana/grafana:10.4.2');
  lines.push('    profiles: ["monitoring"]');
  lines.push('    ports:');
  lines.push('      - "3000:3000"');
  lines.push('    environment:');
  lines.push('      GF_AUTH_ANONYMOUS_ENABLED: "true"');
  lines.push('      GF_AUTH_ANONYMOUS_ORG_ROLE: "Viewer"');
  lines.push('    volumes:');
  lines.push('      - grafana-data:/var/lib/grafana');
  lines.push('      - ./grafana-provisioning:/etc/grafana/provisioning:ro');
  lines.push('    restart: on-failure');
  lines.push('');
  // Loki + Promtail — aggregate RE logs so we can grep across nodes in Grafana.
  // Promtail uses docker.sock for container discovery; test-environment only.
  lines.push('  loki:');
  lines.push('    image: grafana/loki:2.9.0');
  lines.push('    profiles: ["monitoring"]');
  lines.push('    ports:');
  lines.push('      - "3100:3100"');
  lines.push('    command: ["-config.file=/etc/loki/local-config.yaml"]');
  lines.push('    volumes:');
  lines.push('      - ./loki-config.yml:/etc/loki/local-config.yaml:ro');
  lines.push('      - loki-data:/loki');
  lines.push('    restart: on-failure');
  lines.push('');
  lines.push('  promtail:');
  lines.push('    image: grafana/promtail:2.9.0');
  lines.push('    profiles: ["monitoring"]');
  lines.push('    command: ["-config.file=/etc/promtail/config.yml"]');
  lines.push('    volumes:');
  lines.push('      - ./promtail-config.yml:/etc/promtail/config.yml:ro');
  lines.push('      - /var/run/docker.sock:/var/run/docker.sock');
  lines.push('    restart: on-failure');

  // --- Volumes ---
  const volumes: string[] = [];
  volumes.push('grafana-data');
  volumes.push('prometheus-data');
  volumes.push('loki-data');
  if (hasMysql(config) && options.mysqlPersistent) volumes.push('mysql-data');
  if (hasPostgres(config) && options.postgresPersistent) volumes.push('postgres-data');
  if (hasDynamo(config) && options.dynamoPersistent) volumes.push('dynamodb-data');

  if (volumes.length > 0) {
    lines.push('');
    lines.push('volumes:');
    for (const v of volumes) {
      lines.push(`  ${v}:`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function hasDbDependency(config: UnifiedConfig): boolean {
  return hasMysql(config) || hasPostgres(config) || hasDynamo(config);
}

function appendDbDependsOn(lines: string[], config: UnifiedConfig, indent: string) {
  if (hasMysql(config)) {
    lines.push(`${indent}mysql:`);
    lines.push(`${indent}  condition: service_healthy`);
    lines.push(`${indent}  required: false`);
  }
  if (hasPostgres(config)) {
    lines.push(`${indent}postgres:`);
    lines.push(`${indent}  condition: service_healthy`);
    lines.push(`${indent}  required: false`);
  }
  if (hasDynamo(config)) {
    lines.push(`${indent}dynamodb:`);
    lines.push(`${indent}  condition: service_started`);
    lines.push(`${indent}  required: false`);
  }
}

function generateDotEnv(config: UnifiedConfig, options: ComposeOptions): string {
  const lines: string[] = [];
  lines.push('# ScalarRE Docker Compose Environment Variables');
  lines.push('');
  // Default to the full stack. Override on the command line via
  //   docker compose --profile db up -d
  // or in the shell env before invoking compose.
  lines.push('# --- Compose profiles ---');
  lines.push('COMPOSE_PROFILES=app,db,monitoring');
  lines.push('');

  const envVars = extractEnvVars(config);

  // Group by category
  const categories: Record<string, [string, string][]> = {
    'Authentication': [],
    'MySQL': [],
    'PostgreSQL': [],
    'DynamoDB Local': [],
    'HMAC Keys': [],
    'Other': [],
  };

  for (const [key, value] of Object.entries(envVars)) {
    if (key === 'SCALAR_RE_API_KEY') {
      categories['Authentication'].push([key, value]);
    } else if (key.includes('MYSQL') && !key.includes('HMAC')) {
      categories['MySQL'].push([key, value]);
    } else if (key.includes('POSTGRES') && !key.includes('HMAC')) {
      categories['PostgreSQL'].push([key, value]);
    } else if (key.includes('DYNAMO') && !key.includes('HMAC')) {
      categories['DynamoDB Local'].push([key, value]);
    } else if (key.includes('HMAC')) {
      categories['HMAC Keys'].push([key, value]);
    } else {
      categories['Other'].push([key, value]);
    }
  }

  // Add MySQL root password if mysql storage exists
  if (hasMysql(config)) {
    categories['MySQL'].push(['MYSQL_ROOT_PASSWORD', 'rootpassword']);
  }
  if (hasPostgres(config)) {
    categories['PostgreSQL'].push(['POSTGRES_ROOT_PASSWORD', 'rootpassword']);
  }

  // JVM heap limit for containerized deployment
  categories['Other'].unshift(['JAVA_TOOL_OPTIONS', '-Xmx512m']);

  // Host-side base URL for the Producer and e2e-test / e2e-replay scripts.
  // Kept in .env so the K8s and Compose paths drive the same env contract.
  categories['Other'].unshift(['RE_BASE_URL', `http://localhost:${options.lbHostPort}`]);

  // LB host port
  if (options.lbHostPort !== 8080) {
    categories['Other'].unshift(['SCALAR_RE_LB_HOST_PORT', options.lbHostPort.toString()]);
  }

  for (const [category, vars] of Object.entries(categories)) {
    if (vars.length === 0) continue;
    lines.push(`# --- ${category} ---`);
    for (const [key, value] of vars) {
      lines.push(`${key}=${value}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function generateNginxConf(options: ComposeOptions): string {
  const upstreamLines = [];
  for (let i = 1; i <= options.nodeCount; i++) {
    upstreamLines.push(`        server re-${i}:8080 max_fails=3 fail_timeout=30s;`);
  }

  return `worker_processes auto;

events {
    worker_connections 1024;
}

http {
    log_format main '$remote_addr - [$time_local] "$request" '
                    '$status $body_bytes_sent upstream=$upstream_addr';
    access_log /dev/stdout main;

    upstream scalarre {
${upstreamLines.join('\n')}
    }

    server {
        listen 80;

        location / {
            proxy_pass http://scalarre;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_next_upstream error timeout http_502 http_503;
            proxy_connect_timeout 5s;
            proxy_read_timeout 30s;
            add_header X-Upstream $upstream_addr;
        }
    }
}
`;
}

function generateDockerConfig(config: UnifiedConfig): string {
  const baseYaml = configToYaml(config);
  return rewriteEnvDefaults(baseYaml, config.storages);
}

function generateMysqlInit(): string {
  return `-- ScalarRE MySQL initialization for Docker Compose
-- Creates the application user with required privileges.

CREATE USER IF NOT EXISTS 'scalaradmin'@'%' IDENTIFIED BY 'scalaradmin';

-- ScalarDB requires: CREATE, DROP, ALTER, SELECT, INSERT, UPDATE, DELETE
-- on all databases it manages (scalarre, ns_mysql, plus ScalarDB metadata).
GRANT CREATE, DROP, ALTER, INDEX, SELECT, INSERT, UPDATE, DELETE
  ON *.* TO 'scalaradmin'@'%';

FLUSH PRIVILEGES;
`;
}

function generatePostgresInit(config: UnifiedConfig): string {
  const lines: string[] = [];
  lines.push('-- ScalarRE PostgreSQL initialization for Docker Compose');
  lines.push('-- Creates the application user and database.');
  lines.push('');
  lines.push("CREATE USER scalaradmin WITH PASSWORD 'scalaradmin';");
  lines.push('ALTER USER scalaradmin CREATEDB;');

  // Create databases for each postgres namespace
  for (const [, st] of Object.entries(config.storages)) {
    if (st.type === 'jdbc' && st.driver === 'postgresql' && st.database) {
      // Extract actual database name from env placeholder
      const dbName = extractPlaceholderDefault(st.database);
      if (dbName) {
        lines.push('');
        lines.push(`CREATE DATABASE ${dbName} OWNER scalaradmin;`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

function generatePrometheusYml(options: ComposeOptions): string {
  const targets = [];
  for (let i = 1; i <= options.nodeCount; i++) {
    targets.push(`re-${i}:8080`);
  }

  return `global:
  scrape_interval: 5s

scrape_configs:
  - job_name: scalar-re
    metrics_path: /actuator/prometheus
    static_configs:
      - targets: [${targets.map(t => `'${t}'`).join(', ')}]
`;
}

function extractPlaceholderDefault(value: string): string {
  const match = value.match(/^\$\{[^:}]+:(.+)\}$/);
  return match ? match[1] : value;
}

function generateLokiConfig(): string {
  // Monolithic mode, filesystem backend, 24h retention. Minimal config that
  // works with Loki 2.9.x. See
  // https://grafana.com/docs/loki/latest/configure/examples/ for a richer one.
  return `auth_enabled: false

server:
  http_listen_port: 3100

common:
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    instance_addr: 127.0.0.1
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2025-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: 24h
  reject_old_samples: true
  reject_old_samples_max_age: 168h

compactor:
  working_directory: /loki/compactor
  retention_enabled: true
  delete_request_store: filesystem
`;
}

function generatePromtailConfig(): string {
  // Discover running containers via docker.sock and push their stdout/stderr
  // to Loki. Labels compose_service / container let us filter per RE node.
  return `server:
  http_listen_port: 9080

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 5s
    relabel_configs:
      - source_labels: [__meta_docker_container_name]
        regex: '/(.*)'
        target_label: container
      - source_labels: [__meta_docker_container_log_stream]
        target_label: stream
      - source_labels: [__meta_docker_container_label_com_docker_compose_service]
        target_label: compose_service
      - source_labels: [__meta_docker_container_label_com_docker_compose_project]
        target_label: compose_project
`;
}

function generateGrafanaDatasources(): string {
  return `apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    uid: prometheus
    url: http://prometheus:9090
    access: proxy
    isDefault: true
  - name: Loki
    type: loki
    uid: loki
    url: http://loki:3100
    access: proxy
`;
}

function generateGrafanaDashboardProvider(): string {
  return `apiVersion: 1
providers:
  - name: scalarre
    folder: ''
    type: file
    disableDeletion: false
    editable: true
    updateIntervalSeconds: 30
    allowUiUpdates: true
    options:
      path: /etc/grafana/provisioning/dashboards
      foldersFromFilesStructure: false
`;
}

function generateGrafanaReDashboard(): string {
  return JSON.stringify(reDashboard, null, 2) + '\n';
}
