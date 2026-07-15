#!/usr/bin/env bash
#
# db-up.sh — bring up the in-cluster DBs on minikube for DB verification.
#
# Applies scalar-re-config's own golden manifests (frontend/verify-output/k8s/db-pods/)
# and waits until the mysql / postgres / dynamodb pods are ready.
# Self-contained in this repo (ported from an external deploy script's
# db-pods apply+wait steps).
#
# Prerequisites: minikube running + kubectl. To receive the LoadBalancer on
#       127.0.0.1, keep `minikube tunnel` (sudo) running in another shell.
#
# Usage:
#   ./verify/db-up.sh            # bring up + wait for ready
#   ./verify/db-up.sh --down     # tear down (delete Deployment/Service/ConfigMap; namespace is kept)
set -euo pipefail

NS="scalar-re"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_PODS="$HERE/../frontend/verify-output/k8s/db-pods"
NS_MANIFEST="$HERE/../frontend/verify-output/k8s/scalar-re/00-namespace.yaml"

if [ "${1:-}" = "--down" ]; then
  echo "Tearing down db-pods in namespace $NS ..."
  kubectl delete -f "$DB_PODS" --ignore-not-found
  echo "Done (namespace $NS retained)."
  exit 0
fi

echo "Applying namespace + db-pods to $NS ..."
kubectl apply -f "$NS_MANIFEST"
kubectl apply -f "$DB_PODS"

echo "Waiting for DB pods to become ready ..."
for app in mysql postgres dynamodb; do
  kubectl -n "$NS" wait --for=condition=ready pod -l app="$app" --timeout=180s
done

echo
echo "DB services (LoadBalancer EXTERNAL-IP appears as 127.0.0.1 via minikube tunnel):"
kubectl -n "$NS" get svc mysql postgres dynamodb
echo
echo "To reach them from the host: 127.0.0.1:3306 (mysql) / 5432 (postgres) / 8000 (dynamodb)"
echo "Without the tunnel running, EXTERNAL-IP stays <pending> and the ports are CLOSED."
