FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build:web && npm prune --omit=dev
FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 18272
CMD ["node", "apps/gateway/main.mjs"]
