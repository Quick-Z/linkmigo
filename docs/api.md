# LinkMigo API 文档

本文档说明 LinkMigo 当前对外可调用的 HTTP API。项目目前是 Next.js 全栈应用，API 路径中的 `instagram` 是历史兼容命名；实际解析能力由服务端统一识别链接平台，支持 README 中列出的多个公开平台，例如小红书、抖音、TikTok、Instagram、YouTube、Bilibili 等。

## 基础约定

- 基础地址：`http://<你的 LinkMigo 服务地址>:3000`
- 请求体：除下载类接口外，均使用 `Content-Type: application/json`
- 鉴权：当前项目未内置 API Key 或登录鉴权；如果部署到公网，建议在反向代理层或后续公共 API 层增加鉴权和限流。
- 下载地址：轮询接口返回的 `preview_url`、`download_url` 是相对路径，调用方需要拼接基础地址；回调通知里的资源地址会优先转成完整 URL。
- 缓存时效：解析结果和下载资源会缓存到服务端，`expires_at` 表示过期时间；过期后需重新提交解析。
- 公网地址配置：如果服务部署在反向代理后，建议设置 `SOCIAL_PUBLIC_BASE_URL=https://你的域名`，用于回调通知生成完整下载地址。

通用错误响应：

| 字段名 | 类型 | 是否必有 | 说明 |
| --- | --- | --- | --- |
| `error` | object | 是 | 错误对象 |
| `error.code` | string | 是 | 错误码，例如 `INVALID_JSON`、`UNSUPPORTED_URL`、`NO_MEDIA_FOUND`、`CACHE_EXPIRED`、`UPSTREAM_BLOCKED` |
| `error.message` | string | 是 | 可展示给用户的错误信息 |
| `error.details` | string/object | 否 | 调试信息或上游错误细节 |

## 推荐调用顺序

### 异步解析 + 轮询

适合前端页面或外部服务主动查询进度。

1. 调用 `POST /api/v1/instagram/resolve/jobs` 创建任务。
2. 保存返回的 `job_id`。
3. 定时调用 `GET /api/v1/instagram/resolve/jobs/{job_id}` 查询状态和进度。
4. 当 `status` 为 `completed` 时，读取 `result.assets`。
5. 使用 `download_url` 下载单个资源，或使用 `download.zip` 打包下载。

### 异步解析 + 回调通知

适合其他后端项目集成，减少轮询请求。

1. 调用 `POST /api/v1/instagram/resolve/jobs` 时传入 `callback_url`。
2. LinkMigo 立即返回 `job_id`，任务继续在后台执行。
3. 任务 `completed` 或 `failed` 后，LinkMigo 会向 `callback_url` 发送 `POST` 通知。
4. 如果回调失败，LinkMigo 最多尝试 3 次；调用方仍可用 `job_id` 继续轮询兜底。

回调请求头：

| 请求头 | 类型 | 说明 |
| --- | --- | --- |
| `Content-Type` | string | 固定为 `application/json` |
| `User-Agent` | string | 固定为 `LinkMigo-Callback/1.0` |
| `X-LinkMigo-Event` | string | `resolve_job.completed` 或 `resolve_job.failed` |
| `X-LinkMigo-Job-Id` | string | 任务 ID |
| `X-LinkMigo-Job-Status` | string | `completed` 或 `failed` |

回调请求体：

| 字段名 | 类型 | 是否必有 | 说明 |
| --- | --- | --- | --- |
| `event` | string | 是 | 事件名，`resolve_job.completed` 或 `resolve_job.failed` |
| `job_id` | string | 是 | 任务 ID |
| `platform` | string | 是 | 平台标识，例如 `xiaohongshu` |
| `status` | string | 是 | 任务状态，`completed` 或 `failed` |
| `phase` | string | 是 | 任务阶段 |
| `progress` | object | 是 | 进度对象，字段同任务查询接口 |
| `result` | object/null | 是 | 成功时为解析结果，失败时为 `null` |
| `error` | object/null | 是 | 失败时为错误对象，成功时为 `null` |
| `created_at` | string | 是 | ISO 时间字符串，任务创建时间 |
| `updated_at` | string | 是 | ISO 时间字符串，任务更新时间 |

