#!/bin/bash
set -e

echo "Starting worker service..."
npm run db:generate
npm run worker
