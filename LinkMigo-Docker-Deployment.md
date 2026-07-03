# LinkMigo Docker 打包与 Compose 部署流程

这份文档说明如何把 LinkMigo 打包成一个完整 Docker 镜像，并提供 `compose.yaml`，让其他用户可以在 Docker、NAS、绿联 NAS Docker 项目等环境里直接拉取镜像并部署使用。

当前结论：

- LinkMigo 不需要数据库。
- LinkMigo 不需要 Redis、MySQL、PostgreSQL、MongoDB、SQLite 等额外服务。
- 推荐打包为一个单独 Docker 镜像。
- 推荐提供一个单服务 `compose.yaml`。
- 需要持久化的内容只有媒体缓存和日志。
- 建议镜像内安装 Chromium，增强 Instagram / Threads 等平台的渲染兜底能力。

## 1. 项目中需要新增或修改的文件

在项目根目录准备这些文件：

```text
linkmigo/
├─ Dockerfile              # 新建
├─ .dockerignore           # 新建
├─ compose.yaml            # 可选，新建，给用户部署用
├─ next.config.mjs         # 修改，增加 output: "standalone"
```

## 2. 修改 next.config.mjs

打开项目根目录下的：

```text
next.config.mjs
```

在 `nextConfig` 中加入：

```js
output: "standalone",
```

修改后的配置示例：

```js
const privateDevOrigins = [
  "0.0.0.0",
  "10.*.*.*",
  "192.168.*.*",
  "169.254.*.*",
  "*.local",
  ...Array.from({ length: 16 }, (_, index) => `172.${index + 16}.*.*`),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: privateDevOrigins,
  reactCompiler: true,
  output: "standalone",
};

export default nextConfig;
```

这一步的作用是让 Next.js 构建时生成 `.next/standalone` 目录，方便 Docker 镜像只复制生产运行所需文件。

## 3. 新建 .dockerignore

在项目根目录新建文件：

```text
.dockerignore
```

建议内容：

```dockerignore
node_modules
.next
.cache
logs
.git
.env
.env*
.DS_Store
docs
```

作用：

- 不把本地 `node_modules` 打进镜像。
- 不把本地构建产物 `.next` 打进镜像。
- 不把缓存 `.cache` 打进镜像。
- 不把日志 `logs` 打进镜像。
- 不把 `.env` 里的密钥、Cookie、代理配置打进镜像。

## 4. 新建 Dockerfile

在项目根目录新建文件：

```text
Dockerfile
```

推荐内容：

```dockerfile
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV SOCIAL_CACHE_DIR=/data/social-downloader
ENV CHROME_PATH=/usr/bin/chromium

RUN mkdir -p /data/social-downloader /app/logs && chown -R node:node /data /app/logs

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

USER node
EXPOSE 3000

CMD ["node", "server.js"]
```

说明：

- `deps` 阶段安装 npm 依赖。
- `builder` 阶段执行 `npm run build`。
- `runner` 阶段只保留生产运行需要的文件。
- `chromium` 是为 Instagram / Threads 等平台的渲染兜底解析准备的。
- `CHROME_PATH=/usr/bin/chromium` 用于明确告诉程序 Chromium 路径。
- `SOCIAL_CACHE_DIR=/data/social-downloader` 用于把媒体缓存放到可挂载目录。

## 5. 本地构建镜像

在项目根目录执行：

```bash
docker build -t linkmigo:local .
```

构建完成后，本地会得到镜像：

```text
linkmigo:local
```

## 6. 本地运行测试

在项目根目录执行：

```bash
docker run --rm \
  -p 3000:3000 \
  -v ./data/social-downloader:/data/social-downloader \
  -v ./logs:/app/logs \
  linkmigo:local
```

然后访问：

```text
http://localhost:3000
```

如果页面能正常打开，并且可以解析、预览、下载公开资源，说明镜像基本可用。

## 7. 新建 compose.yaml

如果要给绿联 NAS、普通 Docker Compose 用户或其他 NAS 用户使用，可以提供一个 `compose.yaml`。

文件名建议：

```text
compose.yaml
```

内容示例：