调用方的回调接口返回 2xx 状态码即视为成功；非 2xx、网络错误或 10 秒超时会触发重试。

## API 列表

### 1. 创建异步解析任务

`POST /api/v1/instagram/resolve/jobs`

功能：提交一个公开帖子/视频/图文链接，服务端后台解析并缓存资源。支持可选回调通知；不传 `callback_url` 时继续使用轮询。

入参：

| 字段名 | 类型 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 公开帖子、视频、图文、音频或主页链接，长度 1-2048 |
| `callback_url` | string | 否 | 任务完成或失败后的通知地址，仅支持 `http`/`https`，长度不超过 2048 |

请求示例：

```bash
curl -X POST http://localhost:3000/api/v1/instagram/resolve/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.xiaohongshu.com/explore/xxxx",
    "callback_url": "https://example.com/webhooks/linkmigo"
  }'
```

出参：

| 字段名 | 类型 | 是否必有 | 说明 |
| --- | --- | --- | --- |
| `job_id` | string | 是 | 任务 ID，用于后续轮询 |
| `platform` | string | 是 | 从链接识别出的平台；无法识别时为空字符串 |
| `status` | string | 是 | `queued`、`running`、`completed`、`failed` |
| `phase` | string | 是 | `queued`、`resolving`、`preparing_download`、`downloading`、`completed`、`failed` 等 |
| `progress` | object | 是 | 当前进度 |
| `result` | object/null | 是 | 创建时通常为 `null`；任务完成后才有结果 |
| `error` | object/null | 是 | 失败时的错误对象 |
| `callback` | object/null | 是 | 传了 `callback_url` 时存在，描述回调投递状态 |
| `queue_position` | number/null | 是 | 排队位置；运行中为 `null` |
| `created_at` | string | 是 | ISO 时间字符串 |
| `updated_at` | string | 是 | ISO 时间字符串 |

`progress` 字段：

| 字段名 | 类型 | 是否必有 | 说明 |
| --- | --- | --- | --- |
| `mode` | string | 是 | `indeterminate` 表示暂时无法计算百分比，`percent` 表示可计算百分比 |
| `phase` | string | 是 | 当前阶段 |
| `percent` | number/null | 是 | 0-100，未知时为 `null` |
| `downloaded_bytes` | number | 是 | 已下载字节数 |
| `total_bytes` | number/null | 是 | 总字节数，未知时为 `null` |
| `asset_index` | number/null | 是 | 当前资源序号或已完成数量 |
| `asset_count` | number/null | 是 | 资源总数 |

`callback` 字段：

| 字段名 | 类型 | 是否必有 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 回调通知地址 |
| `status` | string | 是 | `pending`、`sending`、`retrying`、`succeeded`、`failed` |
| `attempt_count` | number | 是 | 已尝试次数 |
| `last_error` | string/null | 是 | 最近一次回调失败原因 |
| `notified_at` | string/null | 是 | 最终成功或最终失败的时间 |

### 2. 查询异步任务状态

`GET /api/v1/instagram/resolve/jobs/{job_id}`

功能：查询任务状态、进度、结果和回调投递状态。前端进度条就是从这个接口的 `progress` 字段渲染。

路径参数：

| 字段名 | 类型 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `job_id` | string | 是 | 创建任务接口返回的任务 ID |

请求示例：

```bash
curl http://localhost:3000/api/v1/instagram/resolve/jobs/abc123
```

出参：同“创建异步解析任务”。当 `status=completed` 时，`result` 为解析结果；当 `status=failed` 时，`error` 为错误对象。

`result` 普通帖子结果：

