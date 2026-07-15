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

import { useState, useMemo } from 'react';
import type { UnifiedConfig } from '../types';
import { generateK8sFiles, defaultK8sOptions } from '../generators/k8s';
import type { K8sOptions } from '../generators/k8s';
import { downloadZip } from '../generators/zip';
import { extractEnvVars, hasMysql, hasPostgres, hasDynamo } from '../generators/common';

interface Props {
  config: UnifiedConfig;
}

function generateCommands(config: UnifiedConfig, options: K8sOptions): { label: string; cmd: string }[] {
  const ns = options.namespace;
  const cmds: { label: string; cmd: string }[] = [];
  const envVars = extractEnvVars(config);

  // --- Credentials Secret ---
  const fromLiterals = Object.entries(envVars)
    .map(([key, value]) => `  --from-literal=${key}="${value}"`)
    .join(' \\\n');

  if (fromLiterals) {
    cmds.push({
      label: 'Create credentials Secret (alternative to applying 20-secret-credentials.yaml)',
      cmd: [
        `kubectl -n ${ns} create secret generic scalar-re-credentials \\`,
        fromLiterals,
        '',
        '# To update: delete and recreate, or use kubectl patch.',
        '# Replace sample values above with production credentials.',
      ].join('\n'),
    });
  }

  cmds.push({
    label: 'Create GHCR pull secret',
    cmd: [
      `kubectl -n ${ns} create secret docker-registry ${options.pullSecretName} \\`,
      `  --docker-server=ghcr.io \\`,
      `  --docker-username=<github-user> \\`,
      `  --docker-password=<GHCR_READ_PAT> \\`,
      `  --docker-email=<email>`,
    ].join('\n'),
  });

  const enabledDbApps: string[] = [];
  if (hasMysql(config)) enabledDbApps.push('mysql');
  if (hasPostgres(config)) enabledDbApps.push('postgres');
  if (hasDynamo(config)) enabledDbApps.push('dynamodb');
  const dbWaitLine = enabledDbApps.length > 0
    ? `for app in ${enabledDbApps.join(' ')}; do kubectl -n ${ns} wait --for=condition=ready pod -l app=$app --timeout=180s; done`
    : '';

  const deployCommon: string[] = [
    `kubectl apply -f scalar-re/00-namespace.yaml`,
    `kubectl apply -f scalar-re/10-configmap.yaml`,
    `kubectl apply -f scalar-re/20-secret-credentials.yaml`,
  ];
  const deployDb: string[] = options.includeDbPods
    ? [
        `kubectl apply -f db-pods/`,
        `# Wait for enabled DB pods to become ready`,
        dbWaitLine,
      ].filter(Boolean)
    : [];
  const deployInitAndApp: string[] = [
    `kubectl apply -f scalar-re/05-init-job.yaml`,
    `kubectl wait --for=condition=complete job/scalar-re-init -n ${ns} --timeout=240s`,
    `kubectl apply -f scalar-re/30-deployment.yaml`,
    `kubectl apply -f scalar-re/40-service.yaml`,
    `kubectl apply -f scalar-re/50-service-headless.yaml`,
    `kubectl -n ${ns} rollout status deploy/scalar-re --timeout=180s`,
  ];
  const deployMonitoring: string[] = [
    `# Monitoring stack`,
    `kubectl apply -f monitoring/`,
    `for app in prometheus loki grafana; do kubectl -n ${ns} wait --for=condition=ready pod -l app=$app --timeout=180s; done`,
    `kubectl -n ${ns} rollout status daemonset/promtail --timeout=180s`,
  ];

  cmds.push({
    label: options.includeDbPods
      ? 'Deploy (full: namespace + DB + init + app + monitoring)'
      : 'Deploy (namespace + init + app + monitoring, external DB)',
    cmd: [...deployCommon, ...deployDb, ...deployInitAndApp, ...deployMonitoring].join('\n'),
  });

  cmds.push({
    label: 'Check status',
    cmd: [
      `kubectl get pods -n ${ns}`,
      `kubectl get svc -n ${ns}`,
    ].join('\n'),
  });

  cmds.push({
    label: 'View RE logs',
    cmd: `kubectl logs -l app=scalar-re -n ${ns} --tail=100 -f`,
  });

  cmds.push({
    label: 'View init job logs',
    cmd: `kubectl logs job/scalar-re-init -n ${ns}`,
  });

  if (options.includeRecreateJob) {
    cmds.push({
      label: 'Schema reset (destructive)',
      cmd: [
        `kubectl scale deployment/scalar-re --replicas=0 -n ${ns}`,
        `kubectl delete job/scalar-re-init -n ${ns} --ignore-not-found`,
        `kubectl apply -f scalar-re/05-init-job-recreate.yaml`,
        `kubectl wait --for=condition=complete job/scalar-re-init-recreate -n ${ns} --timeout=120s`,
        `kubectl scale deployment/scalar-re --replicas=${options.replicas} -n ${ns}`,
      ].join('\n'),
    });
  }

  cmds.push({
    label: 'Scale replicas',
    cmd: `kubectl scale deployment/scalar-re --replicas=${options.replicas} -n ${ns}`,
  });

  if (options.serviceType === 'LoadBalancer') {
    cmds.push({
      label: 'Expose via minikube tunnel (separate terminal)',
      cmd: [
        `# 0.0.0.0 bind: reachable via localhost / VM IP / any IF (recommended)`,
        `minikube tunnel --bind-address=0.0.0.0`,
        `# Alternative bind targets:`,
        `#   minikube tunnel                              -> 127.0.0.1 only`,
        `#   minikube tunnel --bind-address=<VM_IP>       -> that IP only (not localhost)`,
        ``,
        `# Then check EXTERNAL-IP and actual listen:`,
        `kubectl get svc -n ${ns}`,
        `ss -ltn | grep -E ':3000|:8080|:9090'`,
      ].join('\n'),
    });
  }

  cmds.push({
    label: 'Delete everything',
    cmd: [
      `kubectl delete -f scalar-re/  --ignore-not-found`,
      options.includeDbPods ? `kubectl delete -f db-pods/    --ignore-not-found` : '',
      `kubectl delete -f monitoring/ --ignore-not-found`,
      `kubectl delete namespace ${ns}`,
      `# cluster-scoped RBAC (not removed by deleting the namespace)`,
      `kubectl delete clusterrole prometheus-${ns} promtail-${ns} --ignore-not-found`,
      `kubectl delete clusterrolebinding prometheus-${ns} promtail-${ns} --ignore-not-found`,
    ].filter(Boolean).join('\n'),
  });

  return cmds;
}

