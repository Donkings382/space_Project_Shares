# SpaceX backend logic

This backend is a real server-side foundation for the SpaceX investment platform. It is designed to replace the current front-end-only localStorage implementation and provide secure, production-oriented APIs.

## Included

- PostgreSQL via Prisma ORM
- JWT-based server-side authentication
- Role-based authorization with `USER` and `ADMIN`
- Encrypted sensitive fields for account and 401(k)-related data
- Paystack integration scaffolding for verified subscription plans
- KYC document validation with OCR and document rejection logic
- Admin-only access routes for sensitive user data
- Deployment-safe configuration without hardcoded production domains

## Quick start

1. Install dependencies:
   npm install
2. Copy environment file:
   cp .env.example .env
3. Create PostgreSQL database and update `DATABASE_URL`
4. Run Prisma migration:
   npx prisma migrate dev --name init
5. Start the API:
   npm run dev

## Important security rules

- The backend enforces JWT auth on protected endpoints.
- User data must be decrypted only by the owner or by a privileged admin route.
- Admin access is intentionally restricted to admin-only endpoints and UI access.
- Domain values should remain unset until deployment; set `APP_DOMAIN` only after the production domain exists.

## Default roles

- `USER`
- `ADMIN`

## Admin-only endpoints

- `GET /api/admin/dashboard`
- `GET /api/admin/users`
- `GET /api/admin/users/:id`
- `GET /api/admin/users/:id/sensitive`
- `POST /api/plans`

## Notes

This implementation is a secure backend foundation and should be connected to the front-end files in the `spaceX project` folder after deployment.