| 字段名 | 类型 | 是否必有 | 说明 |
| --- | --- | --- | --- |
| `request_id` | string | 是 | 缓存请求 ID，用于下载资源 |
| `canonical_url` | string | 是 | 规范化后的原始链接 |
| `shortcode` | string | 是 | 平台内帖子/内容标识 |
| `kind` | string | 是 | 内容类型，例如 `note`、`post`、`video` |
| `platform` | string | 是 | 平台标识 |
| `creator_handle` | string | 是 | 作者账号标识，可能为空 |
| `assets` | array | 是 | 可下载资源列表 |
| `metrics` | object | 是 | 点赞、评论、播放等公开指标；不同平台字段可能不同 |
| `post_info` | object | 是 | 标题、正文、作者、标签等公开帖子信息 |
| `expires_at` | string | 是 | 缓存过期时间 |

`assets[]` 字段：

| 字段名 | 类型 | 是否必有 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 资源 ID，例如 `asset-1` |
| `media_type` | string | 是 | `image`、`video`、`audio` 等 |
| `filename` | string | 是 | 建议下载文件名 |
| `content_type` | string | 是 | MIME 类型 |
| `size_bytes` | number | 是 | 文件大小，单位字节 |
| `width` | number/null | 是 | 图片/视频宽度 |
| `height` | number/null | 是 | 图片/视频高度 |
| `preview_url` | string | 是 | 预览地址 |
| `download_url` | string | 是 | 单资源下载地址 |

`result` Instagram 主页结果：

| 字段名 | 类型 | 是否必有 | 说明 |
| --- | --- | --- | --- |
| `mode` | string | 是 | 固定为 `profile` |
| `request_id` | string | 是 | 主页缓存请求 ID |
| `platform` | string | 是 | 固定为 `instagram` |
| `profile` | object | 是 | 主页资料 |
| `posts` | array | 是 | 可选帖子列表 |
| `expires_at` | string | 是 | 缓存过期时间 |

### 3. 同步解析

`POST /api/v1/instagram/resolve`

功能：同步解析并下载资源，直接返回结果。适合短任务或内部调用；对小红书、YouTube 等耗时任务，推荐使用异步任务接口。

入参：

| 字段名 | 类型 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 公开帖子、视频、图文或音频链接，长度 1-2048 |

出参：成功时直接返回“查询异步任务状态”中的 `result` 对象；失败时返回通用错误响应。

### 4. 预览单个资源

`GET /api/v1/instagram/requests/{request_id}/assets/{asset_id}/preview`

功能：以内联方式返回图片、视频或音频资源，支持 `Range` 请求，适合前端预览。

路径参数：

| 字段名 | 类型 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `request_id` | string | 是 | 解析结果里的 `request_id` |
| `asset_id` | string | 是 | 资源 ID，例如 `asset-1` |

请求头：

| 请求头 | 类型 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `Range` | string | 否 | 字节范围，例如 `bytes=0-1048575`，用于视频/音频分段预览 |

出参：成功时返回二进制文件流；响应头包含 `Content-Type`、`Content-Length`、`Content-Disposition: inline`、`Accept-Ranges: bytes`。

### 5. 下载单个资源

`GET /api/v1/instagram/requests/{request_id}/assets/{asset_id}/download`

功能：以附件方式下载单个资源。

路径参数：

| 字段名 | 类型 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `request_id` | string | 是 | 解析结果里的 `request_id` |
| `asset_id` | string | 是 | 资源 ID，例如 `asset-1` |

出参：成功时返回二进制文件流；响应头包含 `Content-Type`、`Content-Length`、`Content-Disposition: attachment`。

### 6. 打包下载帖子资源

`GET /api/v1/instagram/requests/{request_id}/download.zip`

功能：把某次解析得到的资源打包成 zip 下载。

路径参数：

| 字段名 | 类型 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `request_id` | string | 是 | 解析结果里的 `request_id` |

查询参数：

| 字段名 | 类型 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `asset_ids` | string | 否 | 逗号分隔的资源 ID；不传表示打包全部资源，例如 `asset-1,asset-3` |

请求示例：

