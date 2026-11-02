FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates tar \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY bin ./bin

ENV SPEICHER_MIRROR_ROOT=/var/lib/speicher/mirrors \
    SPEICHER_ASSET_PATH=/var/lib/speicher/assets
VOLUME ["/var/lib/speicher"]

ENV SPEICHER_CONFIG_SOURCE=database

ENV SPEICHER_LOG_FORMAT=pretty

RUN ln -s /app/bin/speicher /usr/local/bin/speicher

RUN useradd --system --uid 10001 --home /app speicher \
  && mkdir -p /var/lib/speicher \
  && chown -R speicher:speicher /app /var/lib/speicher
USER speicher

EXPOSE 3000

CMD ["node", "dist/main.js"]
