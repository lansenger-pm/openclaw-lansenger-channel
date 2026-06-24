import { describe, it, expect } from "vitest";
import { BUILTIN_COMMAND_I18N } from "./command-i18n.js";

const LANGUAGES = ["zhHans", "zhHant", "zhHantHK", "en", "fr"] as const;
const COMMAND_KEYS = Object.keys(BUILTIN_COMMAND_I18N);

// Well-known commands and their expected translations for spot-checking.
const SPOT_CHECKS: Record<
  string,
  { zhHans: string; zhHant: string; zhHantHK: string; en: string; fr: string }
> = {
  help: {
    zhHans: "显示可用命令",
    zhHant: "顯示可用命令",
    zhHantHK: "顯示可用命令",
    en: "Show available commands.",
    fr: "Afficher les commandes disponibles.",
  },
  stop: {
    zhHans: "停止当前运行",
    zhHant: "停止當前執行",
    zhHantHK: "停止當前執行",
    en: "Stop the current run.",
    fr: "Arrêter l'exécution en cours.",
  },
  config: {
    zhHans: "显示或设置配置值",
    zhHant: "顯示或設定配置值",
    zhHantHK: "顯示或設定配置值",
    en: "Show or set config values.",
    fr: "Afficher ou définir des valeurs de configuration.",
  },
  bash: {
    zhHans: "运行主机 Shell 命令（仅限主机）",
    zhHant: "執行主機 Shell 命令（僅限主機）",
    zhHantHK: "執行主機 Shell 命令（僅限主機）",
    en: "Run host shell commands (host-only).",
    fr: "Exécuter des commandes shell (hôte uniquement).",
  },
  tts: {
    zhHans: "控制文本转语音（TTS）",
    zhHant: "控制文字轉語音（TTS）",
    zhHantHK: "控制文字轉語音（TTS）",
    en: "Control text-to-speech (TTS).",
    fr: "Contrôler la synthèse vocale (TTS).",
  },
};

describe("BUILTIN_COMMAND_I18N", () => {
  // 1. Command count
  it("should have the expected number of commands", () => {
    expect(COMMAND_KEYS.length).toBe(47);
  });

  it("should have the same number of translations in every language for every command", () => {
    for (const cmd of COMMAND_KEYS) {
      const entry = BUILTIN_COMMAND_I18N[cmd]!;
      expect(entry).toBeDefined();
      const keys = Object.keys(entry).sort();
      expect(keys).toEqual([...LANGUAGES].sort());
    }
  });

  // 2. Language coverage: each language has all commands
  for (const lang of LANGUAGES) {
    it(`should have '${lang}' translation for every command`, () => {
      for (const cmd of COMMAND_KEYS) {
        const entry = BUILTIN_COMMAND_I18N[cmd]!;
        expect(entry[lang], `missing ${lang} for "${cmd}"`).toBeTypeOf("string");
      }
    });
  }

  // 3. Key validation: spot-check specific well-known commands
  describe("spot-check known commands", () => {
    for (const [cmd, expected] of Object.entries(SPOT_CHECKS)) {
      it(`should have correct translations for "${cmd}"`, () => {
        const entry = BUILTIN_COMMAND_I18N[cmd];
        expect(entry).toBeDefined();
        const e = entry!;
        for (const lang of LANGUAGES) {
          expect(e[lang], `${lang} mismatch for "${cmd}"`).toBe(expected[lang]);
        }
      });
    }
  });

  // 4. No empty values
  it("should have no empty command names or descriptions in any language", () => {
    for (const cmd of COMMAND_KEYS) {
      const entry = BUILTIN_COMMAND_I18N[cmd]!;
      for (const lang of LANGUAGES) {
        const value = entry[lang];
        expect(value, `"${cmd}" has empty ${lang} value`).toBeTruthy();
        expect(value.trim().length, `"${cmd}" has whitespace-only ${lang} value`).toBeGreaterThan(0);
      }
    }
  });
});
