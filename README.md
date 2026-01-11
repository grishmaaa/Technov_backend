# TechNovAI Engine Backend

Complete Node.js + Express + PostgreSQL backend for AI video generation SaaS.

## Features

✅ JWT Authentication (Access + Refresh tokens)
✅ User Management (Roles, Plans, Credits)
✅ Project CRUD (with ownership validation)
✅ Scene Management (nested under projects)
✅ Generation Job System (async-ready)
✅ Scene-to-video pipeline (single high-quality render per scene with post-processing)
✅ Admin Panel (user/credit/plan management)
✅ Production-ready (error handling, rate limiting, security)

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** PostgreSQL (via Prisma ORM)
- **Auth:** JWT (jsonwebtoken + bcryptjs)
- **Security:** Helmet, CORS, Rate Limiting
- **Queue:** BullMQ + Redis
- **Storage:** Railway Buckets / S3-compatible

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create `.env` file:

```env
DATABASE_URL="postgresql://user:password@host:5432/dbname"
JWT_SECRET="your-super-secret-jwt-key"
JWT_REFRESH_SECRET="your-super-secret-refresh-key"
JWT_EXPIRES_IN="15m"
JWT_REFRESH_EXPIRES_IN="7d"
PORT=8000
NODE_ENV="development"
CORS_ORIGIN="http://localhost:8080"
KLING_API_KEY="your-kling-key"
CLIP_SCORE_ENDPOINT="https://your-domain.com/api/clip-score"
CLIP_SCORE_API_KEY="optional-shared-secret"
CLIP_SCORE_MODE="basic"
LUT_PATH="/data/luts/cinematic.cube"
DEFAULT_ASPECT_RATIO="16:9"
DEFAULT_FPS=24
REDIS_URL="redis://user:pass@host:6379"
WORKER_MAX_CONCURRENT_JOBS=5
WORKER_MAX_ATTEMPTS=3
WORKER_BACKOFF_DELAY_MS=30000
WORKER_LOCK_DURATION_MS=900000
LOG_LEVEL="info"
STORAGE_BUCKET="your-bucket"
STORAGE_REGION="us-east-1"
STORAGE_ENDPOINT="https://your-railway-bucket-endpoint"
STORAGE_ACCESS_KEY_ID="your-access-key"
STORAGE_SECRET_ACCESS_KEY="your-secret-key"
STORAGE_PUBLIC_BASE_URL="https://your-railway-bucket-public-url"
STORAGE_OBJECT_PREFIX="generated"
```

### Railway Buckets (S3-Compatible)

Railway Buckets provide S3-compatible credentials. This backend reads either `STORAGE_*` env vars or Railway's injected bucket vars (when present). Recommended on Railway:

- Use Buckets for video storage (do not store video files on Volumes).
- Use Managed Postgres + Redis with private networking.

If Railway injects bucket vars, you can map them in Railway or set `STORAGE_*` explicitly.

See `RAILWAY.md` and `.env.railway.example` for Railway-specific setup.

Supported storage env keys (first match wins):

- `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_PUBLIC_BASE_URL`, `STORAGE_OBJECT_PREFIX`
- `RAILWAY_BUCKET_NAME`, `RAILWAY_BUCKET_REGION`, `RAILWAY_BUCKET_ENDPOINT`, `RAILWAY_BUCKET_ACCESS_KEY_ID`, `RAILWAY_BUCKET_SECRET_ACCESS_KEY`, `RAILWAY_BUCKET_PUBLIC_BASE_URL`, `RAILWAY_BUCKET_OBJECT_PREFIX`
- `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_PUBLIC_BASE_URL`

### 3. Database Setup

Push the schema to your database:

```bash
npm run db:push
```

Or run migrations:

```bash
npm run db:migrate
```

### 4. Start Development Server

```bash
npm run dev
```

Server runs on `http://localhost:8000`

### 5. Start Worker (Required for Generation)

```bash
npm run worker
```

## API Endpoints

### Authentication (`/auth`)

- `POST /auth/register` - Register new user
- `POST /auth/login` - Login user
- `POST /auth/logout` - Logout user
- `POST /auth/refresh` - Refresh access token
- `GET /auth/me` - Get current user (protected)

### Projects (`/projects`)

- `POST /projects` - Create project
- `GET /projects` - List user's projects
- `GET /projects/:id` - Get project details
- `GET /projects/:id/factory` - Get nested scenes and shots
- `PUT /projects/:id` - Update project
- `DELETE /projects/:id` - Delete project

### Scenes (`/api/projects/:id/scenes`)

- `POST /api/projects/:projectId/scenes` - Add scene to project
- `GET /api/projects/:projectId/scenes` - List project scenes
- `PUT /api/scenes/:sceneId` - Update scene
- `DELETE /api/scenes/:sceneId` - Delete scene

### Generation Jobs (`/api/projects/:id`)

- `POST /api/projects/:id/generate` - Start video generation
- `GET /api/projects/:id/status` - Check generation status

### Storage (`/api/storage`)

- `POST /api/storage/presign` - Get a presigned upload URL

### Clip Scoring (`/api/clip-score`)

- `POST /api/clip-score` - Score a video clip (multipart `file`, optional `prompt`)

### Admin (`/admin`) (requires admin role)

- `GET /admin/users` - List all users
- `PUT /admin/users/:userId/credits` - Update user credits
- `PUT /admin/users/:userId/plan` - Update user plan

## Deployment (Railway)

1. Push your code to GitHub
2. Connect Railway to your repository
3. Add environment variables in Railway dashboard
4. Railway will auto-deploy using `railway.json` config
5. Create a separate Railway service that runs `npm run worker`
6. Run migrations on deploy: `npx prisma migrate deploy` (or `npx prisma db push` for quick sync)

## Database Schema

- **Users**: id, email, password, role, plan, credits
- **Projects**: id, userId, title, description, status, finalVideoUrl, qualityTier, aspectRatio, fps
- **Scenes**: id, projectId, orderIndex, promptText, duration, status, videoUrl
- **Shots**: id, sceneId, orderIndex, duration, prompt, status, selectedVariantId
- **ShotVariants**: id, shotId, variantIndex, status, videoUrl, clipScore, totalScore (legacy placeholder; single-shot pipeline only)
- **GenerationJobs**: id, projectId, status, progress, outputUrl
- **RefreshTokens**: id, userId, token, expiresAt

## Security Features

- Password hashing with bcrypt
- JWT-based authentication
- Refresh token rotation
- Rate limiting (100 req/15min general, 5 req/15min for auth)
- Helmet security headers
- CORS protection
- Input validation
- Error handling

## Credit System

- Users start with 100 credits
- Basic quality costs 10 credits per scene
- Cinematic quality costs 20 credits per scene
- Admin can adjust credits
- Plans: basic (default), elite

## License

MIT
