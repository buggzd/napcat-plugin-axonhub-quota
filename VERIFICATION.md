# 验证说明

## 自动检查

```sh
npm ci
npm run typecheck
npm test
```

测试涵盖窗口解析、缺失数据、分页、权限与群内 @、登录重试、缓存、请求合并、超时、图片渲染、用户绑定隔离、跨日统计、渠道过滤和 `/help`。

## 可选部署验证

以下命令需要你自己的本地 NapCat Docker 容器及已配置的 AxonHub 管理员账号：

```sh
npm run deploy
npm run verify:live
node --experimental-strip-types scripts/verify-personal.mjs
```

- 部署脚本读取本地容器已有 WebUI 凭据，仅在内存中使用，不输出凭据。
- 额度验证检查插件状态、未登录访问限制、密码脱敏和 PNG。输出可能包含你的渠道名称与额度，不要将终端输出直接发布。
- 个人验证读取真实用户及用量，生成 `artifacts/usage-preview.png`，不创建 QQ 绑定、不发送消息。该图片包含个人用量，已在 Git 忽略规则中排除。
- 有效 API Key 自动绑定、群聊/私聊实际收发，需使用你自己的测试账号完成端到端验证。不要把真实 Key 写入测试夹具或提交聊天截图。
- `node scripts/verify.mjs --stress` 执行 150 次缓存预览并记录整容器内存。读数包含 QQ、NapCat 和垃圾回收波动，不能当作插件独占内存或长期稳定性结论。

公开源码不包含部署站点、群号、用户绑定、真实用量、截图或运行时配置。测试中的账号、Key 和 ID 均为虚构数据。
