#!/bin/bash
set -e

echo "Running database migrations..."
npx prisma db push --accept-data-loss --skip-generate

echo "Generating Prisma Client..."
npx prisma generate

echo "Starting server..."
npm start