```bash
curl -L -o assets.zip "http://localhost:3000/api/v1/instagram/requests/REQ_ID/download.zip?asset_ids=asset-1,asset-3"
```

出参：成功时返回 `application/zip` 文件流。

### 7. 打包下载 Instagram 主页帖子

`POST /api/v1/instagram/profile-requests/{request_id}/download.zip`

功能：Instagram 主页解析结果专用，把选中的主页帖子资源解析后打包下载。

路径参数：

| 字段名 | 类型 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `request_id` | string | 是 | 主页解析结果里的 `request_id` |

入参：

| 字段名 | 类型 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `post_ids` | array<string> | 否 | 要打包的帖子 ID 列表；不传或空数组表示全部 |

出参：成功时返回 `application/zip` 文件流。

### 8. 获取评论快照

`POST /api/v1/instagram/comments`

功能：获取公开页面可解析到的评论快照。当前支持的平台取决于 `comments` 模块内的解析器，例如 Instagram、小红书、Bilibili、Reddit、V2EX、小宇宙、YouTube；不支持的平台会返回空的公开快照。

入参：

| 字段名 | 类型 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 公开帖子或内容链接，长度 1-2048 |
| `cursor` | string | 否 | 分页游标，使用上次响应的 `next_cursor` |
| `limit` | number | 否 | 希望返回的评论数量；具体上限由平台解析器决定 |

出参：

| 字段名 | 类型 | 是否必有 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | 平台标识 |
| `shortcode` | string | 是 | 内容标识 |
| `canonical_url` | string | 是 | 规范化链接 |
| `comments` | array | 是 | 评论列表；字段随平台可能略有差异 |
| `next_cursor` | string/null | 是 | 下一页游标 |
| `has_more` | boolean | 是 | 是否还有下一页 |
| `total_count` | number/null | 是 | 平台公开的总评论数，未知时为 `null` |
| `public_count` | number | 是 | 本次公开快照里的评论数 |
| `is_partial_public_snapshot` | boolean | 是 | 是否只是公开页面可见的部分评论 |
| `source` | string | 是 | 数据来源标识 |

### 9. 代理 Instagram 头像

`GET /api/v1/instagram/avatar`

功能：代理 Instagram 头像图片，用于前端绕过部分图片域名限制。仅允许 Instagram/CDN 相关图片域名。

查询参数：

| 字段名 | 类型 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | Instagram 头像图片 URL，长度不超过 8192 |

出参：成功时返回图片二进制流；失败时返回通用错误响应。

### 10. 写入前端行为日志

`POST /api/v1/user-actions/log`

功能：记录前端行为日志，主要供本项目页面使用。

入参：

| 字段名 | 类型 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `action` | string | 否 | 行为名称，默认 `client_action` |
| `level` | string | 否 | `info` 或 `error`，默认 `info` |
| `status` | string | 否 | `ok` 或 `error`，默认 `ok` |
| `details` | object | 否 | 额外日志字段 |

出参：

| 字段名 | 类型 | 是否必有 | 说明 |
| --- | --- | --- | --- |
| `ok` | boolean | 是 | 是否写入成功 |

## 小红书资源下载示例

### 使用轮询

```bash
curl -X POST http://localhost:3000/api/v1/instagram/resolve/jobs \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.xiaohongshu.com/explore/xxxx"}'
```

拿到 `job_id` 后轮询：

```bash
curl http://localhost:3000/api/v1/instagram/resolve/jobs/JOB_ID
```

完成后下载全部资源：

```bash
curl -L -o xiaohongshu.zip \
  "http://localhost:3000/api/v1/instagram/requests/REQUEST_ID/download.zip"
```

### 使用回调

```bash
curl -X POST http://localhost:3000/api/v1/instagram/resolve/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "url":"https://www.xiaohongshu.com/explore/xxxx",
    "callback_url":"https://example.com/webhooks/linkmigo"
  }'
```

回调成功后，调用方从回调请求体的 `result.assets[].download_url` 获取完整下载地址；如果长时间未收到回调，可继续通过 `job_id` 轮询兜底。
