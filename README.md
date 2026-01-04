# AI Cinema Engine Backend

Complete Node.js + Express + PostgreSQL backend for AI video generation SaaS.

## Features

✅ JWT Authentication (Access + Refresh tokens)
✅ User Management (Roles, Plans, Credits)
✅ Project CRUD (with ownership validation)
✅ Scene Management (nested under projects)
✅ Generation Job System (async-ready)
✅ Admin Panel (user/credit/plan management)
✅ Production-ready (error handling, rate limiting, security)

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** PostgreSQL (via Prisma ORM)
- **Auth:** JWT (jsonwebtoken + bcryptjs)
- **Security:** Helmet, CORS, Rate Limiting

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
```

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

### Admin (`/admin`) (requires admin role)

- `GET /admin/users` - List all users
- `PUT /admin/users/:userId/credits` - Update user credits
- `PUT /admin/users/:userId/plan` - Update user plan

## Deployment (Railway)

1. Push your code to GitHub
2. Connect Railway to your repository
3. Add environment variables in Railway dashboard
4. Railway will auto-deploy using `railway.json` config

## Database Schema

- **Users**: id, email, password, role, plan, credits
- **Projects**: id, userId, title, description, status, finalVideoUrl
- **Scenes**: id, projectId, orderIndex, promptText, duration, status, videoUrl
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
- Generation costs 10 credits per scene
- Admin can adjust credits
- Plans: basic (default), elite

## License

MIT
