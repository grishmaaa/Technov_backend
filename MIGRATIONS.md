# Database Migrations

Run these steps locally and in Railway after pulling new schema changes.

## Local

```bash
npx prisma generate
npx prisma migrate dev --name video-factory
```

## Railway

```bash
npx prisma generate
npx prisma migrate deploy
```

If you are not using migrations yet, you can do a one-time schema sync:

```bash
npx prisma db push
```
