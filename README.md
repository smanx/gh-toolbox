# gh-toolbox

GitHub Actions 驱动的工具箱：仓库下每个工具 = 一个自包含的 Python 脚本控制一个 CLI 工具，由独立 workflow 调度（手动输入 / 定时 / 文件变更触发），产物按工具需要留存（ytdlp / m3u8 走 HF datasets 上传，青龙面板走 Artifact）。yt-dlp 是第一个入驻的批处理工具，青龙面板是第一个入驻的服务型工具（长驻进程 + 隧道暴露），N_m3u8DL-RE 是第二个批处理工具（专攻 HLS/DASH 流下载），后续可继续添加。例外：`one` 是跑在浏览器里的油猴脚本（详情取数器），没有 Python 入口也不挂自己的 workflow，但它能把取到的链接一键投给 `aria2.yml` / `m3u8.yml` 去下载。

## 工具列表

| 工具 | 说明 | Workflow | 入口脚本 |
|---|---|---|---|
| `ytdlp` | yt-dlp 批量下载视频/播放列表 | `.github/workflows/ytdlp.yml` | `tools/ytdlp/download.py` |
| `m3u8` | N_m3u8DL-RE 下载 HLS(m3u8)/DASH(mpd) 流 | `.github/workflows/m3u8.yml` | `tools/m3u8/download.py` |
| `aria2` | aria2c 多连接加速下载直链文件 | `.github/workflows/aria2.yml` | `tools/aria2/download.py` |
| `qinglong` | 托管青龙面板，控制端口经 CF Tunnel 映射访问 | `.github/workflows/qinglong.yml` | `tools/qinglong/run_panel.py` |
| `one` | 「ONE/暮色」网页版(j7tu.com)详情页取数器：拦页面自己发出的 detail 请求还原文章 id，换 one 模块 token 重取详情并铺出 MP4/M3U8 完整链接，点 ⬇ 填一张单子（选哪条链接、发到哪、文件名、headers、M3U8 要不要转 MP4、勾一下就顺带传到 HF 数据集）再发出去 —— 可发 GitHub workflow，也可发本地 aria2 / MediaGo（后者由伴生脚本 `one-local-dispatch.user.js` 代发） | 无（脚本自己不挂 workflow；面板 ⬇ 触发 `aria2.yml` / `m3u8.yml`） | `tools/one/one-detail-fetcher.user.js`（+ 可选 `tools/one/one-local-dispatch.user.js`） |

## 通用约定

**目录结构**

```
.
├── .github/workflows/   # 每个工具一个 workflow：<工具名>.yml
├── tools/               # 每个工具一个自包含目录
│   ├── ytdlp/
│   │   ├── download.py            # 主脚本（入口）
│   │   ├── requirements.txt       # 该工具专属依赖
│   │   ├── urls.txt               # 输入清单
│   │   ├── html/                  # 页面快照（另存的网页 HTML，油猴脚本打开弹框时自动解析提取视频直链+标题）
│   │   ├── ytdlp-dispatch.user.js # 油猴脚本（可选）：仓库/jable.tv/pornhub 页面悬浮按钮一键触发 workflow
│   │   ├── .ytdlp-archive.txt     # 下载档案（仅记录存档，不作跳过判据，不写回仓库）
│   │   └── downloads/             # 输出目录（gitignore；留存靠 HF 上传或本地运行）
│   ├── m3u8/
│   │   ├── download.py            # 主脚本（入口）：定位/自动下载 N_m3u8DL-RE 并调度下载
│   │   ├── requirements.txt       # 该工具专属依赖（N_m3u8DL-RE 本体不走 pip，脚本按 release 自动下载）
│   │   ├── urls.txt               # 输入清单（M3U8/MPD 直链）
│   │   ├── m3u8-dispatch.user.js  # 油猴脚本（可选）：仓库/jable.tv/pornhub 页面悬浮按钮一键触发 workflow
│   │   ├── html/                  # 页面快照（另存的网页 HTML，油猴脚本打开弹框时自动解析提取视频直链+标题）
│   │   ├── bin/                   # N_m3u8DL-RE 二进制缓存（gitignore，按需自动下载）
│   │   └── downloads/             # 输出目录（gitignore；留存靠 HF 上传或本地运行）
│   ├── aria2/
│   │   ├── download.py            # 主脚本（入口）：定位/自动下载 aria2c 并调度下载
│   │   ├── requirements.txt       # 该工具专属依赖（aria2c 本体不走 pip，脚本按 release 自动下载）
│   │   ├── urls.txt               # 输入清单（直链文件 URL）
│   │   ├── bin/                   # aria2c 静态编译二进制缓存（gitignore，按需自动下载）
│   │   └── downloads/             # 输出目录（gitignore；留存靠 HF 上传或本地运行）
│   ├── qinglong/
│   │   ├── run_panel.py           # 主脚本（入口）：起面板 + CF Tunnel + 保活
│   │   ├── requirements.txt       # 无第三方依赖（仅标准库）
│   │   ├── data/                  # 青龙数据卷（gitignore，走 Artifact）
│   │   ├── bin/                   # cloudflared 二进制（gitignore，按需下载）
│   │   └── cloudflared.log        # cloudflared 日志（gitignore，含隧道地址）
│   └── one/
│       ├── one-detail-fetcher.user.js # 油猴脚本：j7tu.com 详情页取数器（无 Python 入口；⬇ 可触发 aria2.yml / m3u8.yml）
│       └── one-local-dispatch.user.js # 伴生脚本（可选）：带 GM_xmlhttpRequest，替主脚本把下载任务发给本地 aria2 / MediaGo
└── README.md
```

**规则**

- 工具脚本自包含：输入清单、档案、输出目录均相对**脚本所在目录**解析，可从任意 cwd 运行。
- 每个工具一个 workflow，步骤骨架固定：
  `checkout → setup-python → pip install -r tools/<工具>/requirements.txt → 运行脚本`
- 触发方式按工具自行选择（`workflow_dispatch` / `schedule` / `push`）；**ytdlp / m3u8 当前为纯手动触发**，参数在 Run workflow 时填写。
- 例外：服务型工具（`qinglong`）**不加 `push` 触发**——代码变更就自动拉起一个最长 6 小时的长驻任务没有意义，只手动 / 定时启动。
- **workflow 不向仓库写任何文件**：产物按工具自行分发（HF datasets / Artifact / 其他存储），仓库保持只读（`permissions: contents: read`）；需要跨运行保留的状态放工具目录内或随产物分发，不提交回仓库。

## 新增一个工具

1. `cp -r tools/ytdlp tools/<新工具名>`
2. 修改 `tools/<新工具名>/` 下的脚本逻辑、输入清单、依赖
3. `cp .github/workflows/ytdlp.yml .github/workflows/<新工具名>.yml`，把其中的 `tools/ytdlp` 路径替换为新工具名，按需调整 inputs / cron / artifact
4. 在本 README「工具列表」加一行
5. 提交推送，Actions 页面即可看到新 workflow

## m3u8 工具说明

控制 [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE)（跨平台 DASH/HLS/MSS 下载器）批量下载 HLS(m3u8) / DASH(mpd) 流。功能对齐 ytdlp 工具：URL 清单 → 下载 → 混流封装 → 可选上传 HF datasets，且同样提供油猴脚本一键触发。与 ytdlp 的分工：yt-dlp 胜在站点解析广（ YouTube/B 站等千余站点），N_m3u8DL-RE 胜在流处理专业（多轨道选择、AES-128/SAMPLE-AES 解密、直播录制、DASH Period 处理）。

### 快速开始（仅手动触发）

1. 编辑 `tools/m3u8/urls.txt`，填入 M3U8/MPD 直链（每行一个，`#` 注释）。
2. 打开仓库 **Actions → N_m3u8DL-RE 下载器 → Run workflow**，按需填写参数（见下表），点 **Run workflow**。
3. 运行结束后：runner 是临时的，下载的文件**默认不保留**——需要文件就勾选 `hf_upload` 上传到 HF datasets，或本地运行。日志里能看到完整下载过程（解析/选流/实时进度/合并/混流/跳过），每个任务完成后输出文件路径、大小与耗时。
4. workflow 会自动确保 ffmpeg 可用（分片合并与混流的硬依赖）；N_m3u8DL-RE 本体由脚本按 latest release 自动下载（`bin/` 已 gitignore，本地同样自动下载，也可用 `M3U8_BIN` 指定已有二进制）。

#### 手动触发参数

| 输入 | 类型 | 说明 | 默认 |
|---|---|---|---|
| `urls` | string | 下载目标，每行一个（M3U8/MPD 直链）；留空用 `urls.txt` | 空 |
| `select_video` | string | 视频流选择表达式（如 `best`、`res="1920*":codecs=hvc1:for=best`、`bwMin=800:bwMax=3000:for=best`）；填写后走 `--select-video` | 空 |
| `auto_select` | boolean | 自动选择所有类型的最佳轨道（`--auto-select`）。**注意**：两者都不给时 N_m3u8DL-RE 会进入交互选流，CI 上无 TTY 直接失败——所以默认勾选 | `true` |
| `save_name` | string | 输出文件名（不含扩展名，如 `myvideo`）；留空按 URL 自动派生（取路径尾段 + 查询串指纹）；多个 URL 时自动加序号（`myvideo-2.mp4`）避免覆盖 | 空 |
| `overwrite` | boolean | 是否覆盖目标文件：勾选=**强制重新下载**并删除已存在的同名文件；不勾选=目标文件已存在则**跳过、不下载** | `false` |
| `mux_format` | choice | 下载完成后混流封装（**依赖 ffmpeg**，workflow 自动保证）：`mp4`（默认）/ `mkv` / `ts` / `none` 不混流（输出轨道原文件） | `mp4` |
| `thread_count` | string | 下载线程数（分片并发） | `16` |
| `headers` | string | 自定义请求头，单行 JSON（如 `{"Referer":"https://example.com/"}`）；本地运行也支持每行 `Name: Value`。值不会打进日志 | 空 |
| `hf_upload` | boolean | 下载完成后上传到 Hugging Face datasets（需 Secret `M3U8_HF_TOKEN`） | `false` |
| `hf_repo` | string | HF dataset 仓库 ID（如 `myuser/my-videos`）；留空则用 Secret `M3U8_HF_REPO` | 空 |
| `hf_path` | string | 上传到数据集仓库内的子目录（如 `videos/2024`），留空 = 根路径 | 空 |
| `extra_args` | string | N_m3u8DL-RE 附加命令行参数，空格分隔原样透传（如 `--key KID:KEY` 解密、`--live-record-limit 00:30:00` 直播限时录制、`--custom-range 05:00-20:00` 只下部分分片、`-ss all` 连字幕一起下） | 空 |

常用组合：

