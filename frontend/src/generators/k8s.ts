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

export interface K8sOptions {
  namespace: string;
  replicas: number;
  imageRegistry: string;
  appImageRepo: string;
  initImageRepo: string;
  imageTag: string;
  pullSecretName: string;
  serviceType: 'LoadBalancer' | 'NodePort' | 'ClusterIP';
  servicePort: number;
  includeDbPods: boolean;
  includeRecreateJob: boolean;
}

export const defaultK8sOptions: K8sOptions = {
  namespace: 'scalar-re',
  replicas: 3,
  imageRegistry: 'ghcr.io/yu2scalar',
  appImageRepo: 'scalar-re',
  initImageRepo: 'scalar-re-init',
  imageTag: 'latest',
  pullSecretName: 'ghcr-pull',
  serviceType: 'LoadBalancer',
  servicePort: 8080,
  includeDbPods: true,
  includeRecreateJob: true,
};

export function generateK8sFiles(config: UnifiedConfig, options: K8sOptions): ZipEntry[] {
  const entries: ZipEntry[] = [];

  // Host-side companion files (mirrors the Compose layout). They let an operator
  // on the host machine `source .env` and run the Producer / e2e-test scripts
  // against the K8s LoadBalancer (typically reached via `minikube tunnel`).
  // Contents are identical to the in-cluster ConfigMap / Secret bodies, so the
  // host and in-cluster paths share a single source of truth.
  entries.push({ path: '.env', content: generateK8sDotEnv(config, options) });
  entries.push({ path: 'scalar-re-config.yml', content: generateK8sHostConfig(config) });

  entries.push({ path: 'scalar-re/00-namespace.yaml', content: generateNamespace(options) });
  entries.push({ path: 'scalar-re/05-init-job.yaml', content: generateInitJob(config, options) });
  if (options.includeRecreateJob) {
    entries.push({ path: 'scalar-re/05-init-job-recreate.yaml', content: generateInitJobRecreate(config, options) });
  }
  entries.push({ path: 'scalar-re/10-configmap.yaml', content: generateConfigMap(config, options) });
  entries.push({ path: 'scalar-re/20-secret-credentials.yaml', content: generateSecretCredentials(config, options) });
  entries.push({ path: 'scalar-re/21-secret-ghcr.yaml.example', content: generateSecretGhcrExample(options) });
  entries.push({ path: 'scalar-re/30-deployment.yaml', content: generateDeployment(options) });
  entries.push({ path: 'scalar-re/40-service.yaml', content: generateService(options) });
  entries.push({ path: 'scalar-re/50-service-headless.yaml', content: generateServiceHeadless(options) });

  if (options.includeDbPods) {
    if (hasMysql(config)) {
      entries.push({ path: 'db-pods/mysql.yaml', content: generateMysqlPod(options) });
    }
    if (hasPostgres(config)) {
      entries.push({ path: 'db-pods/postgres.yaml', content: generatePostgresPod(config, options) });
    }
    if (hasDynamo(config)) {
      entries.push({ path: 'db-pods/dynamodb.yaml', content: generateDynamoPod(options) });
    }
  }

  // Monitoring stack (Prometheus + Loki + Promtail + Grafana). Component-
  // grouped multi-doc YAML so every file is apply/delete-able on its own.
  entries.push({ path: 'monitoring/60-prometheus.yaml', content: generatePrometheusManifest(options) });
  entries.push({ path: 'monitoring/70-loki.yaml', content: generateLokiManifest(options) });
  entries.push({ path: 'monitoring/80-promtail.yaml', content: generatePromtailManifest(options) });
  entries.push({ path: 'monitoring/90-grafana.yaml', content: generateGrafanaManifest(options) });
  entries.push({ path: 'monitoring/95-grafana-dashboard-re.yaml', content: generateGrafanaDashboardConfigMap(options) });

  return entries;
}

