## LinkMigo

LinkMigo「链密狗」是一款还算好看的资源下载工具

安装环境

```bash
npm install
```

启动项目（开发环境）

```bash
npm run dev
```

打包项目并运行

```bash
npm run build
npm run start
```


如果服务端访问 Instagram / TikTok / 抖音（短链接）等平台报“上游访问受限”，通常是 Node 服务端没有走代理。可以创建 `.env.local`：

```bash
SOCIAL_PROXY_URL=http://127.0.0.1:7890
```

也可以使用：

```bash
IG_PROXY_URL=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
ALL_PROXY=http://127.0.0.1:7890
```

资源下载后会先保存在本地缓存目录。默认保存路径是：

```bash
.cache/social-downloader
```

这是一个隐藏文件夹。如果需要指定为其他位置，可以在 `.env.local` 里配置：

```bash
SOCIAL_CACHE_DIR=downloads/social-downloader
```

默认情况下，解析出来的资源会在服务端缓存 2 小时，并由服务端定时清理过期缓存。可以在 `.env.local` 里调整缓存保存时长和轮询清理间隔，单位都是秒：

```bash
# 自定义「资源存放时长」和「轮询间隔时间」
# 资源存放时长（秒）
SOCIAL_CACHE_TTL_SECONDS=7200
# 轮询间隔时间「秒」
SOCIAL_CACHE_CLEANUP_INTERVAL_SECONDS=300
```

单个资源默认最多下载 512 MB。抖音长视频可能比 Instagram/TikTok/抖音 短视频更大，如果需要调整，可以配置字节数：

```bash
SOCIAL_MAX_ASSET_BYTES=536870912
```

改完环境变量后重启 dev server：

```bash
npm run dev
```
