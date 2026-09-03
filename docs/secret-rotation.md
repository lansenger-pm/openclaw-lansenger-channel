# 蓝信 AppSecret 轮换 SOP（openclaw-lansenger-channel）

> 适用版本：v3.18.6+。v3.18.5 及更早版本无 token 自愈，也请按本 SOP 操作（第 3 步重启后即恢复）。

## 场景

你在蓝信管理平台（开平后台）**重置 / 重新生成了应用的 AppSecret**，需要让 OpenClaw 的 lansenger 渠道恢复工作。

原理速览：插件出站发消息用的是 `appToken`（由 AppSecret 换取，默认缓存 ~115 分钟）。密钥重置后：

- **仅 token 失效、secret 未变**（服务端清理 token 缓存/重启）：v3.18.6 会自动重刷 token 并重试，**无需任何操作**。
- **AppSecret 已轮换**：插件本地配置里还是旧密钥，刷新会被服务端拒绝（errCode 40018）。必须完成下面第 1、2 步。

## 操作步骤

### 1. 把新密钥写入 OpenClaw 配置

```bash
# 单账号
openclaw config set channels.lansenger.appSecret "新的appSecret"

# 多账号（把 <账号键> 换成 accounts 下的配置键，如 main / log-report）
openclaw config set channels.lansenger.accounts.<账号键>.appSecret "新的appSecret"
```

或者用交互向导：

```bash
openclaw channels add --channel lansenger --token "appId:新的appSecret"
```

> ⚠️ 向导在“已有配置”时会先问 **是否保留现有 App Secret** —— 你是要轮换，请选择**替换**并输入新值。

如果你使用 **SecretRef / 环境变量**（`LANSENGER_APP_SECRET` 等）：密钥解析自**网关进程的环境变量**，更新环境来源（启动脚本 / LaunchAgent plist）后必须重启网关进程，仅改 secrets 存储不生效。

### 2. 重启网关

```bash
openclaw gateway restart
```

重启后插件会用新密钥重建连接并刷新 token。

### 3. 验证

```bash
# 网关日志中应出现刷新成功、不再出现 40018：
tail -f /tmp/openclaw/openclaw-$(date +%F).log | grep -E "getAppToken|40018"
#   期望: getAppToken: refreshed (expires in 7200s)
#   异常: getAppToken: errCode=40018 ...  ← 密钥仍不对

# 渠道状态（v3.18.6+ 可见 token 健康度）：
openclaw channels status
#   token.lastRefreshResult 应为 "ok"；若为 "rejected" 见上方日志指引

# 实际发一条消息给机器人确认端到端恢复
```

## 常见误区

| 现象 | 原因 |
|---|---|
| 重置密钥后“收消息正常、发消息被拒” | 入站走 WS 长连接（不验密钥），出站走 appToken（已失效）——不代表插件在线状态正常 |
| 跑了 `channels add` 但没生效 | 向导问“是否保留现有凭证”时选了保留；重新跑并选择**替换** |
| 改了 env 但没生效 | 环境变量在网关进程启动时注入，必须重启网关进程 |
| 改了密钥但没重启，说“过一会儿自己好了” | 旧 token 缓存最长 ~115 分钟；期间所有出站持续被拒，缓存过期后转为无法获取 token，不会自愈（v3.18.5-） |
