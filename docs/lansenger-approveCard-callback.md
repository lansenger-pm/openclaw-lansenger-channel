# 蓝信 approveCard 按钮点击回调文档

## 概述

蓝信 `approveCard` 消息的按钮点击后，蓝信服务端通过 WebSocket 推送回调事件，事件类型为 `approve_card_callback`。

## 发送 approveCard 时的 button 配置

在发送 `approveCard` 消息时，每个 button 可以设置以下字段来控制按钮权限和行为：

```json
{
  "text": "批准一次",
  "buttonTheme": 1,
  "state": 0,
  "callbackInfo": "ea:once:123",
  "permissionScope": {
    "permittedStaffs": ["staffId1", "staffId2"],
    "prohibitedStaffs": ["staffId3"]
  },
  "prohibitedState": 1
}
```

### button 字段说明

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `text` | string | 否 | 按钮文案 |
| `buttonTheme` | int | 否 | 按钮样式：0-无效，1-主按钮(蓝底白字)，2-次按钮(白底蓝字)，3-次按钮(白底黑字)，4-警告按钮(红色) |
| `state` | int | 否 | 按钮状态：0-可用，1-禁用，2-隐藏 |
| `callbackInfo` | string | 否 | **点击后通过 WebSocket 推送回来的数据**，见下文回调格式 |
| `permissionScope.permittedStaffs` | string[] | 否 | 有权限人员列表（非空时其他人无权限） |
| `permissionScope.prohibitedStaffs` | string[] | 否 | 无权限人员列表（非空时其他人有权限） |
| `prohibitedState` | int | 否 | 无权限时按钮状态：0-可用，1-禁用(灰显，默认)，2-隐藏 |

> **注意：** `permissionScope` 为空时所有群成员都能看到和点击按钮。
> 建议生产环境设置 `permissionScope.permittedStaffs` + `prohibitedState: 1`。

---

## WebSocket 回调事件格式

用户点击 approveCard 按钮后，蓝信通过 WebSocket 推送以下事件：

```json
{
  "id": "a381b883363d5a8124c3444f056a24d6",
  "type": "approve_card_callback",
  "eventType": "approve_card_callback",
  "data": {
    "id": "WS06E24QQ7u6oIQmcFpbY7YU4cvILc... (长字符串)",
    "type": "approve_card_callback",
    "eventType": "approve_card_callback",
    "eventData": "ea:once:2",
    "version": 0,
    "staffId": "13107200-K2uBlTReymO6C27owEgC7kJkdIngvlk",
    "entryId": "",
    "eventId": ""
  }
}
```

### 关键字段

| 路径 | 类型 | 说明 |
|------|------|------|
| `type` | string | 固定值 `"approve_card_callback"` |
| `eventType` | string | 固定值 `"approve_card_callback"` |
| `data.eventData` | string | **按钮的 `callbackInfo` 值**，见下方编码规则 |
| `data.staffId` | string | 点击按钮的人（蓝信 staffId） |
| `data.version` | int/string | 版本号，可能是 0 或时间戳 |

### 注意

- 回调 `type` 是 `approve_card_callback`，**不是** `bot_group_message` 或 `bot_private_message`
- 回调事件在 WebSocket events 数组中，一个事件只有一个回调
- 用户可以连续点击多个按钮（服务端不做去重），请自行在业务层处理重复

---

## `eventData`（callbackInfo）

`eventData` 的值就是发送 approveCard 时在 button 中设置的 `callbackInfo` 字段，蓝信服务端**原样回传**不做任何修改。你可以自行定义编码格式。

以下是我们（Hermes 适配器）使用的编码协议，供参考：

```
ea:{choice}:{approval_id}
ea:{choice}:{approval_id}:{session_key}
```

| 部分 | 说明 |
|------|------|
| `ea` | 固定前缀，标识审批回调（execute approval） |
| `choice` | 审批选择：`once` / `session` / `always` / `deny` |
| `approval_id` | 审批 ID，用于查找对应的 session |
| `session_key` | 可选，会话标识（当 choice=session 或 always 时需要） |

### 示例

| 按钮 | callbackInfo | 点击后 eventData |
|------|-------------|-----------------|
| 批准一次 | `ea:once:42` | `ea:once:42` |
| 本会话有效 | `ea:session:42:agent:main:lansenger:dm:13107200-xxx` | `ea:session:42:agent:main:lansenger:dm:13107200-xxx` |
| 永久允许 | `ea:always:42:agent:main:lansenger:dm:13107200-xxx` | `ea:always:42:agent:main:lansenger:dm:13107200-xxx` |
| 拒绝 | `ea:deny:42` | `ea:deny:42` |

---

## 回调处理流程

收到 `approve_card_callback` 事件后的处理步骤：

1. **从 `data.eventData` 中解析** `choice`、`approval_id`、`session_key`
2. **从 `data.staffId` 获取点击者**，进行权限校验
3. **查找 pending 审批**：用 `approval_id` 找到对应的 pending 审批
4. **执行业务逻辑**：根据 `choice` 执行批准/拒绝
5. **更新卡片 UI**：调用动态消息更新接口，将卡片状态改为"已批准"或"已拒绝"

---

## 卡片更新（动态消息）

审批完成后，通过动态消息更新接口修改原有卡片的按钮状态：

**接口：** `POST /v1/messages/dynamic/update?app_token=TOKEN`

**请求体（approveCard）：**

```json
{
  "msgId": "原卡片的msgId",
  "msgType": "approveCard",
  "msgData": {
    "approveCardUpdateMsg": {
      "headStatus": {
        "describe": "已批准",
        "statusIcon": 1,
        "colour": "#5A83E9"
      },
      "buttons": [
        {
          "text": "已允许执行一次",
          "buttonTheme": 2,
          "state": 1
        }
      ]
    }
  }
}
```

### 按钮 state 说明

| state | 含义 |
|-------|------|
| 0 | 可用（正常可点击） |
| 1 | 禁用（灰显不可点击） |
| 2 | 隐藏（不显示） |

---

## 完整示例：Hermes 适配器中的实现

```python
async def _handle_approve_card_callback(self, event_data):
    """处理 approveCard 按钮点击回调"""
    callback_data = event_data.get("data", {})
    raw_event_data = callback_data.get("eventData", "")
    staff_id = callback_data.get("staffId", "")

    if not raw_event_data.startswith("ea:"):
        return

    # 解析 ea:{choice}:{approval_id}[:{session_key}]
    parts = raw_event_data.split(":", 1)[1]  # 去掉 "ea:"
    # parts = "once:2" 或 "session:2:agent:main:lansenger:dm:..."

    colon1 = parts.find(":")
    choice = parts[:colon1]
    remainder = parts[colon1 + 1:]

    colon2 = remainder.find(":")
    if colon2 == -1:
        approval_id = remainder
        session_key = None  # once/deny 不含 session_key
    else:
        approval_id = remainder[:colon2]
        session_key = remainder[colon2 + 1:]

    # 权限检查
    if not is_authorized(staff_id):
        return

    # 查找 session（一次性和拒绝不含 session_key）
    if not session_key:
        session_key = pending_approvals.get(approval_id)

    # 执行业务逻辑
    resolve_approval(session_key, choice)

    # 更新卡片 UI
    update_card_status(msg_id, "approved", choice)
```

---

> **文档版本：** v1.0  
> **最后更新：** 2026-06-25  
> **基于蓝信版本：** 私有部署（已验证回调格式）