function generateK8sDotEnv(config: UnifiedConfig, options: K8sOptions): string {
  const lines: string[] = [];
  lines.push('# ScalarRE Kubernetes Environment Variables (host-side companion)');
  lines.push('#');
  lines.push('# Source from a host shell to populate API_KEY / HMAC_KEY / RE_BASE_URL');
  lines.push('# for the Producer and the e2e-test / e2e-replay scripts:');
  lines.push('#');
  lines.push('#   set -a; source .env; set +a');
  lines.push('#');
  lines.push('# DB hosts below are K8s Service names — they are only meaningful to');
  lines.push('# in-cluster RE pods. Host processes (Producer / e2e) reach the cluster');
  lines.push('# through the LoadBalancer at RE_BASE_URL and never touch the DBs directly.');
  lines.push('');

  const envVars = extractEnvVars(config);

  const categories: Record<string, [string, string][]> = {
    'Host': [
      ['JAVA_TOOL_OPTIONS', '-Xmx512m'],
      ['RE_BASE_URL', `http://localhost:${options.servicePort}`],
    ],
    'Authentication': [],
    'MySQL': [],
    'PostgreSQL': [],
    'DynamoDB Local': [],
    'HMAC Keys': [],
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
    }
  }

  if (hasMysql(config)) {
    categories['MySQL'].push(['MYSQL_ROOT_PASSWORD', 'rootpassword']);
  }
  if (hasPostgres(config)) {
    categories['PostgreSQL'].push(['POSTGRES_ROOT_PASSWORD', 'rootpassword']);
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

function generateK8sHostConfig(config: UnifiedConfig): string {
  // Same body the in-cluster ConfigMap embeds — DB hosts resolved against the
  // K8s Service names. Spring on the host parses this only to populate
  // SCALAR_RE_* env defaults; nothing here is actually used to talk to a DB
  // from the host (see the .env header note).
  const baseYaml = configToYaml(config);
  return rewriteEnvDefaults(baseYaml, config.storages);
}

function generateNamespace(options: K8sOptions): string {
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${options.namespace}
  labels:
    app.kubernetes.io/name: scalar-re
    app.kubernetes.io/part-of: scalar-re
`;
}

function generateInitJob(_config: UnifiedConfig, options: K8sOptions): string {
  const image = `${options.imageRegistry}/${options.initImageRepo}:${options.imageTag}`;
  return `# ScalarRE schema initialization Job.
#
# Apply this (and wait for completion) BEFORE applying 30-deployment.yaml.
#
#   kubectl apply -f scalar-re/05-init-job.yaml
#   kubectl wait --for=condition=complete job/scalar-re-init -n ${options.namespace} --timeout=120s
apiVersion: batch/v1
kind: Job
metadata:
  name: scalar-re-init
  namespace: ${options.namespace}
  labels:
    app: scalar-re
    component: init
spec:
  backoffLimit: 6
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels:
        app: scalar-re
        component: init
    spec:
      restartPolicy: OnFailure
      imagePullSecrets:
      - name: ${options.pullSecretName}
      containers:
      - name: init
        image: ${image}
        imagePullPolicy: Always
        envFrom:
        - secretRef:
            name: scalar-re-credentials
        volumeMounts:
        - name: config
          mountPath: /app/scalar-re-config.yml
          subPath: scalar-re-config.yml
          readOnly: true
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: "1"
            memory: 1Gi
      volumes:
      - name: config
        configMap:
          name: scalar-re-config
`;
}

function generateInitJobRecreate(_config: UnifiedConfig, options: K8sOptions): string {
  const image = `${options.imageRegistry}/${options.initImageRepo}:${options.imageTag}`;
  return `# DESTRUCTIVE: drops and recreates all ScalarRE tables.
#
#   kubectl scale deployment/scalar-re --replicas=0 -n ${options.namespace}
#   kubectl delete job/scalar-re-init -n ${options.namespace}
#   kubectl apply -f scalar-re/05-init-job-recreate.yaml
#   kubectl wait --for=condition=complete job/scalar-re-init-recreate -n ${options.namespace}
#   kubectl scale deployment/scalar-re --replicas=${options.replicas} -n ${options.namespace}
apiVersion: batch/v1
kind: Job
metadata:
  name: scalar-re-init-recreate
  namespace: ${options.namespace}
  labels:
    app: scalar-re
    component: init
    mode: recreate
spec:
  backoffLimit: 2
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels:
        app: scalar-re
        component: init
        mode: recreate
    spec:
      restartPolicy: OnFailure
      imagePullSecrets:
      - name: ${options.pullSecretName}
      containers:
      - name: init
        image: ${image}
        imagePullPolicy: Always
        args: ["--recreate-schema"]
        envFrom:
        - secretRef:
            name: scalar-re-credentials
        volumeMounts:
        - name: config
          mountPath: /app/scalar-re-config.yml
          subPath: scalar-re-config.yml
          readOnly: true
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: "1"
            memory: 1Gi
      volumes:
      - name: config
        configMap:
          name: scalar-re-config
`;
}

function generateConfigMap(config: UnifiedConfig, options: K8sOptions): string {
  const baseYaml = configToYaml(config);
  const containerYaml = rewriteEnvDefaults(baseYaml, config.storages);
  // Indent the YAML content for ConfigMap embedding (4 spaces)
  const indented = containerYaml.split('\n').map((line) => line ? `    ${line}` : '').join('\n');

  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: scalar-re-config
  namespace: ${options.namespace}
  labels:
    app: scalar-re
data:
  scalar-re-config.yml: |
${indented}
`;
}

function generateSecretCredentials(config: UnifiedConfig, options: K8sOptions): string {
  const envVars = extractEnvVars(config);
  const lines: string[] = [];

  lines.push(`apiVersion: v1`);
  lines.push(`kind: Secret`);
  lines.push(`metadata:`);
  lines.push(`  name: scalar-re-credentials`);
  lines.push(`  namespace: ${options.namespace}`);
  lines.push(`  labels:`);
  lines.push(`    app: scalar-re`);
  lines.push(`type: Opaque`);
  lines.push(`stringData:`);

  // Group and output
  const categories: [string, [string, string][]][] = [
    ['Authentication', []],
    ['MySQL', []],
    ['PostgreSQL', []],
    ['DynamoDB Local', []],
    ['HMAC Keys', []],
  ];

  for (const [key, value] of Object.entries(envVars)) {
    if (key === 'SCALAR_RE_API_KEY') {
      categories[0][1].push([key, value]);
    } else if (key.includes('MYSQL') && !key.includes('HMAC')) {
      categories[1][1].push([key, value]);
    } else if (key.includes('POSTGRES') && !key.includes('HMAC')) {
      categories[2][1].push([key, value]);
    } else if (key.includes('DYNAMO') && !key.includes('HMAC')) {
      categories[3][1].push([key, value]);
    } else if (key.includes('HMAC')) {
      categories[4][1].push([key, value]);
    }
  }

  for (const [category, vars] of categories) {
    if (vars.length === 0) continue;
    lines.push(`  # --- ${category} ---`);
    for (const [key, value] of vars) {
      lines.push(`  ${key}: "${value}"`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function generateSecretGhcrExample(options: K8sOptions): string {
  return `# GHCR pull Secret (DO NOT apply this file directly — it is a placeholder).
#
# Create the Secret with kubectl using a GitHub PAT that has \`read:packages\` scope:
#
#   kubectl -n ${options.namespace} create secret docker-registry ${options.pullSecretName} \\
#     --docker-server=ghcr.io \\
#     --docker-username=<github-user> \\
#     --docker-password=<GHCR_READ_PAT> \\
#     --docker-email=<email>
#
# The Secret name \`${options.pullSecretName}\` is referenced from 30-deployment.yaml.
`;
}

function generateDeployment(options: K8sOptions): string {
  const image = `${options.imageRegistry}/${options.appImageRepo}:${options.imageTag}`;
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: scalar-re
  namespace: ${options.namespace}
  labels:
    app: scalar-re
spec:
  replicas: ${options.replicas}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
      app: scalar-re
  template:
    metadata:
      labels:
        app: scalar-re
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/actuator/prometheus"
    spec:
      imagePullSecrets:
      - name: ${options.pullSecretName}
      containers:
      - name: scalar-re
        image: ${image}
        imagePullPolicy: Always
        ports:
        - name: http
          containerPort: 8080
        envFrom:
        - secretRef:
            name: scalar-re-credentials
        volumeMounts:
        - name: config
          mountPath: /app/scalar-re-config.yml
          subPath: scalar-re-config.yml
          readOnly: true
        livenessProbe:
          httpGet:
            path: /actuator/health
            port: http
          initialDelaySeconds: 60
          periodSeconds: 15
          timeoutSeconds: 5
          failureThreshold: 4
        readinessProbe:
          httpGet:
            path: /actuator/health
            port: http
          initialDelaySeconds: 15
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
        resources:
          requests:
            cpu: 250m
            memory: 512Mi
          limits:
            cpu: "2"
            memory: 2Gi
      volumes:
      - name: config
        configMap:
          name: scalar-re-config
`;
}

function generateService(options: K8sOptions): string {
  return `apiVersion: v1
kind: Service
metadata:
  name: scalar-re
  namespace: ${options.namespace}
  labels:
    app: scalar-re
spec:
  type: ${options.serviceType}
  selector:
    app: scalar-re
  ports:
  - name: http
    port: ${options.servicePort}
    targetPort: http
    protocol: TCP
`;
}

function generateServiceHeadless(options: K8sOptions): string {
  return `# Headless Service for direct Pod access (verification, debugging).
apiVersion: v1
kind: Service
metadata:
  name: scalar-re-headless
  namespace: ${options.namespace}
  labels:
    app: scalar-re
spec:
  clusterIP: None
  selector:
    app: scalar-re
  ports:
  - name: http
    port: 8080
    targetPort: http
    protocol: TCP
`;
}

function generateMysqlPod(options: K8sOptions): string {
  return `# MySQL 8.0 for in-cluster verification.
# Data is on emptyDir — wiped on Pod restart.
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: mysql-init
  namespace: ${options.namespace}
data:
  init.sql: |
    CREATE USER IF NOT EXISTS 'scalaradmin'@'%' IDENTIFIED BY 'scalaradmin';
    GRANT CREATE, DROP, ALTER, INDEX, SELECT, INSERT, UPDATE, DELETE
      ON *.* TO 'scalaradmin'@'%';
    FLUSH PRIVILEGES;
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mysql
  namespace: ${options.namespace}
  labels:
    app: mysql
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: mysql
  template:
    metadata:
      labels:
        app: mysql
    spec:
      containers:
      - name: mysql
        image: mysql:8.0
        # max-connect-errors defaults to 100; under a repeating-retry
        # workload (e.g. benchmark scripts restarting Producer) MySQL
        # will block the client IP and require a manual flush-hosts.
        # Raising the ceiling removes that failure mode.
        args: ["--max-connections=1000", "--max-connect-errors=100000"]
        ports:
        - name: mysql
          containerPort: 3306
        env:
        - name: MYSQL_ROOT_PASSWORD
          value: "rootpassword"
        readinessProbe:
          tcpSocket:
            port: mysql
          initialDelaySeconds: 20
          periodSeconds: 5
          timeoutSeconds: 3
        livenessProbe:
          tcpSocket:
            port: mysql
          initialDelaySeconds: 60
          periodSeconds: 15
          timeoutSeconds: 5
        volumeMounts:
        - name: data
          mountPath: /var/lib/mysql
        - name: init
          mountPath: /docker-entrypoint-initdb.d
        resources:
          requests:
            cpu: 200m
            memory: 512Mi
          limits:
            cpu: "1"
            memory: 1Gi
      volumes:
      - name: data
        emptyDir: {}
      - name: init
        configMap:
          name: mysql-init
---
apiVersion: v1
kind: Service
metadata:
  name: mysql
  namespace: ${options.namespace}
  labels:
    app: mysql
spec:
  type: ${options.serviceType}
  selector:
    app: mysql
  ports:
  - name: mysql
    port: 3306
    targetPort: mysql
`;
}

function generatePostgresPod(config: UnifiedConfig, options: K8sOptions): string {
  // Find the database name from postgres storage config
  let dbName = 'ns_postgres';
  for (const [, st] of Object.entries(config.storages)) {
    if (st.type === 'jdbc' && st.driver === 'postgresql' && st.database) {
      const match = st.database.match(/^\$\{[^:}]+:(.+)\}$/);
      dbName = match ? match[1] : st.database;
      break;
    }
  }

  return `# PostgreSQL 15 for in-cluster verification.
# Data is on emptyDir — wiped on Pod restart.
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-init
  namespace: ${options.namespace}
data:
  init.sql: |
    CREATE USER scalaradmin WITH PASSWORD 'scalaradmin';
    ALTER USER scalaradmin CREATEDB;
    CREATE DATABASE ${dbName} OWNER scalaradmin;
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: ${options.namespace}
  labels:
    app: postgres
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
      - name: postgres
        image: postgres:15
        args: ["-c", "max_connections=1000"]
        ports:
        - name: postgres
          containerPort: 5432
        env:
        - name: POSTGRES_PASSWORD
          value: "rootpassword"
        - name: PGDATA
          value: "/var/lib/postgresql/data/pgdata"
        readinessProbe:
          exec:
            command: ["pg_isready", "-U", "postgres"]
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
        livenessProbe:
          exec:
            command: ["pg_isready", "-U", "postgres"]
          initialDelaySeconds: 30
          periodSeconds: 15
          timeoutSeconds: 5
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        - name: init
          mountPath: /docker-entrypoint-initdb.d
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: "1"
            memory: 1Gi
      volumes:
      - name: data
        emptyDir: {}
      - name: init
        configMap:
          name: postgres-init
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: ${options.namespace}
  labels:
    app: postgres
spec:
  type: ${options.serviceType}
  selector:
    app: postgres
  ports:
  - name: postgres
    port: 5432
    targetPort: postgres
`;
}

function generateDynamoPod(options: K8sOptions): string {
  return `# DynamoDB Local (in-memory) for verification.
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dynamodb
  namespace: ${options.namespace}
  labels:
    app: dynamodb
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: dynamodb
  template:
    metadata:
      labels:
        app: dynamodb
    spec:
      containers:
      - name: dynamodb
        image: amazon/dynamodb-local:latest
        imagePullPolicy: IfNotPresent
        args: ["-jar", "DynamoDBLocal.jar", "-sharedDb", "-inMemory"]
        ports:
        - name: dynamodb
          containerPort: 8000
        # Lenient probes: dynamodb-local 3.x cold-starts slowly under CPU contention;
        # an aggressive liveness (timeoutSeconds default 1) crash-loops it.
        readinessProbe:
          tcpSocket:
            port: dynamodb
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 5
          failureThreshold: 6
        livenessProbe:
          tcpSocket:
            port: dynamodb
          initialDelaySeconds: 60
          periodSeconds: 20
          timeoutSeconds: 5
          failureThreshold: 6
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 1Gi
---
apiVersion: v1
kind: Service
metadata:
  name: dynamodb
  namespace: ${options.namespace}
  labels:
    app: dynamodb
spec:
  type: ${options.serviceType}
  selector:
    app: dynamodb
  ports:
  - name: dynamodb
    port: 8000
    targetPort: dynamodb
`;
}

// ============================================================================
// Monitoring stack (Prometheus / Loki / Promtail / Grafana)
// ============================================================================
//
// Matches the Docker Compose monitoring profile 1:1 in behavior:
//   - Prometheus scrapes RE pods via kubernetes_sd_configs (uses the
//     prometheus.io/scrape annotation already on scalar-re Deployment).
//   - Loki 2.9.0 monolithic with 24h retention, filesystem backend.
//   - Promtail runs as a DaemonSet, tails /var/log/pods, and pushes to
//     Loki. compose_service label is derived from pod label "app" so
//     RE pods get compose_service=scalar-re (dashboard LogQL already
//     covers both 're-.*' and 'scalar-re' via regex).
//   - Grafana 10.4.2 with anonymous Viewer, auto-provisioned datasources
//     (Prometheus+Loki) and the 16-panel RE dashboard.

function generatePrometheusManifest(options: K8sOptions): string {
  const ns = options.namespace;
  return `# Prometheus — scrapes RE pods via kubernetes_sd_configs.
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: ${ns}
  labels:
    app: prometheus
data:
  prometheus.yml: |
    global:
      scrape_interval: 5s

    scrape_configs:
      - job_name: scalar-re
        kubernetes_sd_configs:
          - role: pod
            namespaces:
              names: [${ns}]
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
            action: keep
            regex: true
          - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
            action: replace
            target_label: __metrics_path__
            regex: (.+)
          - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
            action: replace
            regex: ([^:]+)(?::\\d+)?;(\\d+)
            replacement: $1:$2
            target_label: __address__
          - source_labels: [__meta_kubernetes_pod_name]
            target_label: pod
          - source_labels: [__meta_kubernetes_pod_label_app]
            target_label: app
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus
  namespace: ${ns}
  labels:
    app: prometheus
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus-${ns}
  labels:
    app: prometheus
rules:
  - apiGroups: [""]
    resources: ["pods", "services", "endpoints"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus-${ns}
  labels:
    app: prometheus
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: prometheus-${ns}
subjects:
  - kind: ServiceAccount
    name: prometheus
    namespace: ${ns}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: prometheus-data
  namespace: ${ns}
  labels:
    app: prometheus
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 5Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus
  namespace: ${ns}
  labels:
    app: prometheus
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: prometheus
  template:
    metadata:
      labels:
        app: prometheus
    spec:
      serviceAccountName: prometheus
      containers:
        - name: prometheus
          image: prom/prometheus:latest
          args:
            - --config.file=/etc/prometheus/prometheus.yml
            - --storage.tsdb.path=/prometheus
            - --web.enable-lifecycle
          ports:
            - name: http
              containerPort: 9090
          volumeMounts:
            - name: config
              mountPath: /etc/prometheus
            - name: data
              mountPath: /prometheus
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 1Gi
      volumes:
        - name: config
          configMap:
            name: prometheus-config
        - name: data
          persistentVolumeClaim:
            claimName: prometheus-data
---
apiVersion: v1
kind: Service
metadata:
  name: prometheus
  namespace: ${ns}
  labels:
    app: prometheus
spec:
  type: ${options.serviceType}
  selector:
    app: prometheus
  ports:
    - name: http
      port: 9090
      targetPort: http
`;
}

function generateLokiManifest(options: K8sOptions): string {
  const ns = options.namespace;
  return `# Loki 2.9.0 — monolithic, filesystem backend, 24h retention.
apiVersion: v1
kind: ConfigMap
metadata:
  name: loki-config
  namespace: ${ns}
  labels:
    app: loki
data:
  local-config.yaml: |
    auth_enabled: false
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
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: loki-data
  namespace: ${ns}
  labels:
    app: loki
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 5Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: loki
  namespace: ${ns}
  labels:
    app: loki
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: loki
  template:
    metadata:
      labels:
        app: loki
    spec:
      containers:
        - name: loki
          image: grafana/loki:2.9.0
          args: ["-config.file=/etc/loki/local-config.yaml"]
          ports:
            - name: http
              containerPort: 3100
          volumeMounts:
            - name: config
              mountPath: /etc/loki
            - name: data
              mountPath: /loki
          readinessProbe:
            httpGet:
              path: /ready
              port: http
            initialDelaySeconds: 45
            periodSeconds: 10
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 1Gi
      volumes:
        - name: config
          configMap:
            name: loki-config
        - name: data
          persistentVolumeClaim:
            claimName: loki-data
---
apiVersion: v1
kind: Service
metadata:
  name: loki
  namespace: ${ns}
  labels:
    app: loki
spec:
  type: ClusterIP
  selector:
    app: loki
  ports:
    - name: http
      port: 3100
      targetPort: http
`;
}

function generatePromtailManifest(options: K8sOptions): string {
  const ns = options.namespace;
  return `# Promtail DaemonSet — tails /var/log/pods on every node and pushes
# to Loki. compose_service label is derived from the pod "app" label so
# the shared dashboard LogQL works across Compose and K8s environments.
apiVersion: v1
kind: ConfigMap
metadata:
  name: promtail-config
  namespace: ${ns}
  labels:
    app: promtail
data:
  config.yml: |
    # Static glob + filename-regex approach: kubernetes_sd_configs gave
    # zero targets on minikube (Promtail 2.9.x bug / quirk), but globbing
    # /var/log/pods and parsing the path for namespace/pod/container
    # labels works reliably. Docker driver puts actual logs under
    # /var/lib/docker/containers and exposes them via symlink, so we mount
    # both paths.
    server:
      http_listen_port: 9080
      grpc_listen_port: 0
    positions:
      filename: /tmp/positions.yaml
    clients:
      - url: http://loki:3100/loki/api/v1/push
    scrape_configs:
      - job_name: pod-logs
        pipeline_stages:
          - docker: {}
          - regex:
              source: filename
              expression: "/var/log/pods/(?P<namespace>[^_]+)_(?P<pod>[^_]+)_(?P<uid>[^/]+)/(?P<container>[^/]+)/.*\\\\.log"
          - labels:
              namespace:
              pod:
              container:
          - template:
              source: compose_service
              template: "{{ .container }}"
          - labels:
              compose_service:
        static_configs:
          - targets: [localhost]
            labels:
              job: pod-logs
              __path__: /var/log/pods/*/*/*.log
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: promtail
  namespace: ${ns}
  labels:
    app: promtail
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: promtail-${ns}
  labels:
    app: promtail
rules:
  - apiGroups: [""]
    resources: ["pods", "nodes", "nodes/proxy"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: promtail-${ns}
  labels:
    app: promtail
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: promtail-${ns}
subjects:
  - kind: ServiceAccount
    name: promtail
    namespace: ${ns}
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: promtail
  namespace: ${ns}
  labels:
    app: promtail
spec:
  selector:
    matchLabels:
      app: promtail
  template:
    metadata:
      labels:
        app: promtail
    spec:
      serviceAccountName: promtail
      containers:
        - name: promtail
          image: grafana/promtail:2.9.0
          args: ["-config.file=/etc/promtail/config.yml"]
          volumeMounts:
            - name: config
              mountPath: /etc/promtail
            - name: varlog-pods
              mountPath: /var/log/pods
              readOnly: true
            - name: varlog-containers
              mountPath: /var/log/containers
              readOnly: true
            # minikube's docker runtime writes actual container logs to
            # /var/lib/docker/containers/<id>/<id>-json.log and exposes them
            # under /var/log/pods via symlink. Promtail needs the real file
            # reachable to follow those symlinks.
            - name: docker-containers
              mountPath: /var/lib/docker/containers
              readOnly: true
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
      volumes:
        - name: config
          configMap:
            name: promtail-config
        - name: varlog-pods
          hostPath:
            path: /var/log/pods
        - name: varlog-containers
          hostPath:
            path: /var/log/containers
        - name: docker-containers
          hostPath:
            path: /var/lib/docker/containers
            type: DirectoryOrCreate
`;
}

function generateGrafanaManifest(options: K8sOptions): string {
  const ns = options.namespace;
  return `# Grafana 10.4.2 — anonymous Viewer, auto-provisioned Prometheus+Loki
# datasources and the RE dashboard (ConfigMap in 95-grafana-dashboard-re.yaml).
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: ${ns}
  labels:
    app: grafana
data:
  datasources.yaml: |
    apiVersion: 1
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
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-dashboards-provider
  namespace: ${ns}
  labels:
    app: grafana
data:
  dashboards.yaml: |
    apiVersion: 1
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
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: grafana-data
  namespace: ${ns}
  labels:
    app: grafana
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 2Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: grafana
  namespace: ${ns}
  labels:
    app: grafana
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: grafana
  template:
    metadata:
      labels:
        app: grafana
    spec:
      securityContext:
        fsGroup: 472
        runAsUser: 472
      containers:
        - name: grafana
          image: grafana/grafana:10.4.2
          env:
            - name: GF_AUTH_ANONYMOUS_ENABLED
              value: "true"
            - name: GF_AUTH_ANONYMOUS_ORG_ROLE
              value: Viewer
          ports:
            - name: http
              containerPort: 3000
          volumeMounts:
            - name: data
              mountPath: /var/lib/grafana
            - name: datasources
              mountPath: /etc/grafana/provisioning/datasources
            - name: dashboards-config
              mountPath: /etc/grafana/provisioning/dashboards
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 1Gi
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: grafana-data
        - name: datasources
          configMap:
            name: grafana-datasources
        # Merge the provider manifest and every dashboard JSON into a single
        # directory. Grafana picks up *.yaml as provider files and every
        # other file as a dashboard.
        - name: dashboards-config
          projected:
            sources:
              - configMap:
                  name: grafana-dashboards-provider
                  items:
                    - key: dashboards.yaml
                      path: dashboards.yaml
              - configMap:
                  name: grafana-dashboard-re
                  items:
                    - key: re-dashboard.json
                      path: re-dashboard.json
---
apiVersion: v1
kind: Service
metadata:
  name: grafana
  namespace: ${ns}
  labels:
    app: grafana
spec:
  type: ${options.serviceType}
  selector:
    app: grafana
  ports:
    - name: http
      port: 3000
      targetPort: http
`;
}

function generateGrafanaDashboardConfigMap(options: K8sOptions): string {
  const ns = options.namespace;
  // Indent every non-empty line by 4 spaces for ConfigMap | block scalar.
  const dashboardJson = JSON.stringify(reDashboard, null, 2);
  const indented = dashboardJson.split('\n').map((line) => (line ? `    ${line}` : '')).join('\n');
  return `# RE dashboard as a single ConfigMap (~30 KiB, well under the 1 MiB
# ConfigMap limit). If additional dashboards are introduced, append their
# JSON bodies as extra keys here and extend the projected volume in
# 90-grafana.yaml.
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-dashboard-re
  namespace: ${ns}
  labels:
    app: grafana
    dashboard: re
data:
  re-dashboard.json: |
${indented}
`;
}
