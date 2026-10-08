FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG SITE_URL=http://localhost:3000
ENV NODE_ENV=production
ENV ENABLE_AUTH=true
ENV SITE_URL=$SITE_URL
RUN npm run build:auth

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV ENABLE_AUTH=true
ENV PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY --from=build /app/src ./src
COPY --from=build /app/plugins ./plugins
COPY --from=build /app/scripts ./scripts
RUN mkdir -p /app/var && chown -R node:node /app

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["sh", "-c", "node scripts/db/bootstrap-runtime-role.mjs && node scripts/db/repair-runtime-ownership.mjs && node scripts/db/apply-schema.mjs && if [ \"${PROVISION_ROOT_USER:-false}\" = \"true\" ]; then NODE_ENV=development node scripts/db/provision-production-root.mjs; fi && exec npm run start:production"]
