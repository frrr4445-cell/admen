#!/usr/bin/env bash
set -euo pipefail
PROJECT_ID="${1:-${GCLOUD_PROJECT:-}}"
if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: npm run configure:ttl -- YOUR_FIREBASE_PROJECT_ID" >&2
  exit 2
fi
if ! command -v gcloud >/dev/null 2>&1; then
  echo "Google Cloud CLI (gcloud) is required. Install it and run: gcloud auth login" >&2
  exit 2
fi
for GROUP in offerLocks apiRateLimits paypalWebhookEvents; do
  echo "Enabling Firestore TTL: collectionGroup=$GROUP field=expiresAt project=$PROJECT_ID"
  gcloud firestore fields ttls update expiresAt --collection-group="$GROUP" --enable-ttl --async --project="$PROJECT_ID"
done
echo "TTL policies requested. They may take 10 minutes or more to become active."
echo "Verify with: gcloud firestore fields ttls list --project=$PROJECT_ID"
