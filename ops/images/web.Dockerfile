FROM node:24-bookworm-slim AS build
RUN npm install --global pnpm@11.3.0
WORKDIR /src
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend ./
RUN pnpm build

FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY ops/images/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 8080
