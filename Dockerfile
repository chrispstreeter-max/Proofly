# Build stage: full dependencies (vite, react-router dev) to produce ./build.
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

# Runtime stage: production dependencies + build output only (no tests, fixtures, docs or local data).
FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY prisma ./prisma
COPY app ./app
COPY scripts/maintenance.ts ./scripts/maintenance.ts
RUN npx prisma generate
USER node
EXPOSE 3000
# Web: `npm run docker-start` (migrations need DIRECT_DATABASE_URL = schema owner; the app runs as proofly_app).
# Scheduler (hourly): `npm run maintenance`.
CMD ["npm", "run", "docker-start"]
