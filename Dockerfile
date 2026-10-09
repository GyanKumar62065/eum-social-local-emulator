FROM oven/bun:1.3.12-alpine AS production-deps
# The versioned Bun base image can lag Alpine security updates.
RUN apk upgrade --no-cache
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM production-deps AS build
RUN bun install --frozen-lockfile
COPY ui ./ui
COPY tsconfig.json ./
RUN bun run ui:build

FROM node:24-alpine
# Apply Alpine security updates to the shipped runtime image as well.
RUN apk upgrade --no-cache
WORKDIR /app
ENV NODE_ENV=production EUM_DB=/data/eum-local.db EUM_CONFIG=/etc/eum-social-local-emulator/eum-social-local-emulator.yaml
COPY package.json ./
COPY --from=production-deps /app/node_modules ./node_modules
COPY src ./src
COPY models ./models
COPY --from=build /app/ui/dist ./ui/dist
COPY eum-social-local-emulator.example.yaml /etc/eum-social-local-emulator/eum-social-local-emulator.yaml
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4580
VOLUME /data
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:4580/_eum/health || exit 1
CMD ["node", "src/main.ts"]