| 需求 | 参数 |
|---|---|
| 只要 1080p | `select_video=res="1920*":for=best` |
| 上传到 Hugging Face 数据集 | `hf_upload` 勾选 + `hf_repo` 填写 |
| 站点要 Referer/UA 才放行 | `headers={"Referer":"https://example.com/"}` |
| 强制重新下载 | `overwrite` 勾选 |
| 已下载过，只下新的 | 不勾选 `overwrite`（默认，自动跳过） |
| 输出 MKV（多音轨/字幕兼容性好） | `mux_format=mkv` |
| AES-128 加密流 | 无需配置（自动识别密钥）；自带 KEY 时 `extra_args=--key KID:KEY` |
| 直播流限时录制 30 分钟 | `extra_args=--live-record-limit 00:30:00` |
| 只下第 5~20 分钟 | `extra_args=--custom-range 05:00-20:00` |
| 字幕也要 | `extra_args=-ss all` |

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `M3U8_URLS` | 下载目标（换行/逗号分隔），优先于 `urls.txt` | 空 |
| `M3U8_BIN` | N_m3u8DL-RE 可执行文件路径；不设则 PATH > bin/ 缓存 > 自动下载 | 空 |
| `M3U8_RE_VERSION` | 要使用的 release 版本 tag（如 `v0.7.0`） | `latest` |
| `M3U8_OUTPUT_DIR` | 输出目录，相对路径基于工具目录解析 | `downloads` |
| `M3U8_TMP_DIR` | 临时分片目录 | `downloads/.tmp` |
| `M3U8_SELECT_VIDEO` | 视频流选择表达式 | 空 |
| `M3U8_AUTO_SELECT` | 自动选所有最佳轨道（`1`/`true`/`yes`/`on`） | `1` |
| `M3U8_SAVE_NAME` | 输出文件名（不含扩展名）；多 URL 自动加序号 | 空 |
| `M3U8_OVERWRITE` | 覆盖目标文件（`1`/`true`/`yes`/`on`）：强制重新下载；不置=目标文件已存在则跳过 | 关 |
| `M3U8_MUX_FORMAT` | 混流封装格式（**依赖 ffmpeg**，缺失脚本报错退出码 2）：`mp4`/`mkv`/`ts`/`none` | `mp4` |
| `M3U8_THREAD_COUNT` | 下载线程数 | `16` |
| `M3U8_RETRIES` | 每分片重试次数 | `7` |
| `M3U8_COOKIES` | Netscape cookies 文件路径 | 空 |
| `M3U8_HEADERS` | 自定义请求头：JSON 对象（推荐）或每行 `Name: Value`；格式错误退出码 2 | 空 |
| `M3U8_EXTRA_ARGS` | N_m3u8DL-RE 附加命令行参数（空格分隔，原样透传） | 空 |
| `M3U8_VERBOSE` | 置 1 输出 N_m3u8DL-RE DEBUG 日志 | 空 |
| `M3U8_HF_UPLOAD` | 启用上传到 Hugging Face datasets（`1`/`true`/`yes`/`on`） | 关 |
| `M3U8_HF_REPO` | HF dataset 仓库 ID（`用户名/数据集名`） | 空 |
| `M3U8_HF_PRIVATE` | 创建仓库时是否私有 | `1`（私有） |
| `M3U8_HF_PATH` | 上传到数据集仓库内的子目录，留空 = 根路径 | 空 |
| `M3U8_HF_TOKEN` | Hugging Face 令牌（带工具前缀 `M3U8_`，避免多工具 token 混用） | 空 |

### 本地运行

```bash
pip install -r tools/m3u8/requirements.txt   # 仅 huggingface_hub；二进制自动下载

# 用 urls.txt（脚本自定位，任意目录运行均可；N_m3u8DL-RE 首次运行自动下载到 tools/m3u8/bin/）
python tools/m3u8/download.py

# 命令行直接传 URL
python tools/m3u8/download.py "https://example.com/video/index.m3u8"

# 指定输出文件名
M3U8_SAVE_NAME=myvideo python tools/m3u8/download.py "https://example.com/video/index.m3u8"

# 只要 1080p，输出 MKV
M3U8_SELECT_VIDEO='res="1920*":for=best' M3U8_MUX_FORMAT=mkv python tools/m3u8/download.py

# 不混流（保留轨道原文件，无需 ffmpeg）
M3U8_MUX_FORMAT=none python tools/m3u8/download.py

# 自定义请求头（JSON；也支持每行 Name: Value，值不会打进日志）
M3U8_HEADERS='{"Referer":"https://example.com/","User-Agent":"Mozilla/5.0"}' \
  python tools/m3u8/download.py "https://example.com/video/index.m3u8"

# 附加参数透传：直播限时录制 30 分钟
M3U8_EXTRA_ARGS="--live-record-limit 00:30:00" python tools/m3u8/download.py "https://example.com/live.m3u8"

# 下载并上传到 Hugging Face datasets 的指定子目录（需 M3U8_HF_TOKEN 或本机 hf auth login）
M3U8_HF_UPLOAD=1 M3U8_HF_REPO=myuser/my-videos M3U8_HF_PATH=videos/2024 python tools/m3u8/download.py
```

### cookies（可选）

需要登录态的站点：把 Netscape 格式 cookies.txt base64 后存为仓库 Secret `M3U8_COOKIES`，workflow 会自动解码并传给 N_m3u8DL-RE（`--cookies`）。生成方式同 ytdlp 工具：

```bash
base64 -w0 cookies.txt
```

### 覆盖与跳过（overwrite）

| 勾选状态 | 行为 |
|---|---|
| 不勾选（默认） | 下载前检查目标文件（`save_name`/URL 派生名 + mp4/mkv/ts 等常见后缀）：已存在 → 跳过不下载；不存在 → 下载 |
| 勾选 | 强制重新下载：先删除已存在的同名产物（各扩展名都清），下载完成直接覆盖 |

### 油猴脚本一键触发（可选）

`tools/m3u8/m3u8-dispatch.user.js` 是 ytdlp 油猴脚本的姊妹版，功能完全一致：在仓库页面或 jable.tv / pornhub / missav（.ai/.ws/.com/.live/missav123.com 等镜像域）视频页右下角显示悬浮按钮（紫色 **⬇ m3u8**，与 ytdlp 的绿色按钮并存且位置各自记忆），点击弹框填参数一键触发本 workflow，并轮询展示运行状态。差异仅在：

- 默认触发目标为 `m3u8.yml`（N_m3u8DL-RE 下载器）；触发目标 owner/repo/workflow 同样全部手填、不写死。
- 弹框表单与 m3u8.yml 的 inputs 一一对应（urls / select_video / auto_select / save_name / overwrite / mux_format / thread_count / headers / hf_upload / hf_repo / hf_path / extra_args）。
- 页面快照目录为 `tools/m3u8/html/`（把视频页另存为 HTML 推送到该目录，仓库页打开弹框即可一键触发）。
- 视频页打开时，页面标题（文件名安全化）自动填入 `save_name` 栏——一键触发时标题即产物文件名；该栏与 `urls` 都不持久化，每次打开弹框都会重新提取（可手动改，也可点「载入页面视频」刷新）。
- 存储前缀 `m3u8_trigger_`，与 ytdlp 脚本的配置互不干扰；两脚本可同时安装。

> **missav 域名会变**：`.ws` / `.com` 被部分地区封锁后主站迁到 `.ai`，另有 `.live`、`missav123.com` 等镜像。脚本的 `@match` 已覆盖这些域名，并额外用 `@include https://*.missav.*/*` 兜底后续新后缀。如果换了全新域名仍看不到按钮，在 Tampermonkey 里给脚本手动加一条对应的 `@match` 即可（改完需重新安装/更新脚本，元数据只在安装时读取）。

安装方式与 Token 权限要求见「ytdlp 工具说明 → 油猴脚本一键触发」，两者一致。

#### 弹框三个 tab：GitHub Action 触发 / 通过 aria2 下载 / 发送到 MediaGo

弹框内部分三个 tab（上次停留的 tab 会记住）：

