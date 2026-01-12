#!/bin/bash
set -e

# Check if this is the worker service
if [ "$SERVICE_TYPE" = "worker" ]; then
    echo "Starting worker service..."
    npm run db:generate
    npm run worker
else
    echo "Starting backend server..."
    npx prisma db push --accept-data-loss --skip-generate
    npx prisma generate
    node src/index.js
fi
