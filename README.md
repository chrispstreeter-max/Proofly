# Proofly

**Proofly** is a Shopify App Store app for product reviews: bring your existing reviews with you, manage them in one
place, and display them beautifully across your store.

> Status: commercial repository **baseline**. The multi-tenant refactor has not started; nothing is deployed, installed
> or connected to a Shopify store. See [docs/BASELINE.md](docs/BASELINE.md).

- Brand: [docs/BRAND.md](docs/BRAND.md)
- Product spec (V1): [docs/PRODUCT-SPEC-V1.md](docs/PRODUCT-SPEC-V1.md)
- Architecture: [docs/PROOFLY-ARCHITECTURE.md](docs/PROOFLY-ARCHITECTURE.md)
- Roadmap / checkpoints: [docs/PUBLIC-APP-ROADMAP.md](docs/PUBLIC-APP-ROADMAP.md)

## Local development

```bash
npm install
cp .env.example .env                    # fill local values
./scripts/db.sh start                   # project-local Postgres on :54330
npx prisma migrate deploy
set -a; . ./.env; set +a; npx react-router dev --port 3000
```

## Checks (also run in CI)

```bash
npm run typecheck && npm run lint && npm run build
npm run fixtures:generate && npm run fixtures:check   # synthetic, fictional dataset — no real merchant data
npm run scan:merchant-data                            # fails if merchant/customer data could ship
```

Real merchant datasets never live in this repository. Authorised local testing against a private dataset uses files
outside the repo and, optionally, a private hashed denylist (`PROOFLY_PRIVATE_DENYLIST`).
