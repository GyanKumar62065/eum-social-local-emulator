FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY ui ./ui
COPY tsconfig.json ./
RUN npm run ui:build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production EUM_DB=/data/eum-local.db EUM_CONFIG=/etc/eum-local/eum-local.yaml
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY models ./models
COPY --from=build /app/ui/dist ./ui/dist
COPY eum-local.example.yaml /etc/eum-local/eum-local.yaml
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4580
VOLUME /data
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:4580/_eum/health || exit 1
CMD ["node", "src/main.ts"]
