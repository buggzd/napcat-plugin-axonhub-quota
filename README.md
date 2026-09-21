# AxonHub 订阅额度 · NapCat 插件

作者：[buggzd](https://github.com/buggzd)

> **安装前请注意：已确认 NapCat v4.18.28 限制非官方插件加载，并移除了 ZIP 导入接口。** 插件目录还在却不显示、日志出现 `not in official plugin whitelist` 时，请先阅读下方[新版 NapCat 安装限制与处理方法](#新版-napcat-安装限制与处理方法)。

在 QQ 中查询 AxonHub 已启用 Codex 渠道的上游订阅窗口，返回接近 AxonHub 深色面板的 PNG 卡片。直接读取 AxonHub 网页接口，运行在现有 NapCat 进程内；无浏览器、无数据库、无额外常驻服务。图片使用随包附带的 resvg WASM 渲染器，不需要运行时安装 npm 包。

## 使用

- `/help`：查看指令、绑定方式和查询权限。白名单群内需 `@机器人 /help`；私聊开放个人绑定时无需先绑定即可获取帮助。

- 允许的群：`@机器人 /额度`。白名单群里的所有成员都可查询，必须真正 @机器人。
- 允许的私聊用户：`/额度`。与群名单独立，留空即关闭。
- 默认输出图片：渠道名称、状态、已用百分比、时间进度、北京时间的重置时间；接口提供时显示可用重置次数、最早到期时间及预计周期额度。图中百分比与 AxonHub 一致，表示**已用量**，灰条表示**时间进度**。
- 预计周期额度沿用当前站点截图的美元显示，不将估算值当作余额；没有估算字段时不显示此项。图片生成或发送失败时自动回退原来的剩余额度文字回复。
- 只显示 AxonHub 返回的窗口；主窗口也可能是每周，不会凭空增加一个 5 小时窗口。
- 用户私聊机器人发送 `/绑定APIKEY 你的Key` 自动绑定，也支持直接发送 `sk-` 开头的 Key；服务账号/禁用 Key 不接受。插件仅保存 QQ、用户 ID、Key ID 与显示名，不保存 Key 原文。QQ 本身的聊天记录仍保留发送内容。
- 私聊 `/绑定账号 账户名`（或直接发送账户名）提交待确认申请，管理员在扩展页核对后选择对应用户确认；不会仅凭名字授予查询权限。
- 已绑定用户私聊 `/用量`、`/今日用量`，或白名单群内 `@机器人 /用量`，返回今日金额、Tokens 和调用次数的深色图片。只能查发送者自己，无法指定别人账号。`/绑定状态`、`/解绑` 仅限私聊。
- “允许私聊绑定及查询个人用量”默认开启，与私聊 `/额度` 白名单分开；关闭后停止自助私聊绑定和个人查询入口（已有白名单用户仍可查询自己的用量）。
- 渠道过滤：扩展页点击“刷新渠道与绑定”，选择“只显示勾选渠道”，勾选一个或多个后保存。按渠道 ID 过滤；空选择/已删除渠道不会回退显示全部。所有群共用，不影响个人用量统计。
- 本版没有定时推送或上游强制刷新。

## 构建和安装

本地构建/测试需要 Node.js 22.6+、npm，以及系统 `zip` 命令。产物面向 Node.js 20+ 的 NapCat 运行环境。

```sh
npm ci
npm run typecheck
npm test
npm run build
# 仅适用于仍提供 ZIP 导入接口的 NapCat 版本
npm run deploy
```

构建生成 `dist/` 和 `napcat-plugin-axonhub-quota.zip`，含图片 worker、渲染器及第三方声明。`deploy` 从本地 Docker 容器读取现有 NapCat WebUI 凭据，导入 ZIP 并启用本插件，不重启容器或其他插件，也不打印凭据。

图片渲染使用容器已有的文泉驿正黑或 Noto CJK 字体；当前 NapCat 镜像已包含文泉驿。也可以通过 `AXONHUB_QUOTA_FONT` 指定本地中文字体文件。字体不可用时回退文字，不下载远程字体。

默认容器 `napcat`、WebUI `http://127.0.0.1:6099`；可通过 `NAPCAT_CONTAINER`、`NAPCAT_WEBUI_URL` 覆盖。也可以在 NapCat 插件管理中手动导入 ZIP 后启用。

## 新版 NapCat 安装限制与处理方法

已确认 **v4.18.28** 存在以下限制；其他版本请检查实际源码和接口，不要只根据版本号推断兼容性：

- 插件加载器的 `OFFICIAL_PLUGIN_IDS` 写死了四个官方 ID，未在名单中的插件不会出现在管理列表。
- ZIP 导入接口 `/api/Plugin/Import` 已移除。因此，`npm run deploy` 或旧教程的导入方式可能收到 HTML 页面并报 JSON 解析错误；单纯重装插件不能解决白名单限制。
- 没有发现该版本提供自定义插件开关或开发者模式。官方代码见 [loader.ts](https://github.com/NapNeko/NapCatQQ/blob/v4.18.28/packages/napcat-onebot/network/plugin/loader.ts)，维护者说明见 [Issue #1897](https://github.com/NapNeko/NapCatQQ/issues/1897#issuecomment-4677893835)。

### 保留新版：本机添加插件白名单

这是对自己部署的 NapCat 的**非官方本地修改**。只添加你信任的插件 ID，不需要关闭整个加载检查，也不要将插件冒名改为官方插件。

以下以 Docker 容器名 `napcat`、程序目录 `/app/napcat` 为例；其他安装方式替换为实际路径。操作前先构建本插件：`npm ci && npm run build`。

1. 备份 NapCat 程序、配置和插件。配置备份包含凭据，请保存到仓库之外的私有目录：

   ```sh
   umask 077
   recovery_dir="$(mktemp -d "${TMPDIR:-/tmp}/napcat-recovery.XXXXXX")"
   docker cp napcat:/app/napcat/napcat.mjs "$recovery_dir/napcat.mjs.original"
   docker cp napcat:/app/napcat/config "$recovery_dir/config"
   docker cp napcat:/app/napcat/plugins "$recovery_dir/plugins"
   cp "$recovery_dir/napcat.mjs.original" "$recovery_dir/napcat.mjs"
   ```

   记住该目录位置，并将需要长期保留的备份移至私有持久目录；临时目录可能被系统清理。

2. 在编辑器中打开 `$recovery_dir/napcat.mjs`，搜索 `napcat-plugin-qce`，定位同时包含以下四个 ID 的 `new Set([...])`：

   ```js
   new Set([
     "napcat-plugin-builtin",
     "napcat-plugin-cleaner",
     "napcat-plugin-ssqq",
     "napcat-plugin-qce",
     "napcat-plugin-axonhub-quota"
   ])
   ```

   **只在这个集合末尾添加 `napcat-plugin-axonhub-quota`**，保留原变量名和其余代码。若结构不同或找到多个位置，先检查版本源码，不要全文替换检查逻辑。其他自有插件可按各自 `package.json` 的 `name` 添加；例如 TheWatcher 的 ID 为 `napcat-plugin-lol-watcher`。

3. 将修改后的程序及本插件构建产物写回。只复制 `dist`，不要把自己的配置或整个开发目录覆盖进去：

   ```sh
   docker cp "$recovery_dir/napcat.mjs" napcat:/app/napcat/napcat.mjs
   docker exec napcat mkdir -p /app/napcat/plugins/napcat-plugin-axonhub-quota
   docker cp dist/. napcat:/app/napcat/plugins/napcat-plugin-axonhub-quota/
   docker restart napcat
   ```

4. 等机器人重新登录后，打开 WebUI 插件管理，启用 **AxonHub 订阅额度**，再到插件扩展页保存管理员配置和白名单。已有配置与绑定不会因复制插件文件而删除。先在扩展页预览，再测试 `/help` 和 `/额度`。原本停用的其他插件不会因为加入白名单就自动启用。

5. 如果修改后无法启动，使用备份恢复程序并再次重启：

   ```sh
   docker cp "$recovery_dir/napcat.mjs.original" napcat:/app/napcat/napcat.mjs
   docker restart napcat
   ```

**更新 NapCat 可能覆盖这项修改。** 更新后先检查白名单结构，再重新添加 ID。程序补丁与插件目录持久化是两件事：Docker 重建要保留 `/app/napcat/config` 和 `/app/napcat/plugins` 的挂载，同时保留 QQ 登录数据。为已有容器增加挂载前须迁移原数据，避免用空目录遮住现有配置。

### 不修改新版程序

也可以使用已验证支持自定义插件的旧版本（本插件曾在 v4.16.0 正常运行），但应自行评估旧版兼容性与维护成本。通过 OneBot 运行独立服务是另一种架构；**本仓库目前只提供原生插件，尚未实现独立 OneBot 服务模式**。

## 配置

登录 NapCat WebUI，打开插件扩展页 **AxonHub 额度设置**：

1. 填写你自己的 AxonHub 地址、管理员邮箱和密码；默认地址 `https://axonhub.example.com` 仅为占位示例。
2. 填写允许的群号和私聊 QQ 号，支持空格、逗号或换行分隔。
3. 保存，点击「查询额度」预览；预览不会发送 QQ 消息。

普通插件配置面板也能调整地址、邮箱及白名单。密码只在扩展页的密码框输入，保存后输入框清空，任何配置读取接口均不返回密码。留空保留原密码；勾选「清除已保存密码」才会删除。账号/站点/白名单保存后会取消旧请求、清除登录态与缓存。

配置默认保存到容器内 `/app/napcat/config/napcat-plugin-axonhub-quota/settings.json`，目录权限 `0700`、文件 `0600`，利用现有 Docker 配置卷持久化。密码保存在此受文件权限保护的文件中，不是加密保险库；JWT 仅保存在内存。非此 Docker 布局可设置 `AXONHUB_QUOTA_CONFIG_DIR`；否则使用 NapCat 提供的配置路径旁的专属目录。

插件程序本身仍位于 NapCat 的插件目录。若该目录没有挂载卷，**重建容器后需要重新导入 ZIP**；配置卷保留时无需重新填写账号。卸载插件后若要删除保存的密码，应先在设置页清除密码，或自行删除专属配置文件。

## 数据与限制

- 登录：`POST /admin/auth/signin`，邮箱/密码换取内存令牌。
- 查询：`POST /admin/graphql`，`queryChannels` 按 50 条分页，过滤 `enabled`、`codex`；只取身份、状态及 `providerQuotaStatus`，不取渠道凭据。保留 `providerType` 选择字段以兼容当前服务器的额度解析器。
- 使用与网页一致的 `_limits` 数据计算已用量、周期起止及估算费用；无归一化数据时回退 `rate_limit` 的 `used_percent`、`reset_at`。文字剩余量为 `max(0, 100 - 已用百分比)`。未知值显示“未知”，过去的重置时间标记等待更新，不自动推算为满额。
- 缓存 60 秒，并发请求合并；无后台轮询。每个 QQ 用户跨群共享 5 秒冷却，冷却期间重复消息忽略。
- 每个 HTTP 请求超时 10 秒、响应上限 1 MiB。最多读取 100 页；分页重复或超限时报错，不输出不完整清单。最多同时处理 32 条 QQ 命令。
- 登录失效重新登录并重试一次；登录失败冷却 30 秒。失败时不回退到过期缓存，也不将原始响应/凭据写入日志或消息。
- 图片按渠道分页，以 2 倍清晰度渲染成宽 800 像素的 PNG，通过 OneBot `image` 段发送；SVG 只含转义后的文字与本地几何图形，不加载网页或远程资源。文字回退每段不超过 1800 字符，不解析渠道名称中的 CQ 码。
- 同一份 60 秒数据缓存复用同一张图片；并发渲染合并。渲染时创建临时 worker，完成后终止并释放字体、WASM 堆及像素缓冲。常驻只保留当前 PNG，不常驻渲染器。最多 20 页、8 MiB Base64 缓存，渲染超时 20 秒，超限回退文字；配置变更和卸载取消渲染。

读取时间是插件向 AxonHub 读取数据的时间，**不是上游额度实时更新时间**。上游采集可能延迟，插件不调用刷新额度或重置额度的 mutation。

## 接口与验证

扩展接口均位于 NapCat WebUI 鉴权之下，不注册 `NoAuth` 接口：

| 接口 | 行为 |
| --- | --- |
| `GET /api/Plugin/ext/napcat-plugin-axonhub-quota/config` | 返回非敏感配置、空密码和 `hasPassword` |
| `POST /api/Plugin/ext/napcat-plugin-axonhub-quota/config` | 保存配置；空密码保留，`clearPassword: true` 清除 |
| `GET /api/Plugin/ext/napcat-plugin-axonhub-quota/preview` | 返回额度摘要、文字回退和 `images` PNG Base64 数组，不发送 QQ 消息 |

```sh
npm run verify:live
npm run verify:live -- --stress
```

真实验证读取当前已保存配置。`--stress` 追加 150 次管理页预览来检查缓存，打印整个容器内存，不能据此精确计算插件独占内存。不会发送 QQ 测试消息。

单元和集成测试覆盖：窗口字段与北京时间、未知/失败/耗尽、长消息、白名单与 @、冷却、并发合并、缓存过期、登录重试、密码冷却、分页、超时、取消、响应大小限制、脱敏和私有持久化、配置变更清理以及加载/卸载；另验证卡片信息、SVG 转义与分页、真实 worker PNG、图片缓存/取消、QQ 图片段和发送失败的文字回退。

本次实际联调和限制见 [验证记录](VERIFICATION.md)。

## 个人用量与绑定实现（1.2.0）

- 沿用管理员网页接口，以用户提交 Key 作为 `APIKeyWhereInput.key` 精确匹配条件，只返回身份和状态字段，不拉取 Key 列表原文。Key 验证成功即授权查询其所属个人账号的全部 API Key 用量。使用共享个人 Key 会共享该账号查询权限，请为不同用户建立独立 AxonHub 账号。
- `analyticsOverview(filter)` 始终带一个明确 `userIDs`，从站点时区生成同一天的 `startTime/endTime`（YYYY-MM-DD）。例如站点时区为 Asia/Shanghai 时，按 UTC+8 日历日统计。金额使用站点币种，不添加缓存输入 Tokens 到总数。
- 调用次数是 AxonHub UsageLog 用量记录数，并非包括全部失败请求的请求日志数；数据以 AxonHub 已入库记录为准。
- 用量按用户、绑定 Key ID、日期、时区、币种隔离缓存 60 秒（最多 128 个），相同查询合并；账号和 Key 状态在新查询时验证，停用/删除后最多有 60 秒缓存延迟。元数据时区/币种缓存 10 分钟。查询跨日时要求重试。
- 绑定申请每 QQ 30 秒冷却、最多 256 条，提交新申请时清理超过 7 天的申请；绑定最多 4096 个。持久化文件 `bindings.json` 与配置同目录，权限 0600；没有密码或 Key 原文。更换站点清空绑定与渠道选择。
- 多用户图片共用同一个临时渲染队列，仅保留最近结果，不为每个用户常驻一个进程或图片缓存。
