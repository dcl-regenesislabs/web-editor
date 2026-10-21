FROM node:24-alpine AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/service/package.json ./packages/service/
COPY packages/contract/package.json ./packages/contract/
COPY packages/mobile-preview/package.json ./packages/mobile-preview/
RUN npm ci --workspace @dcl-editor/service --include-workspace-root=false --omit=dev --ignore-scripts --no-audit \
    && mkdir -p packages/service/node_modules packages/contract/node_modules \
    && npm cache clean --force

FROM node:24-alpine

# the release tag, reported by /health so a deploy can be checked
ARG SERVICE_VERSION=
ENV SERVICE_VERSION=$SERVICE_VERSION
ENV NODE_ENV=production \
    HTTP_SERVER_HOST=0.0.0.0 \
    HTTP_SERVER_PORT=8787 \
    STORAGE_DIR=/data/projects

RUN apk add --no-cache tini \
    && mkdir -p /data/projects \
    && chown -R node:node /data

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/packages/service/node_modules ./packages/service/node_modules
COPY --from=dependencies /app/packages/contract/node_modules ./packages/contract/node_modules
COPY packages/service/package.json packages/service/dev-server.ts ./packages/service/
COPY packages/service/src ./packages/service/src
COPY packages/service/skills ./packages/service/skills
COPY packages/service/scripts/healthcheck.mjs ./packages/service/scripts/healthcheck.mjs
COPY packages/contract/package.json ./packages/contract/
COPY packages/contract/src ./packages/contract/src
COPY packages/mobile-preview ./packages/mobile-preview
RUN node packages/mobile-preview/scripts/build.mjs \
    && node packages/mobile-preview/scripts/check-dist.mjs

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "packages/service/scripts/healthcheck.mjs"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--trace-warnings", "--unhandled-rejections=strict", "packages/service/dev-server.ts"]
