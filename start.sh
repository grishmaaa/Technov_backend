#!/bin/bash
set -e

# Check if this is the worker service
if [ "$SERVICE_TYPE" = "worker" ]; then
    echo "Starting worker service..."
    npm run db:generate
    npm run worker
else
    echo "Starting backend server..."
    
    # Optional: Inject Service Account Key if provided (Universal Auth Support)
    if [ -n "$GCP_SA_KEY" ]; then
        echo "Detected GCP_SA_KEY. Writing to vertex-key.json..."
        echo "$GCP_SA_KEY" > vertex-key.json
    fi

    npx prisma db push --accept-data-loss --skip-generate
    npx prisma generate
    node src/index.js
fi