export default function OutputK8s({ config }: Props) {
  const [options, setOptions] = useState<K8sOptions>(defaultK8sOptions);
  const [activeTab, setActiveTab] = useState(0);
  const [saveStatus, setSaveStatus] = useState('');

  const files = useMemo(() => generateK8sFiles(config, options), [config, options]);
  const commands = useMemo(() => generateCommands(config, options), [config, options]);

  const tabs = files.map((f) => f.path);

  async function handleSave() {
    try {
      await downloadZip(files, 'scalar-re-k8s.zip');
      setSaveStatus('Downloaded scalar-re-k8s.zip');
    } catch (err) {
      setSaveStatus(`Download failed: ${err}`);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Kubernetes Output</div>
        <button className="btn btn-primary" onClick={handleSave}>Save ZIP</button>
      </div>

      {saveStatus && (
        <div style={{ marginBottom: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
          {saveStatus}
        </div>
      )}

      <div className="form-section">
        <div className="form-section-title">Cluster Settings</div>
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">K8s Namespace</label>
            <input
              className="form-input"
              value={options.namespace}
              onChange={(e) => setOptions({ ...options, namespace: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Replicas</label>
            <input
              type="number"
              className="form-input"
              min={1}
              max={20}
              value={options.replicas}
              onChange={(e) => setOptions({ ...options, replicas: Math.max(1, Number(e.target.value)) })}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Service Type</label>
            <select
              className="form-select"
              value={options.serviceType}
              onChange={(e) => setOptions({ ...options, serviceType: e.target.value as K8sOptions['serviceType'] })}
            >
              <option value="LoadBalancer">LoadBalancer</option>
              <option value="NodePort">NodePort</option>
              <option value="ClusterIP">ClusterIP</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Service Port</label>
            <input
              type="number"
              className="form-input"
              value={options.servicePort}
              onChange={(e) => setOptions({ ...options, servicePort: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">Image Settings</div>
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">Registry</label>
            <input
              className="form-input"
              value={options.imageRegistry}
              onChange={(e) => setOptions({ ...options, imageRegistry: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label className="form-label">App Image Repo</label>
            <input
              className="form-input"
              value={options.appImageRepo}
              onChange={(e) => setOptions({ ...options, appImageRepo: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Init Image Repo</label>
            <input
              className="form-input"
              value={options.initImageRepo}
              onChange={(e) => setOptions({ ...options, initImageRepo: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Image Tag</label>
            <input
              className="form-input"
              value={options.imageTag}
              onChange={(e) => setOptions({ ...options, imageTag: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Pull Secret Name</label>
            <input
              className="form-input"
              value={options.pullSecretName}
              onChange={(e) => setOptions({ ...options, pullSecretName: e.target.value })}
            />
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="form-grid">
          <div className="form-checkbox">
            <input
              type="checkbox"
              checked={options.includeDbPods}
              onChange={(e) => setOptions({ ...options, includeDbPods: e.target.checked })}
            />
            <label>Include DB Pods (for testing)</label>
          </div>
          <div className="form-checkbox">
            <input
              type="checkbox"
              checked={options.includeRecreateJob}
              onChange={(e) => setOptions({ ...options, includeRecreateJob: e.target.checked })}
            />
            <label>Include Recreate Job (destructive reset)</label>
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">Usage Commands</div>
        {commands.map((c, i) => (
          <div key={i}>
            <div className="command-label">{c.label}</div>
            <div className="command-block">{c.cmd}</div>
          </div>
        ))}
      </div>

      <div className="preview-tabs">
        {tabs.map((tab, i) => (
          <div
            key={tab}
            className={`preview-tab ${activeTab === i ? 'active' : ''}`}
            onClick={() => setActiveTab(i)}
          >
            {tab.replace('scalar-re/', '').replace('db-pods/', 'db/')}
          </div>
        ))}
      </div>

      <div className="preview-content">
        {files[activeTab]?.content || ''}
      </div>
    </div>
  );
}