```yaml
services:
  linkmigo:
    image: ghcr.io/你的用户名/linkmigo:latest
    container_name: linkmigo
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      SOCIAL_CACHE_DIR: /data/social-downloader
      CHROME_PATH: /usr/bin/chromium
      SOCIAL_CACHE_TTL_SECONDS: "7200"
      SOCIAL_CACHE_CLEANUP_INTERVAL_SECONDS: "300"
      SOCIAL_MEDIA_TIMEOUT_SECONDS: "600"
      SOCIAL_RESOLVE_CONCURRENCY: "4"
      SOCIAL_XIAOHONGSHU_RESOLVE_CONCURRENCY: "1"
      SOCIAL_ASSET_DOWNLOAD_CONCURRENCY: "1"
      SOCIAL_PROFILE_ZIP_CONCURRENCY: "1"
      SOCIAL_MAX_ASSET_BYTES: "10737418240"
      SOCIAL_AUTO_SYSTEM_PROXY: "0"
      # SOCIAL_PROXY_URL: "http://host.docker.internal:7890"
      # SOCIAL_INSTAGRAM_COOKIE: "sessionid=...; ds_user_id=...; csrftoken=..."
      # SOCIAL_REDDIT_CLIENT_ID: "..."
      # SOCIAL_REDDIT_CLIENT_SECRET: "..."
      # SOCIAL_REDDIT_USER_AGENT: "web:linkmigo:0.1.0 (by /u/你的reddit用户名)"
    volumes:
      - ./data/social-downloader:/data/social-downloader
      - ./logs:/app/logs
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

如果镜像发布在 Docker Hub，把 `image` 改成：

```yaml
image: 你的dockerhub用户名/linkmigo:latest
```

如果镜像发布在 GitHub Container Registry，把 `image` 改成：

```yaml
image: ghcr.io/你的用户名/linkmigo:latest
```

## 8. 持久化目录说明

LinkMigo 当前不需要数据库，真正需要持久化的只有两个目录。

### 8.1 媒体缓存

容器内路径：

```text
/data/social-downloader
```

compose 挂载：

```yaml
- ./data/social-downloader:/data/social-downloader
```

用途：

- 保存解析后下载到服务端的图片、视频、音频等媒体缓存。
- 缓存默认会按 TTL 自动清理。

### 8.2 用户行为日志

容器内路径：

```text
/app/logs
```

compose 挂载：

```yaml
- ./logs:/app/logs
```

用途：

- 保存 `user-actions-YYYY-MM-DD.log` 日志文件。

## 9. 代理配置说明

Docker 容器通常读不到宿主机系统代理，所以如果用户需要访问 YouTube、Instagram、TikTok、Reddit 等平台，建议显式配置代理。

如果代理运行在宿主机或 NAS 上，可以尝试：

```yaml
environment:
  SOCIAL_PROXY_URL: "http://host.docker.internal:7890"
```

并保留：

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

如果 NAS 环境不支持 `host-gateway`，则需要把 `SOCIAL_PROXY_URL` 改成 NAS 局域网 IP，例如：

```yaml
SOCIAL_PROXY_URL: "http://192.168.1.10:7890"
```

## 10. 发布多架构镜像

为了兼容普通 x86 服务器和 ARM NAS，建议发布多架构镜像。

如果使用 GitHub Container Registry：

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/你的用户名/linkmigo:latest \
  -t ghcr.io/你的用户名/linkmigo:0.1.0 \
  --push .
```

如果使用 Docker Hub：

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t 你的dockerhub用户名/linkmigo:latest \
  -t 你的dockerhub用户名/linkmigo:0.1.0 \
  --push .
```

## 11. 给最终用户的部署方式

用户只需要：

1. 在绿联 NAS 或其他 NAS 的 Docker 管理器里新建项目。
2. 粘贴 `compose.yaml`。
3. 把 `image` 改成实际发布的镜像地址。
4. 按需填写代理、Instagram Cookie、Reddit OAuth 等环境变量。
5. 启动项目。
6. 访问：

```text
http://NAS_IP:3000
```

例如：

```text
http://192.168.1.10:3000
```

## 12. 最终结论

LinkMigo 可以做成一个完整的 Docker 镜像，并通过单服务 `compose.yaml` 部署。

不需要额外数据库，也不需要额外 Redis。

推荐最终方案：

- 一个镜像：`linkmigo`
- 一个服务：`linkmigo`
- 一个端口：`3000`
- 两个挂载目录：
  - `./data/social-downloader:/data/social-downloader`
  - `./logs:/app/logs`
- 镜像内安装 Chromium
- 镜像内使用 Next.js standalone 产物运行
