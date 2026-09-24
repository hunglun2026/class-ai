// 測試專用：Node 不認得 Cloudflare 的 `cloudflare:workers` 模組（v1.15 加 MCP 的 OAuthProvider 後，
// test:it 一載入 src/index.ts 就報 ERR_UNSUPPORTED_ESM_URL_SCHEME，之前誤記成 Node 版本問題）。
// 這裡在載入前把它換成替身；OAuthProvider 只拿 WorkerEntrypoint 來做 instanceof 判斷，空類別就夠。
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (specifier === "cloudflare:workers") return { url: "cf-stub:workers", shortCircuit: true };
        return next(specifier, context);
      }
      export async function load(url, context, next) {
        if (url === "cf-stub:workers") {
          return { format: "module", shortCircuit: true, source: "export class WorkerEntrypoint {}; export const env = {};" };
        }
        return next(url, context);
      }
    `)
);
