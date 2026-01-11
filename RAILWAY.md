# Railway Deployment Notes

This backend is built to use Railway Managed Postgres, Redis, and Buckets.

## Services

- Postgres: use Railway managed database. Keep the pooler endpoint in `DATABASE_URL`.
- Redis: use Railway managed Redis. Set `REDIS_URL` from the service variables.
- Buckets: use Railway Buckets for all video storage.

## Required Environment Variables

### Core

- `DATABASE_URL`
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `PORT`
- `NODE_ENV`

### Queue

- `REDIS_URL`
- `WORKER_MAX_CONCURRENT_JOBS` (default 5)
- `WORKER_MAX_ATTEMPTS` (default 3)
- `WORKER_BACKOFF_DELAY_MS` (default 30000)
- `WORKER_LOCK_DURATION_MS` (default 900000)

### Buckets (Railway)

Prefer the `STORAGE_*` keys and map them to Railway Bucket values:

- `STORAGE_BUCKET`
- `STORAGE_REGION`
- `STORAGE_ENDPOINT`
- `STORAGE_ACCESS_KEY_ID`
- `STORAGE_SECRET_ACCESS_KEY`
- `STORAGE_PUBLIC_BASE_URL`
- `STORAGE_OBJECT_PREFIX` (default `generated`)

This backend also accepts Railway bucket keys directly (`RAILWAY_BUCKET_*`) if you prefer to keep Railway's defaults.

## Routing

- API should use the Railway private network for Postgres and Redis.
- Use Railway Buckets for video output (do not use volumes for media).

## Health Check

- `/health` verifies Postgres and Redis connectivity. Use it as the Railway health check.
