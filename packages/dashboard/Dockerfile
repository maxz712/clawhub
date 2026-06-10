# Build context for this image is the monorepo root, NOT the dashboard dir —
# otherwise the workspace lockfile + sibling manifests aren't available.
#   docker build -f packages/dashboard/Dockerfile .

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat

FROM base AS deps
WORKDIR /app

# Workspace root files + every workspace manifest declared in package.json
# (npm install hard-fails on any missing workspace manifest).
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/api/package.json packages/api/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/skill/package.json packages/skill/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
COPY packages/runner/package.json packages/runner/
COPY packages/ide-vscode/package.json packages/ide-vscode/
COPY packages/mobile/package.json packages/mobile/

RUN npm install --ignore-scripts --workspace @clawhub/dashboard --include-workspace-root

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/dashboard/node_modules ./packages/dashboard/node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/dashboard/ packages/dashboard/

# NEXT_PUBLIC_* values are inlined at build time — pass the public API URL in
# as a build arg (compose wires CLAWHUB_PUBLIC_URL through).
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL

RUN npm -w @clawhub/dashboard run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Next.js standalone bundle includes its own minimal node_modules + server.js
# (at packages/dashboard/server.js because outputFileTracingRoot is the repo root).
COPY --from=builder --chown=nextjs:nodejs /app/packages/dashboard/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/packages/dashboard/.next/static ./packages/dashboard/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/packages/dashboard/public ./packages/dashboard/public

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "packages/dashboard/server.js"]
