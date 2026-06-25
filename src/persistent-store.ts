import * as fsSync from "node:fs";
import * as path from "node:path";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";

const log = createSubsystemLogger("lansenger");

export class PersistentStore<T> {
  protected data = new Map<string, T>();
  protected filePath: string;
  protected logPrefix: string;

  constructor(filePath: string, logPrefix: string) {
    this.filePath = filePath;
    this.logPrefix = logPrefix;
    this.load();
  }

  protected load() {
    try {
      const raw = fsSync.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          this.data.set(k, v as T);
        }
      }
    } catch {}
  }

  protected save() {
    try {
      const dir = path.dirname(this.filePath);
      fsSync.mkdirSync(dir, { recursive: true });
      const obj: Record<string, T> = {};
      for (const [k, v] of this.data) obj[k] = v;
      fsSync.writeFileSync(this.filePath, JSON.stringify(obj), "utf-8");
    } catch (e) {
      log.warn(`failed to persist ${this.logPrefix}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  get(key: string) { return this.data.get(key); }

  set(key: string, value: T) {
    this.data.set(key, value);
    this.save();
  }

  delete(key: string) {
    this.data.delete(key);
    this.save();
  }

  entries(): IterableIterator<[string, T]> { return this.data.entries(); }

  clear() {
    this.data.clear();
    this.save();
  }
}
