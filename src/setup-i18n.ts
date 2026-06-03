type WizardLocale = "en" | "zh-CN" | "zh-TW";

function resolveWizardLocale(): WizardLocale {
  const raw = process.env.OPENCLAW_LOCALE || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  const normalized = (raw.split(".")[0] ?? "").replace(/_/g, "-").toLowerCase();
  if (normalized.startsWith("zh-tw") || normalized.startsWith("zh-hant")) return "zh-TW";
  if (normalized.startsWith("zh-cn") || normalized.startsWith("zh-hans")) return "zh-CN";
  if (normalized.startsWith("zh")) return "zh-CN";
  return "en";
}

const LOCALE = resolveWizardLocale();

const LANSINGER_I18N: Record<string, Record<WizardLocale, string>> = {
  channelLabel:        { en: "Lansenger",           "zh-CN": "蓝信",                "zh-TW": "藍信" },
  introTitle:          { en: "Lansenger Setup",     "zh-CN": "蓝信配置",            "zh-TW": "藍信設定" },
  introDesktopPath:    { en: "Lansenger Desktop → Contacts → Bots → Personal Bots", "zh-CN": "蓝信桌面端 → 通讯录 → 智能机器人 → 个人机器人", "zh-TW": "藍信桌面端 → 通訊錄 → 智慧機器人 → 個人機器人" },
  introClickInfo:      { en: "Click the ℹ️ icon to view App ID and App Secret", "zh-CN": "点击 ℹ️ 图标查看凭证", "zh-TW": "點擊 ℹ️ 圖標查看憑證" },
  introPersonalOnly:   { en: "Personal Bots only — organization bots not supported", "zh-CN": "仅支持个人机器人", "zh-TW": "僅支援個人機器人" },
  introNoMobile:       { en: "Mobile client does NOT support viewing credentials", "zh-CN": "移动端不支持查看凭证", "zh-TW": "行動端不支援查看憑證" },
  introToolsIncluded:  { en: "✅ Agent tools are included in this plugin (no separate install needed).", "zh-CN": "✅ 代理工具已内置于此插件，无需单独安装。", "zh-TW": "✅ 代理工具已內建於此插件，無需單獨安裝。" },
  introCliAlt:         { en: "CLI is an optional alternative: pip install lansenger-cli", "zh-CN": "CLI 为可选替代方案：pip install lansenger-cli", "zh-TW": "CLI 為可選替代方案：pip install lansenger-cli" },

  appIdLabel:          { en: "Lansenger App ID",     "zh-CN": "蓝信 App ID",        "zh-TW": "藍信 App ID" },
  appIdHelpLine1:      { en: "App ID from your Lansenger Personal Bot", "zh-CN": "个人机器人的 App ID", "zh-TW": "個人機器人的 App ID" },
  appIdHelpLine2:      { en: "Found alongside App Secret → Contacts → Bots → Personal Bots", "zh-CN": "通讯录 → 智能机器人 → 个人机器人", "zh-TW": "通訊錄 → 智慧機器人 → 個人機器人" },
  appIdEnvPrompt:      { en: "LANSENGER_APP_ID detected. Use env var?", "zh-CN": "检测到环境变量 LANSENGER_APP_ID，是否使用？", "zh-TW": "偵測到環境變數 LANSENGER_APP_ID，是否使用？" },
  appIdKeepPrompt:     { en: "App ID already configured. Keep it?", "zh-CN": "App ID 已配置，是否保留？", "zh-TW": "App ID 已設定，是否保留？" },
  appIdInputPrompt:    { en: "Enter Lansenger App ID", "zh-CN": "输入蓝信 App ID", "zh-TW": "輸入藍信 App ID" },

  secretLabel:         { en: "Lansenger App Secret", "zh-CN": "蓝信 App Secret",    "zh-TW": "藍信 App Secret" },
  secretHelpLine1:     { en: "App Secret from your Lansenger Personal Bot", "zh-CN": "个人机器人的 App Secret", "zh-TW": "個人機器人的 App Secret" },
  secretHelpLine2:     { en: "Found alongside App ID → Contacts → Bots → Personal Bots", "zh-CN": "通讯录 → 智能机器人 → 个人机器人", "zh-TW": "通訊錄 → 智慧機器人 → 個人機器人" },
  secretEnvPrompt:     { en: "LANSENGER_APP_SECRET detected. Use env var?", "zh-CN": "检测到环境变量 LANSENGER_APP_SECRET，是否使用？", "zh-TW": "偵測到環境變數 LANSENGER_APP_SECRET，是否使用？" },
  secretKeepPrompt:    { en: "App Secret already configured. Keep it?", "zh-CN": "App Secret 已配置，是否保留？", "zh-TW": "App Secret 已設定，是否保留？" },
  secretInputPrompt:   { en: "Enter Lansenger App Secret", "zh-CN": "输入蓝信 App Secret", "zh-TW": "輸入藍信 App Secret" },

  baseUrlMessage:      { en: "API Gateway URL (optional, default Lansenger public cloud)", "zh-CN": "API 网关地址（可选，默认蓝信公有云）", "zh-TW": "API 閘道位址（可選，預設藍信公有雲）" },

  allowFromHelpTitle:  { en: "Lansenger user ID",    "zh-CN": "蓝信用户 ID",        "zh-TW": "藍信使用者 ID" },
  allowFromHelpLine1:  { en: "Lansenger user IDs have format: orgId-applicationId (e.g. xxx-xxxxxxx)", "zh-CN": "蓝信用户 ID 格式：orgId-applicationId（如 xxx-xxxxxxx）", "zh-TW": "藍信使用者 ID 格式：orgId-applicationId（如 xxx-xxxxxxx）" },
  allowFromMessage:    { en: "Lansenger allowFrom (user IDs, format: orgId-applicationId)", "zh-CN": "蓝信允许的用户 ID（格式：orgId-applicationId）", "zh-TW": "藍信允許的使用者 ID（格式：orgId-applicationId）" },
  allowFromInvalidNote: { en: "Lansenger allowFrom requires user IDs in format appId-userId.", "zh-CN": "蓝信 allowFrom 需要格式为 appId-userId 的用户 ID。", "zh-TW": "藍信 allowFrom 需要格式為 appId-userId 的使用者 ID。" },

  companionTitle:      { en: "Messaging Tools",      "zh-CN": "消息工具",            "zh-TW": "訊息工具" },
  companionLine1:      { en: "Agent tools (lansenger_send_file, etc.) are included in this plugin — no separate install needed.", "zh-CN": "代理工具（lansenger_send_file 等）已内置于此插件，无需单独安装。", "zh-TW": "代理工具（lansenger_send_file 等）已內建於此插件，無需單獨安裝。" },
  companionLine2:      { en: "CLI is an optional alternative (works via bash):", "zh-CN": "CLI 为可选替代方案（通过 bash 调用）：", "zh-TW": "CLI 為可選替代方案（透過 bash 呼叫）：" },
  companionLine3:      { en: "Without CLI, the agent can still use built-in tools for files, cards, and formatted messages.", "zh-CN": "未安装 CLI 时，代理仍可使用内置工具发送文件、卡片和格式化消息。", "zh-TW": "未安裝 CLI 時，代理仍可使用內建工具傳送檔案、卡片和格式化訊息。" },

  securityTitle:       { en: "⚠️ Security: Plaintext appSecret", "zh-CN": "⚠️ 安全：appSecret 明文存储", "zh-TW": "⚠️ 安全：appSecret 明文儲存" },
  securityLine1:       { en: "Your appSecret is stored as plaintext in openclaw.json.", "zh-CN": "appSecret 以明文存储在 openclaw.json 中。", "zh-TW": "appSecret 以明文儲存在 openclaw.json 中。" },
  securityLine2:       { en: "Any workspace tool that reads config can see your bot credentials.", "zh-CN": "任何读取配置的工作区工具都能看到机器人凭证。", "zh-TW": "任何讀取配置的工作區工具都能看到機器人憑證。" },
  securityLine3:       { en: "Migrate to SecretRef storage by running:", "zh-CN": "迁移至 SecretRef 存储，请运行：", "zh-TW": "遷移至 SecretRef 儲存，請執行：" },
  securityLine4:       { en: "Or use the LANSENGER_APP_SECRET environment variable instead.", "zh-CN": "或使用 LANSENGER_APP_SECRET 环境变量替代。", "zh-TW": "或使用 LANSENGER_APP_SECRET 環境變數替代。" },

  finalizePlaintext1:  { en: "⚠️  Your appSecret is stored as plaintext in openclaw.json.", "zh-CN": "⚠️  appSecret 以明文存储在 openclaw.json 中。", "zh-TW": "⚠️  appSecret 以明文儲存在 openclaw.json 中。" },
  finalizePlaintext2:  { en: "   This means any workspace tool that reads config can see your bot credentials.", "zh-CN": "   这意味着任何读取配置的工作区工具都能看到机器人凭证。", "zh-TW": "   這意味著任何讀取配置的工作區工具都能看到機器人憑證。" },
  finalizePlaintext3:  { en: "   Migrate to SecretRef storage by running: openclaw secrets configure", "zh-CN": "   迁移至 SecretRef 存储，请运行：openclaw secrets configure", "zh-TW": "   遷移至 SecretRef 儲存，請執行：openclaw secrets configure" },
  finalizePlaintext4:  { en: "   Or use the LANSENGER_APP_SECRET environment variable instead.", "zh-CN": "   或使用 LANSENGER_APP_SECRET 环境变量替代。", "zh-TW": "   或使用 LANSENGER_APP_SECRET 環境變數替代。" },
};

function lt(key: string): string {
  const entry = LANSINGER_I18N[key];
  if (!entry) return key;
  return entry[LOCALE] ?? entry.en ?? key;
}

export { lt, LOCALE };
export type { WizardLocale };