## LinkMigo

LinkMigo「链密狗」是一款还算好看的资源下载工具。

目前支持 Instagram、TikTok、抖音、小红书、快手、AcFun、Twitter/X、Bilibili、Facebook、Pinterest、YouTube 和 Pornhub 的公开视频资源解析。
YouTube、Bilibili、AcFun 和 Pornhub 会优先选择公开页面可返回的高质量视频资源，并在需要时由服务端合并或转封装后返回可直接播放的单个视频文件。

安装环境

```bash
npm install
```

启动项目（开发环境）

```bash
npm run dev
```

开发服务会监听所有本机网卡，既可以用 `http://localhost:3000` 访问，也可以在同一局域网用 `http://<本机 IP>:3000` 访问。

打包项目并运行

```bash
npm run build
npm run start
```


服务端会优先使用电脑当前网络环境直接访问外网。如果 VPN 是全局路由 / TUN 模式，通常不需要额外配置；如果 VPN 客户端是系统代理模式，服务端会在没有手动代理环境变量时自动读取系统 HTTP / HTTPS / SOCKS5 代理。

如果服务端访问 Instagram / TikTok / 抖音 / 小红书 / 快手 / AcFun / Pinterest / YouTube / Pornhub 等平台报“上游访问受限”，可以创建 `.env.local` 手动指定代理，这会覆盖系统代理探测结果：

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

如果不想自动读取系统代理，可以在 `.env.local` 里关闭：

```bash
SOCIAL_AUTO_SYSTEM_PROXY=0
```

如果 VPN 使用 PAC 自动代理脚本，而不是明确的系统 HTTP / HTTPS / SOCKS5 代理端口，Node 服务端可能无法解析 PAC，仍建议手动配置 `SOCIAL_PROXY_URL`。

资源下载后会先保存在本地缓存目录。默认保存路径是：

```bash
.cache/social-downloader
```

这是一个隐藏文件夹。如果需要指定为其他位置，可以在 `.env.local` 里配置：

```bash
SOCIAL_CACHE_DIR=downloads/social-downloader
```

默认情况下，解析出来的资源会在服务端缓存 2 小时，并由服务端定时清理过期缓存。可以在 `.env.local` 里调整缓存保存时长、轮询清理间隔和媒体下载超时，单位都是秒：

```bash
# 自定义「资源存放时长」和「轮询间隔时间」
# 资源存放时长（秒）
SOCIAL_CACHE_TTL_SECONDS=7200
# 轮询间隔时间「秒」
SOCIAL_CACHE_CLEANUP_INTERVAL_SECONDS=300
# 媒体文件下载超时「秒」
SOCIAL_MEDIA_TIMEOUT_SECONDS=600
```

单个资源默认最多下载 512 MB。抖音、快手、AcFun 长视频可能比 Instagram/TikTok/抖音 短视频更大，如果需要调整，可以配置字节数：

```bash
SOCIAL_MAX_ASSET_BYTES=536870912
```

改完环境变量后重启 dev server：

```bash
npm run dev
```
