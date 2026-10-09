# Builds the UI, then runs the Node server: it serves the built UI, collects CLIProxyAPI usage into
# SQLite (/data), and answers the analytics API. The server is TypeScript run with Node's built-in
# type stripping and has no runtime npm dependencies.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=18320 \
    DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 18320
VOLUME ["/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
