# Builds the UI, then serves it with `vite preview` so the same Vite config (Manager proxy,
# Tailscale allowed hosts) applies in the container and in development.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY vite.config.ts tsconfig.json tsconfig.node.json ./
EXPOSE 18320
CMD ["npx", "vite", "preview"]
