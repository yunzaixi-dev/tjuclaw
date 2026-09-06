FROM node:24-bookworm-slim AS build
RUN npm install --global pnpm@11.3.0
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json frontend/package.json
COPY docs/package.json docs/package.json
RUN pnpm install --frozen-lockfile --filter @tjuclaw/client...
COPY frontend ./frontend
RUN pnpm --filter @tjuclaw/client build

FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY ops/images/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/frontend/dist /usr/share/nginx/html
EXPOSE 8080
