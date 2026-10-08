# Build stage: full dependencies (vite, react-router dev) to produce ./build.
FROM node:22-bookworm-slim AS build
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

# Runtime stage: production dependencies + build output only (no tests, fixtures, docs or local data).
# Debian (glibc), not Alpine (musl): on Render the Prisma query engine could not reach Neon from Alpine while
# prisma migrate could, so the runtime uses the standard glibc image Prisma is most tested on.
FROM node:22-bookworm-slim
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY server.js ./server.js
COPY prisma ./prisma
COPY app ./app
COPY scripts/maintenance.ts ./scripts/maintenance.ts
RUN npx prisma generate
USER node
EXPOSE 3000
# Web: `npm run docker-start` (migrations need DIRECT_DATABASE_URL = schema owner; the app runs as proofly_app).
# Scheduler (hourly): `npm run maintenance`.
CMD ["npm", "run", "docker-start"]