| tab | 作用 |
|---|---|
| **GitHub Action 触发** | 原有流程：填 workflow_dispatch 参数 → 用 GitHub Token 触发 workflow → 轮询运行状态 |
| **通过 aria2 下载** | 不经过 GitHub：把 urls 里的地址逐条通过 JSON-RPC 添加到本地/局域网 aria2，直接下载 |
| **发送到 MediaGo** | 不经过 GitHub：把地址提交给 [MediaGo](https://github.com/mediago-dev/mediago) 的 HTTP 下载服务，由它下载/合并 |

aria2 tab 提供：RPC 地址/密钥填写（按 host 记忆）、「测试连接」（回显 aria2 版本并提示是否支持 HLS）、UA/Referer 请求头、all-proxy 代理、多连接（-x 16 -s 16）、保存目录、覆盖开关，以及任务进度轮询（状态/百分比/速度/文件名）。

> **注意**：m3u8（HLS）需要支持 HLS 的 aria2 版本（如 `aria2-next`），否则只会下载到播放列表文件本身。「测试连接」会检测并提示。

##### MediaGo tab：先选画质，再发送

MediaGo 的下载接口（`POST /api/downloads`）只接受 `type / url / name / folder / headers`，**没有选流参数**——选画质只能由前端做完再下发。所以脚本对 m3u8 会做二次交互：

1. 发送前先拉取该链接的播放列表（跨源用 `GM_xmlhttpRequest`，已带 `@connect *` 授权）；
2. 解析所有 `#EXT-X-STREAM-INF`，按分辨率/帧率/码率/编码列出画质列表，默认选中最高画质；
3. 用户确认后，把**选中的清晰度 URL** 作为任务 `url` 提交给 MediaGo（`type` 按链接自动判定：`.m3u8` → `m3u8`，bilibili → `bilibili`，其余 → `direct`）；
4. 多链接时逐条询问，形成队列（按钮显示「还剩 N 条待选」）；关弹框或切走 tab 会放弃未确认的选择，**不会发送任何任务**。

非 m3u8、媒体播放列表（单一画质）时不弹选择，按原链接直接发送。

**播放列表拉取/解析失败时不会静默发送**（否则 MediaGo 会用它自己的默认选流下载，画质不受你控制）。此时会弹对话框说明原因（如 Cloudflare 拦截、链接过期、返回的是网页而非播放列表），并提供四个选项：

| 选项 | 行为 |
|---|---|
| 仍然发送这条 | 按原链接发送（MediaGo 用默认选流，画质不受你控制） |
| 跳过这条 | 这条不发送，继续处理后续链接 |
| 全部仍然发送（不再询问） | 本条及后续解析失败的都按原链接发送 |
| 取消发送 | 整个流程终止，不发送任何任务 |

发送完成后的状态栏会明确标注有几条是"解析失败、按原链接发送"的。

MediaGo tab 还提供：服务地址/API Key 填写（按 host 记忆，Docker 启用认证时填设置页里的 Key，以 `Authorization: Bearer` 发送）、「测试连接」（用任务列表接口探测连通性与认证）、保存子目录、删除分段（`deleteSegments`）、任务进度轮询（状态/产物文件名）与单个任务「停止」。

地址默认 `http://127.0.0.1:9900`；桌面端是 `39719`，Docker 按 `-p` 映射填（如 `http://10.0.0.223:9900`）。

右侧各 tab 只显示自己真正生效的字段（aria2：urls / save_name / headers / overwrite / 多连接 / 代理 / 下载路径；MediaGo：urls / save_name / headers / folder / 删除分段）；select_video、mux_format、thread_count、extra_args 与 HF 上传属于 GitHub Action 流程，不在这两个 tab 显示。三个 tab 的 urls / save_name / headers 会自动同步（打开弹框或点「载入页面视频」时一起更新）。

### 注意事项

- **ffmpeg 硬依赖**：N_m3u8DL-RE 的分片合并（默认 LOCAL_HTTP 方式）与 `-M` 混流都依赖 ffmpeg；`M3U8_MUX_FORMAT=none` 时混流步骤跳过，但 TS/fMP4 分片的合并仍需要。workflow 自动保证；本地运行必须自备。
- **非交互选流**：CI 无 TTY，交互选流菜单会直接失败。脚本始终以 `--auto-select` 或 `--select-video` 运行（表达式优先）；确实需要精细选流时用 `select_video` 表达式（语法见 N_m3u8DL-RE 的 `--morehelp select-video`）。
- **DRM**：N_m3u8DL-RE 只处理标准加密（AES-128 / SAMPLE-AES / CENC，KEY 已知时可用 `--key`）；Widevine 级 DRM 不支持。
- **命名与指纹**：`save_name` 留空时从 URL 派生（路径尾段 + 查询串 md5 指纹前 6 位），同一页面不同清晰度/签名的 URL 不会互相覆盖；手动 `save_name` 多 URL 时自动加 `-2/-3` 序号。
- **后缀探测**：与 ytdlp 工具一样，下载完成后脚本会用 ffprobe 探测真实封装，TS 冒充 .mp4（或反之）时如实改名（仅改名不转码；要 MP4 封装请用 `mux_format=mp4`）。
- **产物留存**：与 ytdlp 相同，不上传 GitHub Artifact（限额原因）；需要文件就启用 `hf_upload` 传到 HF datasets，或本地运行。
- **超时**：job `timeout-minutes: 360` 为 GitHub 托管 runner 上限，特大任务需拆分。
- **时效性**：N_m3u8DL-RE 默认取 latest release；指定版本用 `M3U8_RE_VERSION`。m3u8 直链有时效性（签名过期），过期后重新提取一次即可。

## aria2 工具说明

控制 [aria2](https://github.com/aria2/aria2)（aria2c）多连接加速下载**直链文件**。与 m3u8 / ytdlp 的分工：yt-dlp 胜在站点解析广，N_m3u8DL-RE 胜在流处理专业（多轨道选择、解密、直播录制），aria2 胜在纯直链的多连接吞吐（单连接限速的服务器、大文件、网盘直链等场景）。

> **只支持直链**：aria2 不解析网页、不合并 HLS/DASH 分片——给 `.m3u8`/`.mpd` 只会下到播放列表文本本身。需要 HLS/DASH 流处理请用 m3u8 / ytdlp 工具。

### 快速开始（仅手动触发）

1. 编辑 `tools/aria2/urls.txt`，填入直链 URL（每行一个，`#` 注释）。
2. 打开仓库 **Actions → aria2 下载器 → Run workflow**，按需填写参数（见下表），点 **Run workflow**。
3. 运行结束后：runner 是临时的，下载的文件**默认不保留**——需要文件就勾选 `hf_upload` 上传到 HF datasets，或本地运行。日志里能看到完整下载过程（连接/分片/实时进度/跳过），每个任务完成后输出文件路径、大小与耗时。
4. workflow 会自动确保 aria2 可用（runner 镜像一般已带）；脚本也有兜底：PATH 没有 aria2c 时自动下载静态编译版到 `tools/aria2/bin/`（gitignore）。

#### 手动触发参数

| 输入 | 类型 | 说明 | 默认 |
|---|---|---|---|
| `urls` | string | 下载目标，每行一个（直链文件 URL）；留空用 `urls.txt` | 空 |
| `save_name` | string | 输出文件名，**原样传给 `aria2c -o`**（不像 m3u8 那条由工具补后缀）：直链文件建议带扩展名（如 `myvideo.mp4`），不带就落一个没扩展名的文件；留空按 URL 自动派生（取路径尾段 + 查询串指纹，派生名保留原后缀）。多个 URL 时手动名自动加序号（`myvideo-2`，拼在给定名字后面、不补后缀）避免覆盖 | 空 |
| `overwrite` | boolean | 是否覆盖目标文件：勾选=**强制重新下载**并删除已存在的同名文件；不勾选=目标文件已存在则**跳过、不下载** | `false` |
| `connections` | string | 单服务器最大连接数 `-x`（aria2 协议上限 16）；服务器单连接限速时调大 | `16` |
| `split` | string | 单文件分片数 `-s` | `16` |
| `min_split_size` | string | 分片最小尺寸 `-k`（如 `1M` / `4M`）；调大可减少小文件的碎片请求 | `1M` |
| `retries` | string | 每连接重试次数 | `5` |
| `headers` | string | 自定义请求头，单行 JSON（如 `{"Referer":"https://example.com/"}`）；本地运行也支持每行 `Name: Value`。**aria2 不允许设置 Cookie 头**，登录态请配 Secret `ARIA2_COOKIES`。值不会打进日志 | 空 |
| `hf_upload` | boolean | 下载完成后上传到 Hugging Face datasets（需 Secret `ARIA2_HF_TOKEN`） | `false` |
| `hf_repo` | string | HF dataset 仓库 ID（如 `myuser/my-files`）；留空则用 Secret `ARIA2_HF_REPO` | 空 |
| `hf_path` | string | 上传到数据集仓库内的子目录（如 `files/2024`），留空 = 根路径 | 空 |
| `extra_args` | string | aria2c 附加命令行参数，空格分隔原样透传（如 `--all-proxy http://...` 走代理、`--lowest-speed-limit 1M` 慢速熔断、`--checksum sha-256=...` 校验） | 空 |

常用组合：

| 需求 | 参数 |
|---|---|
| 服务器单连接限速，想跑满带宽 | 默认即可（`connections=16`）；还不行调 `min_split_size=1M` 增加分片 |
| 上传到 Hugging Face 数据集 | `hf_upload` 勾选 + `hf_repo` 填写 |
| 站点要 Referer/UA 才放行 | `headers={"Referer":"https://example.com/"}` |
| 需要登录态（下载链路要 Cookie） | 配 Secret `ARIA2_COOKIES`（Netscape cookies.txt 的 base64），**不能用 headers 塞 Cookie** |
| 走代理下载 | `extra_args=--all-proxy http://127.0.0.1:7890` |
| 强制重新下载 | `overwrite` 勾选 |
| 已下载过，只下新的 | 不勾选 `overwrite`（默认，自动跳过） |
| 断点续传 | 默认开启（`--continue`，`.aria2` 控制文件自动管理）；`overwrite` 勾选时会清掉旧断点 |

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `ARIA2_URLS` | 下载目标（换行/逗号分隔），优先于 `urls.txt` | 空 |
| `ARIA2_BIN` | aria2c 可执行文件路径；不设则 PATH > bin/ 缓存 > 自动下载静态编译版 | 空 |
| `ARIA2_VERSION` | 要使用的静态编译 release 版本 tag（如 `v1.37.0`） | `latest` |
| `ARIA2_OUTPUT_DIR` | 输出目录，相对路径基于工具目录解析 | `downloads` |
| `ARIA2_SAVE_NAME` | 输出文件名（不含扩展名）；多 URL 自动加序号 | 空 |
| `ARIA2_OVERWRITE` | 覆盖目标文件（`1`/`true`/`yes`/`on`）：强制重新下载；不置=目标文件已存在则跳过 | 关 |
| `ARIA2_CONNECTIONS` | 单服务器最大连接数 `-x`（上限 16） | `16` |
| `ARIA2_SPLIT` | 单文件分片数 `-s` | `16` |
| `ARIA2_MIN_SPLIT_SIZE` | 分片最小尺寸 `-k` | `1M` |
| `ARIA2_MAX_TRIES` | 每连接重试次数 | `5` |
| `ARIA2_RETRY_WAIT` | 重试间隔秒数 | `5` |
| `ARIA2_COOKIES` | Netscape cookies 文件路径（`--load-cookies`） | 空 |
| `ARIA2_HEADERS` | 自定义请求头：JSON 对象（推荐）或每行 `Name: Value`；**不允许 Cookie 头**（报错指路 `ARIA2_COOKIES`）；格式错误退出码 2 | 空 |
| `ARIA2_EXTRA_ARGS` | aria2c 附加命令行参数（空格分隔，原样透传） | 空 |
| `ARIA2_VERBOSE` | 置 1 输出 aria2c DEBUG 日志 | 空 |
| `ARIA2_HF_UPLOAD` | 启用上传到 Hugging Face datasets（`1`/`true`/`yes`/`on`） | 关 |
| `ARIA2_HF_REPO` | HF dataset 仓库 ID（`用户名/数据集名`） | 空 |
| `ARIA2_HF_PRIVATE` | 创建仓库时是否私有 | `1`（私有） |
| `ARIA2_HF_PATH` | 上传到数据集仓库内的子目录，留空 = 根路径 | 空 |
| `ARIA2_HF_TOKEN` | Hugging Face 令牌（带工具前缀 `ARIA2_`，避免多工具 token 混用） | 空 |

### 本地运行

```bash
pip install -r tools/aria2/requirements.txt   # 仅 huggingface_hub；二进制自动下载

# 用 urls.txt（脚本自定位，任意目录运行均可；无 aria2c 时首次运行自动下载到 tools/aria2/bin/）
python tools/aria2/download.py

# 命令行直接传 URL
python tools/aria2/download.py "https://example.com/video.mp4"

# 指定输出文件名
ARIA2_SAVE_NAME=myvideo python tools/aria2/download.py "https://example.com/video.mp4"

# 自定义连接数与分片
ARIA2_CONNECTIONS=16 ARIA2_SPLIT=32 python tools/aria2/download.py

# 自定义请求头（JSON；也支持每行 Name: Value，值不会打进日志）
ARIA2_HEADERS='{"Referer":"https://example.com/","User-Agent":"Mozilla/5.0"}' \
  python tools/aria2/download.py "https://example.com/video.mp4"

# 附加参数透传：走代理 + 慢速熔断
ARIA2_EXTRA_ARGS="--all-proxy http://127.0.0.1:7890 --lowest-speed-limit 1M" \
  python tools/aria2/download.py "https://example.com/big.zip"

# 下载并上传到 Hugging Face datasets 的指定子目录（需 ARIA2_HF_TOKEN 或本机 hf auth login）
ARIA2_HF_UPLOAD=1 ARIA2_HF_REPO=myuser/my-files ARIA2_HF_PATH=files/2024 python tools/aria2/download.py
```

### cookies（可选）

需要登录态的站点：把 Netscape 格式 cookies.txt base64 后存为仓库 Secret `ARIA2_COOKIES`，workflow 会自动解码并传给 aria2c（`--load-cookies`）。生成方式：

```bash
base64 -w0 cookies.txt
```

### 覆盖与跳过（overwrite）

| 勾选状态 | 行为 |
|---|---|
| 不勾选（默认） | 下载前检查目标文件（`save_name`/URL 派生名 + mp4/mkv/ts/zip 等常见后缀）：已存在 → 跳过不下载；不存在 → 下载 |
| 勾选 | 强制重新下载：先删除已存在的同名产物（各扩展名都清）与 `.aria2` 断点控制文件，下载完成直接覆盖 |

### 注意事项

- **只支持直链**：aria2 不解析网页、不合并 HLS/DASH 分片；`.m3u8`/`.mpd` 会下到播放列表文本本身。流处理需求用 m3u8 / ytdlp 工具。
- **多连接不是万能**：部分站点/CDN 拒绝 range 请求或单 IP 限并发，多连接可能被 403/429，此时调小 `connections`/`split`。
- **Cookie 限制**：aria2 明确禁止用 `--header` 设置 Cookie 头，脚本会在启动前拦截并指路 `ARIA2_COOKIES`，避免跑到一半才失败。
- **断点续传**：默认 `--continue` 开启；非覆盖模式下重跑同一 URL 前先检查目标文件，已下载完的会跳过，未下载完的（有 `.aria2` 控制文件）续传。
- **二进制来源**：本地/CI 无 aria2c 时自动下载 [abcfy2/aria2-static-build](https://github.com/abcfy2/aria2-static-build) 静态编译版（linux/win；macOS 请 `brew install aria2` 或用 `ARIA2_BIN` 指定）。
- **产物留存**：与 ytdlp / m3u8 相同，不上传 GitHub Artifact（限额原因）；需要文件就启用 `hf_upload` 传到 HF datasets，或本地运行。
- **超时**：job `timeout-minutes: 360` 为 GitHub 托管 runner 上限，特大任务需拆分。

## ytdlp 工具说明

控制 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 批量下载视频/播放列表。

### 快速开始（仅手动触发）

1. 编辑 `tools/ytdlp/urls.txt`，填入视频/播放列表/直链/M3U8 URL（每行一个，`#` 注释）。
2. 打开仓库 **Actions → yt-dlp 下载器 → Run workflow**，按需填写参数（见下表），点 **Run workflow**。
3. 运行结束后：runner 是临时的，下载的文件**默认不保留**——需要文件就勾选 `hf_upload` 上传到 HF datasets（见下文「上传到 Hugging Face datasets」），或本地运行。日志里能看到完整下载过程（解析/目标文件/实时进度/合并/跳过），每个文件完成后输出完整路径、大小与耗时。
4. 勾选 `aria2` 时 workflow 会自动安装 aria2；`transcode` 选 `remux`/`recode` 时依赖 ffmpeg（workflow 会确保可用，缺失自动安装）；勾选 `hf_upload` 时下载完成后上传到 Hugging Face datasets（见下文）。

#### 手动触发参数

| 输入 | 类型 | 说明 | 默认 |
|---|---|---|---|
| `urls` | string | 下载目标，每行一个（视频/播放列表/直链/M3U8）；留空用 `urls.txt` | 空 |
| `format` | string | 格式表达式 | 空（脚本默认 `bv*+ba/b`） |
| `playlist_end` | string | 每个播放列表下载上限，0 不限 | `0` |
| `overwrite` | boolean | 是否覆盖目标文件：勾选=**强制重新下载**并覆盖已存在的文件；不勾选=先检查目标文件，**已存在则跳过、不下载** | `false` |
| `transcode` | choice | 转码为 MP4（**依赖 ffmpeg**，workflow 自动保证；本地需自备）：`none` 不转(探测到 TS 流则如实命名 .ts) / `remux` 仅换封装、流拷贝(快/无损/体积不变) / `recode` 重编码 H.264+AAC(慢/有损/体积会变，救不兼容编码的源)。都会按真实封装修正后缀 | `none` |
| `aria2` | boolean | 使用 aria2c 多连接加速（自动安装） | `false` |
| `hf_upload` | boolean | 下载完成后上传到 Hugging Face datasets（需 Secret `YTDLP_HF_TOKEN`） | `false` |
| `hf_repo` | string | HF dataset 仓库 ID（如 `myuser/my-videos`）；留空则用 Secret `YTDLP_HF_REPO` | 空 |
| `hf_path` | string | 上传到数据集仓库内的子目录（如 `videos/2024`），留空 = 根路径 | 空 |
| `rename` | string | 输出文件名（不含扩展名，如 `myvideo`；也可传含 `%` 的模板）；留空用默认命名 | 空 |
| `headers` | string | 自定义请求头，单行 JSON（如 `{"Referer":"https://example.com/"}`）；本地运行也支持每行 `Name: Value`。带 `Cookie` 会自动加载为 cookies；值不会打进日志 | 空 |
| `impersonate` | string | TLS 指纹伪装，过 Cloudflare 反爬挑战（依赖 curl_cffi，随依赖自动安装）：留空/`0`=关闭；`1` 或 `chrome`=伪装 Chrome；也可填 `safari`、`chrome-131` 等 | 空 |

常用组合：

| 需求 | 参数 |
|---|---|
| 下载 M3U8，输出标准 MP4 | `transcode=remux`（快且无损；源编码古怪再考虑 `recode`；`none` 时 TS 流会如实命名为 `.ts`） |
| 来源是 mkv/webm/ts 等，想无损换成 mp4 封装 | `transcode=remux` |
| 来源编码古怪（如 mpeg2/wmv），要标准 H.264 MP4 | `transcode=recode` |
| 大文件多连接加速 | `aria2` 勾选 |
| 上传到 Hugging Face 数据集 | `hf_upload` 勾选 + `hf_repo` 填写 |
| 只要 1080p | `format=best[height<=1080]` |
| 站点要 Referer/UA 才放行 | `headers={"Referer":"https://example.com/"}` |
| 被 Cloudflare 拦（403 anti-bot challenge） | `impersonate=1`（TLS 指纹伪装 Chrome） |
| 文件已在目标处，不想重下 | 不勾选 `overwrite`（默认，自动跳过） |
| 强制重新下载、覆盖旧文件 | `overwrite` 勾选 |
| 补下播放列表里缺的几集 | 不勾选 `overwrite`，已存在的条目自动跳过，只下缺失的 |

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `YTDLP_URLS` | 下载目标（换行/逗号分隔），优先于 `urls.txt` | 空 |
| `YTDLP_OUTPUT_DIR` | 输出目录，相对路径基于工具目录解析 | `downloads` |
| `YTDLP_TEMPLATE` | 输出文件名模板 | `%(title)s [%(id)s].%(ext)s` |
| `YTDLP_RENAME` | 输出文件名（不含扩展名）或含 `%` 的模板，优先于 `YTDLP_TEMPLATE` | 空 |
| `YTDLP_FORMAT` | 格式表达式 | `bv*+ba/b` |
| `YTDLP_MERGE_FORMAT` | 合并封装格式 | `mp4` |
| `YTDLP_ARCHIVE` | 下载档案路径 | `tools/ytdlp/.ytdlp-archive.txt` |
| `YTDLP_PLAYLIST_END` | 播放列表下载上限 | `0` |
| `YTDLP_OVERWRITE` | 覆盖目标文件（`1`/`true`/`yes`/`on`）：强制重新下载并覆盖已存在文件；不置=目标文件已存在则跳过 | 关 |
| `YTDLP_CONCURRENT_FRAG` | 分片并发数 | `4` |
| `YTDLP_RETRIES` | 网络重试次数 | `10` |
| `YTDLP_COOKIES` | Netscape cookies 文件路径 | 空 |
| `YTDLP_HEADERS` | 自定义请求头（合并覆盖 yt-dlp 默认头）：JSON 对象 `{"Referer":"https://..."}` 或每行 `Name: Value`；带 `Cookie` 会自动加载为 cookies；格式错误退出码 2 | 空 |
| `YTDLP_IMPERSONATE` | 浏览器 TLS 指纹伪装（过 Cloudflare 反爬，依赖 curl_cffi，未安装报错退出码 2）：`1`/`true`=伪装 Chrome；也可显式指定 `safari`、`chrome-131`、`chrome:windows-10`；空/`0`=关闭 | 空 |
| `YTDLP_VERBOSE` | 置 1 输出 yt-dlp debug 日志 | 空 |
| `YTDLP_TRANSCODE` | 转码为 MP4（**依赖 ffmpeg**，未安装则脚本报错退出码 2）：`none` 不转(探测到 TS 流则如实命名 .ts) / `remux` 流拷贝换封装(快/无损) / `recode` 重编码 H.264+AAC(慢/有损)；都会按真实封装修正后缀 | `none` |
| `YTDLP_ARIA2` | 启用 aria2c 加速（`1`/`true`/`yes`/`on`） | 关 |
| `YTDLP_ARIA2_ARGS` | aria2c 附加参数（空格分隔） | `-x 16 -s 16 -k 1M` |
| `YTDLP_HF_UPLOAD` | 启用上传到 Hugging Face datasets（`1`/`true`/`yes`/`on`） | 关 |
| `YTDLP_HF_REPO` | HF dataset 仓库 ID（`用户名/数据集名`） | 空 |
| `YTDLP_HF_PRIVATE` | 创建仓库时是否私有 | `1`（私有） |
| `YTDLP_HF_PATH` | 上传到数据集仓库内的子目录，留空 = 根路径 | 空 |
| `YTDLP_HF_TOKEN` | Hugging Face 令牌（带工具前缀，避免多工具 token 混用） | 空 |

### 本地运行

```bash
pip install -r tools/ytdlp/requirements.txt

# 用 urls.txt（脚本自定位，任意目录运行均可）
python tools/ytdlp/download.py

# 命令行直接传 URL（会追加到下载列表）
python tools/ytdlp/download.py "https://www.youtube.com/watch?v=BaW_jenozKc"

# 覆盖参数
YTDLP_FORMAT="best[height<=1080]" python tools/ytdlp/download.py

# 强制重新下载并覆盖已存在的目标文件（等价 Actions 勾选 overwrite）
YTDLP_OVERWRITE=1 python tools/ytdlp/download.py "https://example.com/video"

# 只补下缺失的文件：目标文件已存在则跳过（默认行为）
YTDLP_OVERWRITE=0 python tools/ytdlp/download.py "https://example.com/playlist"

# HLS(m3u8) 转成 MP4（需 PATH 中有 ffmpeg）
# remux=流拷贝换封装（快、无损）；recode=重编码 H.264/AAC（慢、有损，救不兼容的源）
YTDLP_TRANSCODE=remux python tools/ytdlp/download.py "https://example.com/video/index.m3u8"

# aria2 多连接加速（需本机 PATH 中已有 aria2c）
YTDLP_ARIA2=1 python tools/ytdlp/download.py "https://example.com/big.mp4"

# 自定义输出文件名（不含扩展名）
YTDLP_RENAME=myvideo python tools/ytdlp/download.py "https://example.com/video"

# 自定义请求头（JSON；也支持每行 Name: Value，值不会打进日志）
YTDLP_HEADERS='{"Referer":"https://example.com/","User-Agent":"Mozilla/5.0"}' \
  python tools/ytdlp/download.py "https://example.com/video"

# 过 Cloudflare 反爬：TLS 指纹伪装成 Chrome（依赖 curl_cffi，见 requirements.txt）
YTDLP_IMPERSONATE=1 python tools/ytdlp/download.py "https://surrit.com/xxx/playlist.m3u8"

# 下载并上传到 Hugging Face datasets 的指定子目录（需 YTDLP_HF_TOKEN 或本机 hf auth login）
YTDLP_HF_UPLOAD=1 YTDLP_HF_REPO=myuser/my-videos YTDLP_HF_PATH=videos/2024 python tools/ytdlp/download.py
```

### cookies（可选）

需要登录/年龄验证的站点：

```bash
base64 -w0 cookies.txt   # 生成单行 base64
```

把输出添加到仓库 Secrets：`Settings → Secrets and variables → Actions → New repository secret`，名 `YTDLP_COOKIES`。workflow 会自动解码为 `cookies.txt` 并传给脚本（`cookies.txt` 已在 `.gitignore` 中，不会提交）。

### 下载档案

`download.py` 每下载完成一个视频就把 `extractor 视频ID` 写入 `.ytdlp-archive.txt`，**仅作记录存档，不再作为跳过判据**——是否跳过只看目标文件是否存在（见下方「覆盖与跳过」）。workflow 不把该文件写回仓库（仓库只读），runner 也是临时的——每次手动运行都从空档案开始。删除已下载的文件，下次不勾选 `overwrite` 运行就会重新下载它。

### 覆盖与跳过（overwrite）

| 勾选状态 | 行为 |
|---|---|
| 不勾选（默认） | 下载前逐个检查目标文件：已存在 → 跳过不下载（HLS 的 `.ts`/`.mp4` 后缀偏差也能识别）；不存在 → 下载 |
| 勾选 | 百分百触发下载：绕过一切检查，yt-dlp 先删除已存在的目标文件再重新下载，**直接覆盖** |

播放列表按条目粒度判断：全部条目的目标文件都已存在 → 整个跳过；部分缺失 → 只下载缺失条目（已存在的条目由 yt-dlp 自动跳过，不会重复下载）。

### 重命名输出文件（可选）

默认命名为 `%(title)s [%(id)s].%(ext)s`。想自定义时：

- **简单用法**：传一个不含扩展名的文件名，脚本自动补上实际扩展名。
  `rename=myvideo` → `myvideo.mp4`（自带扩展名如 `myvideo.mp4` 也会被正确剥掉再补，不会出现 `.mp4.mp4`）。
- **模板用法**：传含 `%` 的 yt-dlp 模板（缺 `%(ext)s` 会自动补）。
  `rename=%(playlist_index)s-%(title)s`、`rename=%(uploader)s/%(title)s`（`/` 可建子目录）。
- **播放列表注意**：多文件场景下模板必须含唯一占位符（`%(playlist_index)s`、`%(title)s`、`%(id)s` 等），否则脚本会告警且文件可能互相覆盖。

### 上传到 Hugging Face datasets（可选）

全部下载完成后，可把 `downloads/` 整个上传到 HF dataset 仓库（默认关闭）。

**配置**：

1. 到 [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) 创建 Token（权限选 `write`）。
2. 存为仓库 Secret：`YTDLP_HF_TOKEN`（必填，带工具前缀避免与其他工具的 token 混用）；`YTDLP_HF_REPO`（可选，作为默认仓库 ID）。
3. Run workflow 时勾选 `hf_upload`，填写 `hf_repo`（留空则用 Secret `YTDLP_HF_REPO`）和 `hf_path`（留空上传到仓库根路径）。

**行为**：

- 上传 `tools/ytdlp/downloads/` 全目录到 dataset 仓库；仓库不存在则自动创建（**默认私有**，`YTDLP_HF_PRIVATE=0` 可改公开；已存在的仓库不会改动其可见性）。
- `hf_path` 指定仓库内的目标子目录（如 `videos/2024` → 文件落在该目录下），留空 = 根路径。
- 内容未变化的文件不会重复传输（hub 按 hash 去重）。
- 上传失败会记录错误并以退出码 1 结束（runner 上的文件不受影响）。

### 油猴脚本一键触发（可选）

嫌每次去 Actions 页面点 Run workflow 麻烦，可安装油猴脚本 `tools/ytdlp/ytdlp-dispatch.user.js`：在仓库页面或 jable.tv / pornhub / missav（.ai/.ws/.com/.live/missav123.com 等镜像域） 视频页右下角显示悬浮按钮，点击弹框填参数，一键触发本 workflow，并轮询展示运行状态。

**触发目标三者全部手填、不写死**：弹框内「**owner · 用户名」「repo · 仓库名」「workflow · 触发哪个 Action**」都由用户手动输入（均可直接粘贴 `https://github.com/<用户名>/<仓库名>` 或 `.github/workflows/xxx.yml` 完整路径，会自动拆解归一化；留空才兜底用脚本里的 CONFIG 默认值）。dispatch 触发、Token 验证、页面快照拉取、运行状态轮询、最近运行列表、弹框标题和「Actions 页面」链接全部跟随这三个填写值；手填值本地记忆，下次自动带出。也就是说这个脚本可以触发**任意仓库**的 workflow，不只是本仓库。

**自动带上视频链接与标题**（打开弹框即自动填入，无需手动复制粘贴）：

- **jable.tv 视频页**（`@match https://jable.tv/videos/*`）：从当前实时页面提取视频直链（播放器内联脚本里的 `hlsUrl`，即 m3u8）与标题（`og:title`）。
- **pornhub 视频页**（`@match https://*.pornhub.com/view_video.php*`）：从当前实时页面提取 flashvars `mediaDefinitions` 里的 `"videoUrl"`（JSON 转义会自动反转义、HTML 实体自动解码）——**多清晰度取最高**（如 `720P_4000K_xxx.mp4/master.m3u8`）；`/video/get_media?s=...` 下载端点以 `# 下载端点:` 注释行带回（参考用，不进下载列表）。
- **GitHub 仓库页**：从仓库快照目录 `tools/ytdlp/html/`（兼容旧路径 `tools/ytdlp/http/`）下的 `*.html` 快照提取——把视频页「另存为」HTML 放进该目录并提交推送，之后在仓库页面打开弹框即可一键触发。目录列举 + 每个文件的最近提交时间走 `api.github.com`（公开仓库无 Token 也可用，限流 60/h），拉取文件走 raw.githubusercontent.com（公开免鉴权），失败回退 contents API；刚推送的文件 raw CDN 约 5 分钟生效。
- **多个快照时默认自动选中最近提交的那个**（= 最新保存的页面），弹框内的「页面快照」下拉可手动切换，切换后立即重新提取。
- 提取结果写入两个参数：`urls` ← **只写视频直链本身**（纯 URL，一行一个，不放任何注释行）；`rename` ← 视频标题（做了文件名安全化）。两者**不持久化**，每次打开弹框都会重新提取，可点「**载入页面视频**」手动刷新。

**功能**：

- 悬浮按钮可拖动、位置记忆；仅在 `gh-toolbox` 仓库页面与 jable.tv / pornhub / missav（.ai/.ws/.com/.live/missav123.com 等镜像域） 视频页显示（GitHub Turbo 导航自动感知，离开这几类页面自动隐藏）——按钮出现位置由 `@match` 决定，触发目标则由手填的三栏决定，两者独立。
- 弹框表单与 workflow 的 12 个 inputs 一一对应（每项带中文说明），填写值**按当前 host 隔离保存**（github.com / jable.tv / cn.pornhub.com 各记各的），下次自动带出；「重置参数」一键还原默认值（同时清除自动带入的视频信息）。**例外：urls（下载链接）与 rename（标题）不保存**——每次打开弹框都会重新提取，不会把上一个视频的链接带进下一次；其余（format/overwrite/transcode/hf_repo/headers/Token/owner/repo/workflow/ref 等）全部保存。
- **headers 默认带上 UA + Referer**：headers 栏为空时自动填入 `{"User-Agent":"<Chrome UA>","Referer":"<站点 origin>"}`（视频站打开时用当前站点，仓库页在快照提取成功后补目标站点）；仅当栏为空或仍是自动生成的默认头时才刷新，手填的自定义请求头（如带 Cookie）不会被覆盖。
- 触发分支 `ref` 可改（默认 `main`；在 `/tree/<分支>` 或 `/blob/<分支>` 页面打开会自动带出该分支）；触发目标 workflow 手填（见上）。
- 本地即时校验：`headers` 非法 JSON、`playlist_end` 非整数直接拦在弹框里，不会带到服务端才失败。
- 触发后自动轮询新运行：排队中 → 进行中 → 成功/失败，附链接直跳 Actions 日志；弹框内还可查看 / 刷新最近 5 次运行。
- 适配亮 / 暗色主题；Token 仅存本浏览器 Tampermonkey 存储。

**安装**：

1. 安装 Tampermonkey 扩展 → 新建脚本 → 粘贴 `tools/ytdlp/ytdlp-dispatch.user.js` 全文保存（或把该 `.user.js` 文件直接拖进任意标签页，Tampermonkey 会弹出安装确认页）。
2. 准备 GitHub Token：
   - 经典 PAT：勾选 `repo` scope；
   - 细粒度 PAT：`Actions: read+write` + `Contents: read` + `Metadata: read`。
3. 打开 gh-toolbox 仓库任意页面（`https://github.com/<owner>/gh-toolbox`）或任意 jable.tv / pornhub / missav（.ai/.ws/.com/.live/missav123.com 等镜像域） 视频页，点右下角 **▶ yt-dlp** 悬浮按钮，弹框内粘贴 Token →「保存并验证」→（视频信息已自动带好）按需改参数 →「触发 Action」。

**注意**：

- 脚本走 `api.github.com` 的 `workflow_dispatch` 接口，Token 需对该仓库有写权限；Token 只保存在本地浏览器，**不要**写进仓库或分享截图。
- 运行状态轮询最长 10 分钟，超时会给出 Actions 页面链接；超大任务建议直接去 Actions 页面查看。
- m3u8 直链有时效性，过期后重新保存一次视频页 HTML（推送更新 `html/` 下的快照）即可。
- 复用到其他工具（如 qinglong）：触发目标已全手填，一般无需改代码；只有要改**留空时的兜底默认值**才动 `CONFIG`（owner / repo / workflowFile / pageDirs / pageFiles / videoSites）与 `INPUTS`（inputs 定义），`@match` 同步调整即可。

### 注意事项

- **完成日志**：每个文件下载完成即输出完整路径、大小与耗时——单文件一行含三项；播放列表等批量下载在整批结束后逐文件输出路径+大小，并给出本批合计耗时；任务结束汇总文件数与下载总耗时。
- **下载过程日志**：解析（Extracting URL / Downloading webpage）、目标文件（Destination / Deleting existing file）、实时进度、合并（Merging）、跳过（has already been downloaded）、后处理等 yt-dlp 内部消息都会输出到 Actions 日志——不只是最终结果。进度按文件每 5 秒一行：`[进度] 文件名: 分片 x/y 45.3% 12.3MB/27.1MB 1.2MB/s 剩余 00:12`（分片字段仅 HLS/DASH 等分片下载有）。
- **覆盖与跳过**（输入 `overwrite` / 环境变量 `YTDLP_OVERWRITE`）：不勾选（默认）时，下载前逐个检查目标文件，已存在即跳过不下载（HLS 下载历史 `.ts` 文件、计划名是 `.mp4` 的情况也能正确识别，不会重复下载）；勾选时强制重新下载——yt-dlp 会先删除已存在的目标文件再下载（等价 CLI `--force-overwrites`），下载失败旧文件已被删除，需自行承担风险。播放列表按条目粒度：全部已存在 → 整个跳过；部分缺失 → 只下缺失条目。
- **yt-dlp 时效性**：workflow 每次 `pip install -U` 装最新版；仍可能遇到站点改版导致个别 URL 失败——脚本会跳过失败项继续下载其他 URL，最终以退出码 1 标记失败。
- **大播放列表/频道**：首次会解析两遍（先查目标文件再下载），`YTDLP_PLAYLIST_END` 可限制规模。
- **时区**：cron 使用 UTC，默认 `0 18 * * *` = 北京时间 02:00。
- **超时**：job `timeout-minutes: 360` 为 GitHub 托管 runner 上限，特大任务需拆分。
- **转码模式**（`YTDLP_TRANSCODE`）：三者语义不同——`remux` = 换 mp4 封装且**流直接拷贝**（秒级、无损、码率与体积基本不变；源编码不兼容 mp4 时 ffmpeg 报错）；`recode` = **重编码**为 H.264/AAC（慢、有损、体积与耗时都会明显变化，用于源编码不兼容 MP4 的场景）；`none` = 不转码。**转换依赖 ffmpeg**：yt-dlp 的 remux/recode 本身就是调用 ffmpeg（等价 CLI 的 `--remux-video` / `--recode-video`），workflow 会在运行前确保 ffmpeg 可用；**本地运行必须自备 ffmpeg**，缺失时脚本直接报错并以退出码 2 结束（不会下半天最后给你一个 TS）。**注意一个 yt-dlp 的坑**：HLS/m3u8 的格式 ext 通常是 `mp4`，原生 remux/recode 后处理器会按扩展名判断「已是 mp4」而跳过，实际转换落在 FixupM3u8 上——它只做流拷贝，导致 recode 名不副实（两种模式输出一模一样）。因此 recode 模式下脚本会关掉 yt-dlp 的 fixup，让 TS 内容保留到下载后的探测层**真正重编码**。**三种模式下脚本都会用 ffprobe 探测每个产物文件的真实封装格式**（ffprobe 缺失时退化为 TS 包头嗅探）：内容是 TS 流但扩展名是 `.mp4` 的——`none` 如实改名为 `.ts`，`remux` 流拷贝转换，`recode` 重编码转换（转换失败回退保留 `.ts`）；内容是 MP4 却叫 `.ts` 的改回 `.mp4`；名实相符的文件一律不动。注意：recode 重编码耗时较长，大视频留意 6 小时 job 上限。
- **aria2**：勾选后 workflow 自动安装；本地运行需 PATH 中已有 `aria2c`，否则脚本告警并回退内置下载器。aria2 主要加速直链/分片下载，HLS(m3u8) 仍走 yt-dlp 内置或 ffmpeg 下载器。
- **自定义请求头**（`YTDLP_HEADERS` / 输入 `headers`）：合并覆盖到所有请求（用户值优先于 yt-dlp 默认头）。格式二选一——单行 JSON 对象（Actions 输入框是单行的，推荐这个），或每行一个 `Name: Value`（本地运行，`#` 为注释）。头部里带 `Cookie` 会被 yt-dlp 自动加载为 cookies，可与 `YTDLP_COOKIES` 任选其一。日志只打印头部**名称**不回显值（值可能含 Token）；格式错误（JSON 坏、缺冒号、非法头部名）直接以退出码 2 失败，不会默默丢头让你在下载时才吃 403。
- **Cloudflare 反爬 403**（日志出现 `HTTP Error 403 caused by Cloudflare anti-bot challenge`）：站点用 TLS 指纹识别机器人，普通 HTTP 库必然被拦。解法是**浏览器指纹伪装**——输入 `impersonate` 填 `1`（或 `chrome`），脚本会让所有请求（网页/m3u8/分片）伪装成 Chrome 的 TLS 握手特征。依赖 `curl_cffi`（已在 requirements.txt，workflow 自动安装；本地 `pip install -r tools/ytdlp/requirements.txt`），未装时脚本启动即报错退出码 2。也可指定具体目标如 `safari`、`chrome-131`、`chrome:windows-10`。**两种 403 要分清**：① 报错含 `Cloudflare anti-bot challenge` / `cf-mitigated: challenge` → 指纹问题，伪装能解；② 开了伪装后仍 403、页面是 "Sorry, you have been blocked"（WAF 规则封锁，Error 1020）→ 与指纹无关，是站点按 IP/会话拦截——GitHub runner 和大多数 VPS 是机房 IP，会被这类站点直接拉黑，**换家庭宽带本地跑**才是最有效的；同时带上真实浏览器会话（`headers` 里设置视频页 `Referer` + `Cookie`，或配 `YTDLP_COOKIES`）。Cloudflare 策略升级时可能失效，届时更新 yt-dlp/curl_cffi 即可。
- **产物留存**：ytdlp **不上传 GitHub Artifact**（制品存储按套餐限额：Free 500 MB / Pro 1 GB / Team 2 GB / Enterprise 50 GB，与 Packages 共享且不支持提升）——runner 是临时的，需要文件就启用 `hf_upload` 传到 HF datasets，或本地运行；青龙面板仍用 Artifact 留存数据。

## qinglong 工具说明

在 GitHub Actions runner 上用 Docker 起一个[青龙面板](https://github.com/whyour/qinglong)，把控制端口（默认 5700）通过 Cloudflare Tunnel 映射成公网地址。runner 是临时的，**job 结束（保活到期 / 手动取消 / 360 分钟上限）后面板即销毁**，数据以 Artifact 形式留存。

### 快速开始

1. 打开仓库 **Actions → 青龙面板 + CF Tunnel → Run workflow**：
   - `cf_mode`：`quick`（默认，免密临时隧道）或 `token`（命名隧道，需先配 Secret）
   - `run_minutes`：保活时长，默认 360（= runner 上限，约 6 小时）
   - `ql_image`：镜像，默认 `whyour/qinglong:latest`；依赖兼容问题换 `whyour/qinglong:debian`
2. 运行后访问地址有两个来源：**Step Summary**（`青龙面板已启动` 摘要）和运行日志里打印的 `青龙面板访问地址：https://xxx.trycloudflare.com`。
3. 首次打开会引导初始化管理员账号——**立刻设置强密码**，临时隧道域名是公开可猜的随机地址。
4. 结束后的 `data/` 目录（配置、脚本、sqlite、日志）在 **Artifacts** 区下载 `qinglong-data`。

### 两种隧道模式

| 模式 | 地址 | 适用 |
|---|---|---|
| `quick`（默认） | 随机 `https://<随机子域>.trycloudflare.com`，每次运行都变 | 临时用、免配置；无 SLA，CF 可能随时回收 |
| `token` | Cloudflare 控制台配置的固定域名 | 长期用；需先在 Zero Trust 控制台建隧道 |

**命名隧道配置方法**（`cf_mode=token`）：

1. Cloudflare Zero Trust 控制台 → **Access → Tunnels → Create a tunnel**（选 Cloudflared），复制安装命令里的 Token。
2. 同一页面 **Public Hostname** 添加一条：`子域.你的域名` → 服务类型 HTTP → **URL 填 `http://127.0.0.1:5700`**（cloudflared 与面板同在 runner 上，走宿主回环）。
3. Token 存为仓库 Secret：`Settings → Secrets and variables → Actions → New repository secret`，名 `CF_TUNNEL_TOKEN`。
4. Run workflow 时 `cf_mode` 选 `token`。此模式下脚本无法预知公网域名，访问控制台配置的域名即可。

### 环境变量 / 输入对照

| 输入 | 环境变量 | 说明 | 默认 |
|---|---|---|---|
| `run_minutes` | `RUN_MINUTES` | 保活分钟数，0 = 跑到被取消/超时 | `360` |
| `cf_mode` | `CF_MODE` | `quick` / `token` / `none`（none = 只起面板） | `quick` |
| `ql_image` | `QL_IMAGE` | 青龙镜像 | `whyour/qinglong:latest` |
| — | `CF_TUNNEL_TOKEN` | 命名隧道 Token（Secret，勿写进仓库） | 空 |
| — | `QL_PORT` / `QL_CONTAINER` | 面板端口 / 容器名 | `5700` / `ql-toolbox` |
| — | `QL_DATA_DIR` | 数据目录（挂载 `/ql/data`） | `tools/qinglong/data` |
| — | `QL_TZ` | 容器时区 | `Asia/Shanghai` |
| — | `QL_STARTUP_TIMEOUT` | 等待面板就绪秒数 | `300` |
| — | `CLOUDFLARED_VERSION` | cloudflared 版本 | `latest` |

### 本地运行

```bash
# quick 隧道 + 5 分钟保活（本机需有 docker；cloudflared 会自动下载到 tools/qinglong/bin）
CF_MODE=quick RUN_MINUTES=5 python tools/qinglong/run_panel.py

# 只起面板，方便本地调试
CF_MODE=none RUN_MINUTES=0 python tools/qinglong/run_panel.py
```

### 数据持久化

- **默认（唯一方式）**：`data/` 在 `.gitignore` 中，结束后上传 Artifact `qinglong-data`（保留 7 天）。下次要用旧数据：下载解压到 `tools/qinglong/data/` 再跑（该目录不进 git，本地/Artifact 两路留存）。workflow 不往仓库提交任何文件。

### 注意事项

- **单实例**：workflow 带 `concurrency: cancel-in-progress: true`，重复触发会取消旧运行（避免 5700 端口和数据目录冲突）。
- **无 push 触发**：见「通用约定」例外；定时触发示例在 workflow 里注释着，默认关闭。
- **临时隧道不稳定**：`trycloudflare.com` 无 SLA，可能被回收或限速；重要用途用 `token` 命名隧道。
- **安全**：面板公网可达，初始化后立刻改强密码；不要把 `CF_TUNNEL_TOKEN` 等 Secret 写进任何提交。
- **镜像拉取**：首次 `docker pull` 可能耗时数分钟，`QL_STARTUP_TIMEOUT`（默认 300s）覆盖的是面板就绪等待，不含拉取时间。
- **青龙初始化**：首次启动要建库、装内置依赖，耐心等日志出现 `面板就绪`；失败时看 `docker logs`（runner 上）或 workflow 日志中的 `$ docker ...` 记录。

## one 工具说明

「ONE / 暮色」网页版（`https://j7tu.com/#/app`，Flutter Web）的**详情页取数器**油猴脚本（当前 `v2.18.0`）。详情路由是 `#/videoDetail`，文章 id 既不写在 URL 上也不落在 localStorage 里，唯一可靠的来源是 App 自己发出的那次 `POST /v2.5/article/detail` 的请求体（`base64(AES-128-CBC("id=<文章id>&dn=<ts域名>"))`）。脚本在 `document-start` 装上 XHR 钩子，解密请求体还原 id 与 `dn`，记下 App 真正使用的请求头，再用 one 模块 token 重取一次详情，把可点、可选中复制的完整播放链接铺出来；拿到链接后点 ⬇ 会**先铺一张单子**（选哪条链接、**发到哪**、文件名、请求头，M3U8 还问要不要转成 MP4，勾一下就顺带把产物传到 Hugging Face 数据集、上传目录可以直接在单子上改），确认了才真的发出去。出口有三个，可以只勾一个，也可以一次全勾：

| 出口 | 走什么 | 产物在哪 |
|---|---|---|
| GitHub Actions | MP4→`aria2.yml`，M3U8→`m3u8.yml` | 那次运行的 artifacts（勾了 HF 就传到数据集） |
| 本地 aria2 | aria2 JSON-RPC（`addUri` + `tellStatus` 轮询） | aria2 那台机器上的下载目录 |
| MediaGo | MediaGo HTTP API（`POST /api/downloads` + 轮询） | MediaGo 配置的保存目录 |

脚本自己没有 Python 入口，也不常驻任何 workflow——下载是你点 ⬇ 再点「✓ 确认发送」才发生的一次手动动作。

### 安装

1. Tampermonkey / Violentmonkey 新建脚本，把 `tools/one/one-detail-fetcher.user.js` 内容整体粘进去保存（或把文件拖进扩展的「已安装的用户脚本」）。
2. **`@grant none` 别改**：脚本靠跑在页面主世界才能拦到 App 的请求；改成有 grant 的沙箱形态会退化为「注入回传」，面板会显式说明拦不到。
3. **想发本地 aria2 / MediaGo 就再装一个伴生脚本** `tools/one/one-local-dispatch.user.js`（同样整段粘进 Tampermonkey）。它带 `@grant GM_xmlhttpRequest`，**没有界面、没有存储**，只做一件事：替主脚本把 HTTP 请求发到 `127.0.0.1` / 局域网地址，结果写回 `<html>` 上的属性。装好后刷新页面，⚙ 里会显示「本地转发脚本在线（v1.0.0）」；不装也能用，只是 ⬇ 单子里那两个勾是灰的，面板会写明原因。**为什么非拆成两个**：主脚本是 `@grant none`（拦 App 请求靠的就是它），而页面主世界的 `fetch` 打不通本地端口（CORS + 私有网络策略），只有 `GM_xmlhttpRequest` 能通、但它必须 `@grant`——一加 `@grant` 脚本就进沙箱、拦不到 App。所以特权的部分单独关在一个小脚本里。
4. 打开 `https://j7tu.com/#/app`，右下角出现悬浮球即注入成功（点球展开/收起，球可拖动，位置会被记住）。
5. 要用 ⬇ 发 GitHub 才需要这一步：⚙ 那组 GitHub 字段里粘一个 token（**fine-grained，只授权目标仓库、只给 Actions: write**），仓库/分支留默认即可（`owner/gh-toolbox` / `main`）。只取链接、或者只发本地 aria2 / MediaGo，就什么都不用填——没 token 时 GitHub 那个勾是灰的，其余照用。
6. 要用「☁ 传到 HF」那一勾，得先在**目标仓库**配 Secret：`ARIA2_HF_TOKEN` / `M3U8_HF_TOKEN`（HF 的 read+write dataset 权限），可选 `ARIA2_HF_REPO` / `M3U8_HF_REPO` 当默认数据集。脚本这边只填「传到哪个仓库、哪个目录」，**不经手 HF token**。

### 怎么用

- **进详情页**：在页面里点一张视频卡片，App 自己发 detail，状态条出现 `拦截到 id=… ✓`。
- **用模块 token 重取**：面板按钮，用当前「身份模式」再取一次同一 id 的详情，结果按 **正片/预告 × MP4/M3U8 四格**铺出；缺哪一格会写清是服务端没给、还是请求体没带 `dn`。
- **自动替换页面的 token**（⚙ 设置里的复选框，**默认关**）：开启后 App 自己发出的那些请求（详情/评论/点赞/下载…）在离开浏览器前就把 `token/uuid/user-key/sign/ip` 五个头一起换成所选身份，页面本身直接看到替换后的结果，不用再点按钮；关掉立刻原样放行。开关会被记住，下次进页面自动读回并重新挂载。`/purchase` `/buy` `/pay` `/coin` `/recharge` `/order` `/vip` `/sign_in` **永不替换**。
- **看拦截 / 诊断 / 复制 JSON**：分别回显拦到的原始请求与响应、钩子装在哪个世界（以及拦不到的原因）、把上一次解密出的 JSON 复制到剪贴板。
- **⬇ 发出去下载**：点一下先在面板里铺出**一张只对本次有效的单子**——① 每条可下载链接一个单选（`正片 MP4（域名）` / `正片 M3U8（域名）` / `预告 MP4（域名）`，默认选中 ⚙「下载格式」那条）；② **「发送到哪」一排勾**：GitHub Actions / 本地 aria2 / MediaGo，勾几个就发几次（互不影响，一次全勾也行）；③ `文件名 save_name`；④ 勾了 GitHub 且选了 M3U8 才露出「转成 MP4（mux_format=mp4）」复选框，**默认勾着**，不勾就是 `none`（产出分轨原文件，不合成）；⑤ 勾了 GitHub 才露出「☁ 传到 HF（hf_upload）」复选框 + 一栏**可改的上传目录 `hf_path`**（勾了才传，目录就是数据集仓库里的子目录，留空=根路径）；⑥ 勾了本地 aria2 才露出 RPC 地址/密钥/下载目录/多连接/覆盖；⑦ 勾了 MediaGo 才露出服务地址/API Key/保存子目录/删除分段；⑧ `请求头 headers`（**开单子时就把 `User-Agent` 与来源 `Referer` 写在这栏里**，再加上 ⚙ 里那条额外的，所以栏里看到的这一串就是最终发出去的那一份：改哪条发哪条，删掉哪条就不带哪条，整栏清空就是这次不带自定义头；**三个出口共用这一栏**）。改完点「✓ 确认发送」才发，点「取消」一个字都不发。面板随后逐行回显每个出口实际发了什么，以及进度（GitHub 是运行状态，aria2 是百分比/速度/落盘路径，MediaGo 是任务状态/产物文件名）。
- **⚙ 里那组 GitHub / HF / 本地字段 = 单子的默认值**：仓库、分支、下载格式（决定单子里默认选中哪一条）、GitHub token、额外请求头（**这里只存你额外要带的那几条**，`User-Agent` 与来源不落盘——落盘了就是一份迟早过期的 UA，理由见下条），加上 Hugging Face 三项——数据集仓库 ID（`owner/name`，直接粘 `https://huggingface.co/datasets/...` 也认；留空=用仓库 Secret 兜底）、上传目录默认值、以及「默认勾上 ☁ 传到 HF」；再加上本地出口那一组——aria2 RPC 地址 / RPC 密钥 / 下载目录 / all-proxy / 默认多连接，MediaGo 地址 / API Key / 保存子目录 / 默认删分段，以及两个「测试连接」按钮（分别用 `aria2.getVersion` 与 `GET /api/downloads` 探活，失败时把常见原因直接写在面板上）。这些勾和输入框与单子写回的是同一批键（`one_aria_*` / `one_mg_*` / `one_gh_hf` / `one_gh_hf_path` / `one_gh_mux` / `one_dl_targets`），所以在单子上改过一次，⚙ 里下次打开看到的就是它，两边不会各存一份对不上。

### 本地 aria2 / MediaGo 出口（v2.18）

单子上「发送到哪」那排勾里的后两个，不经过 GitHub，直接把地址交给本机的下载器。链路是两段的，⚙ 里写着它现在是哪一段：

1. **主脚本 → 伴生脚本**：`<html>` 上的 `data-oneqz-local` 属性（一个只增的队列，每条带唯一 id）——和「自动替换 token」用的 `data-oneqz-repl` 同一套跨世界桥法。只用字符串，不跨 realm 传对象，所以 Chrome / Firefox 都不会踩 `Permission denied`。
2. **伴生脚本 → 本地服务**：`GM_xmlhttpRequest`（绕开同源与私有网络限制），回应写到 `data-oneqz-local-res`，主脚本按 id 认领。

具体行为：

- **aria2**：`aria2.addUri`，选项包括 `out`（就是单子上那个文件名，MP4 没后缀自动补 `.mp4`；M3U8 用 `.m3u8`）、`dir`（下载目录）、`header`（单子那一栏的 headers，逐条 `Name: Value`）、`all-proxy`、`allow-overwrite`、`auto-file-renaming=false`；勾了多连接再加 `split=16` / `max-connection-per-server=16` / `min-split-size=1M`。拿到 gid 就返回，进度在后台用 `aria2.tellStatus` 每 3 秒刷（状态 / 百分比 / 速度 / 落盘路径），面板只在状态、5% 档位或「在不在跑」变化时才写一行。
- **MediaGo**：`POST /api/downloads`，`tasks: [{ type, url, name, folder, headers, deleteSegments }]` + `startDownload: true`；`type` 按链接判定（`.m3u8` → `m3u8`，其余 → `direct`）。`name` **不带后缀**（后缀由 MediaGo 按类型补）。拿到任务 id 后用 `GET /api/downloads/<id>` 轮询状态（等待中 / 下载中 / 完成 / 失败 / 已停止 / 产物文件名）。
- **不需要选画质**：这里发的是详情接口给出的那条具体清单（`/api/video/getM3u8.m3u8?params=…`），不是多码率 master，所以没有「选哪一档」这回事——和 `m3u8-dispatch.user.js` 在视频站抓到的 master 播放列表不同，那里必须先选流再发。
- **三个出口互不排队**：勾全了也是每个出口各自下发，本地两条拿到任务 id 就返回（进度转后台），不会因为 GitHub 那边要排队几分钟而让 aria2 迟迟不动。两个本地出口的轮询各有各的代次号，再发一次 aria2 不会把 MediaGo 的轮询掐掉。
- **aria2 原版不解析 HLS**：勾了 aria2 又选了 M3U8 时，面板会明确写一句「这条多半只会下到播放列表本身」，要分片得用 `aria2-next` 之类支持 HLS 的构建，或者改发 GitHub 的 `m3u8.yml` / MediaGo。「测试连接」也会报「支持 / 不支持 HLS」。
- **伴生脚本没装时不骗人**：⚙ 里写「⚠ 没检测到本地转发脚本」，⬇ 单子里那两个勾是灰的、并写明原因；诊断里也有一行「本地转发 …」。装好后刷新一次页面即可（元数据只在安装时读，`@match` 是 `j7tu.com`）。

> **安全边界（这条得说清）**：主脚本跑在页面主世界，它写在 `<html>` 上的东西 `j7tu.com` 自己的 JS 也看得见、也能往里塞请求。所以伴生脚本并不能做到「只有主脚本能用」，它把口子收窄成三条：① 只发往 loopback 与私网地址（`127.0.0.1` / `localhost` / `10/8` / `172.16-31` / `192.168/16` / `169.254/16`，域名一律拒绝）；② 只认白名单里的操作（aria2 那几个 JSON-RPC 方法、MediaGo 的 `/api/downloads` 系列路径，且归一化后再确认一次没跑出这个前缀）；③ 单条请求体上限 256 KB。最坏情况是「这个站点的 JS 也能往你自己的 aria2 / MediaGo 里塞任务、看任务列表」——它本来就在同一台机器上和你一起用这两个服务——但拿不到更多东西，也去不了公网和别的内网主机。

### ⬇ 下载触发的细节

- **只发 workflow 声明过的 input**：`m3u8.yml` / `aria2.yml` 的 `inputs:` 里没写的 key 一律不发——多写一个 key GitHub 会整个 422（`Unexpected input`）。脚本发 `urls` + `save_name` + `headers`（后者的值见下条），**选了 M3U8 才多带 `mux_format`**（`aria2.yml` 没有这个 key，MP4 那条带上就是 422），勾了「传到 HF」才多带 `hf_upload` / `hf_repo` / `hf_path`（这三条两个 yml 都声明过，投给哪条都收得下），其余参数留在 workflow 的默认值上。**没勾 GitHub 那条就一个 GitHub 请求都不发**（本地出口跟 GitHub 完全无关，不需要 Token）。
- **请求头：UA 与来源是铺进那一栏给你看的，不是后台默默补**（`v2.17` 改的就是这一点，`v2.18` 起本地两个出口也用这同一栏）。开单子时脚本先把两条写进 `headers` 输入框——`User-Agent` 取当前页面 `navigator.userAgent` 那一串，`Referer` 取本站 origin（`https://j7tu.com/`；详情页的 `#/videoDetail` 路由对服务器没有意义，所以不带上）——再把 ⚙ 里那条额外的并进去（同名以 ⚙ 为准），⚙ 里那栏底下会同一时刻印出「单子里那一栏会铺成：{…}」，两处逐字相同。随后**栏里是什么就发什么**：改一条发一条，删掉 `User-Agent` 那条就真的不带它，整栏清空就是这次不带任何自定义头（面板会另起一行点破：媒体域对没有 UA/来源的直连常会拒绝）。只有栏里写成了「不是 JSON 对象」的东西才退回自动那两条，而面板会改口写明这次是退回而不是照栏子发。头名大小写不敏感（`ua` / `referer` 也归一化成 `User-Agent` / `Referer`），显式写成空串等于「这条不要」。⚙ 之所以只存额外那几条、不把这两条一起存：这个脚本是 `@grant none`，设置落在 j7tu.com 的 localStorage 里，UA 一旦落盘，浏览器升级后发出去的就是过期那串。最终那一串 JSON 原样进 `inputs.headers`（GitHub），本地两个出口则各自转成 `Name: Value` 数组（aria2 `header`）与逐行文本（MediaGo `headers`）。
- **文件名后缀规则三个出口各不相同**（这是最容易想当然的一处，脚本按各家的实现分别处理）：`aria2.yml` 是 `aria2c -o <save_name>` 原样落盘，不给扩展名就得到一个没扩展名的文件 → **MP4 那条自动补 `.mp4`**（单子上自己写了 `.mkv` 就尊重你写的）；`m3u8.yml` 的 `--save-name` 反过来**不能带后缀**，N_m3u8DL-RE 按 `mux_format` 自己补，传 `x.mp4` 会落成 `x.mp4.mp4` → M3U8 那条在发出去前把后缀剥掉；本地 **aria2** 跟 `aria2.yml` 一样是 `-o` 原样落盘（同样自动补后缀），**MediaGo** 的 `name` 反过来不带后缀（后缀按链接类型由它补）。单子上改选另一条格式、或改勾出口时，输入框里的名字会当场按「当前实际要发的那一组出口」的规则重排（你手打过的部分保留，只动后缀）。默认名取详情标题（去掉非法文件名字符），预告那条再加「 预告」。
- **「转成 MP4」「传到 HF」、上传目录、本地那几个连接参数都会被记住**：分别存进 `one_gh_mux`、`one_gh_hf`、`one_gh_hf_path`、`one_aria_*`、`one_mg_*`（`1`/`0` + 原文），下次开单子、刷新页面都读回来；⚙ 里那几组字段就是这些键的编辑入口（也是单子的默认值），两边共用同一个键、不会打架。单子上其余两项（选哪条链接、文件名）每次重新铺默认值，故意不记——记着上一次的容易把预告当正片发出去。没点「✓ 确认发送」而点「取消」时，一个字都不写回。
- **传到 Hugging Face 的那一步**：勾了单子上的「☁ 传到 HF」才发 `hf_upload=true`，产物由 workflow 用 `HfApi` 按 **dataset 仓库**上传（`upload_folder`），落到 `hf_path` 指的那个仓库内子目录（留空=根）。**HF 的 token 不经过脚本**：只从目标仓库的 Secret 读 `ARIA2_HF_TOKEN` / `M3U8_HF_TOKEN`；`hf_repo` 留空时退到 Secret `ARIA2_HF_REPO` / `M3U8_HF_REPO`，两边都没有就是「记下失败并跳过上传」（下载本身不受影响）。仓库不存在时服务端按 `private` 建（由 Secret `<tool>_HF_PRIVATE` 决定，默认 `true`），已存在的仓库不会被脚本改可见性。
- **`urls` 只放一条裸链接**：两个 workflow 的 `parse_urls` 都按换行分割、逗号也算分隔符，所以清单里不能出现空格/逗号/多条（M3U8 那条 `params` 里本身没有逗号，MP4 直链也没有）。
- **204 不返回运行 id**：dispatch 成功只给 204，脚本改从 `…/runs?per_page=5&event=workflow_dispatch` 里按 `created_at >= 触发时刻-30s` 认那一次，认不到就明说（避免把一小时前的旧运行当成刚触发的）。轮询期间再点 ⬇ 会作废上一次轮询。
- **`@grant none` 的代价**：主脚本没有 `GM_xmlhttpRequest`，GitHub 那一发 POST 是**用页面自己的 fetch 从 `j7tu.com` 这个源跨域打到 `api.github.com`**（OPTIONS 预检 + 响应都要过，GitHub 回 `Access-Control-Allow-Origin: *`，实测通）。Token 也因此存在 j7tu.com 的 localStorage 里，**请只用「只授权这一个仓库 + Actions: write」的 fine-grained token**，别拿账号级 PAT。本地 aria2 / MediaGo 打不通也是同一个原因（CORS + 私有网络策略），所以才需要那个带 `@grant` 的伴生脚本。
- **M3U8 那条会过期**：`params` 是这次详情临时生成的，runner 排队+启动要几十秒到几分钟；面板会打印这条详情距今多少秒，过期就重新取一次详情再点 ⬇。
- **失败都有名字**：401（token 无效/过期/没 Actions 权限）、403（私有仓库没覆盖到 / 防滥用限制）、404（token 看不到这个仓库，或 owner/repo、workflow 文件名写错）、422（该分支上的 yml 没声明这次发的 inputs），`action_required` 会提示去 Actions 页面点 Run job（私有仓库额度用完会卡在这）。
- **仓库写法**：⚙ 的「仓库」框粘 `https://github.com/owner/repo.git`、`git@github.com:owner/repo.git` 或 `owner/repo` 都认，会被归一化成 `owner/repo` 再存；写坏了自动退回默认 `owner/gh-toolbox`。

### 域名与字段（脚本按此拼链接）

- **MP4**：`detail.video_file` / `preview_video` 是根相对路径，必须拼**媒体域名池**（`domain.video`，如 `https://z4bey8.bx7qxb.com`）才 206；拼到请求体里的 `dn`（ts 域）上会 404。播放域名可在 ⚙ 里手填，留空则先取页面自己正在播的那次请求的域，再退种子。
- **M3U8**：`video_hls` 是 `/api/video/getM3u8.m3u8?params=<hex>`，要拼 **api 域**；`params` 每次 detail 重新生成且很快失效，必须取完立刻用。请求体**不带 `dn` 时服务端只回 MP4**，`dn` 还会被原样回显进清单里的 `*.ts` 分片域名。
- **清单只有一个槽位**：接口没有「预告清单」字段，`video_hls` 跟着 `video_file` 走 —— 解锁态装的是正片清单，锁定态装的就是预告清单。所以四格里「预告 · M3U8」永远为空，不是脚本漏了。
- **身份决定裁到哪一刀**：同一 id 用网页账号可能是锁定态（`video_file === preview_video`），用 one 模块 token 是解锁态；`size` 是服务端元数据，两种状态下都一样，不能拿来判断有没有拿到正片。

### 注意事项

- 只匹配 `j7tu.com`（`@noframes`），只做「拦请求 + 重取详情 + 打印链接」，**不调用购买/扣币接口，脚本自己一个字节都不下**；⬇ 只是把链接投给你自己的下载通道——下哪条、发到哪（GitHub / 本地 aria2 / MediaGo，可多选）、叫什么名字、要不要转封装、传不传 HF 数据集、传进哪个目录、带哪些请求头（`headers` 那一栏里写的就是发出去的那份，UA 与来源也是铺在栏里的），都是你在单子上自己填完再点「✓ 确认发送」的，点「取消」不发任何东西、也不改任何被记住的默认值。
- 内置的 one 模块 token 带 `exp`，到期后在 ⚙ 的「模块 token」框里粘新的（会覆盖内置值并被记住）。
- 改过脚本要**刷新页面**再测：同一文档里留两层钩子时，状态条会显示 `⚠页面里有 N 层钩子`。
- 面板里所有链接都是 `target=_blank` + `rel=noopener noreferrer`，且整行文字可选中复制；服务端字段里的尖括号只当文字处理，不拼 innerHTML。
