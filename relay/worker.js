// 作品總覽的中繼站：替網頁呼叫 Dify 客服知識庫，只回傳「執行步驟」與回答。
// Dify API 金鑰存在 Cloudflare Secrets（DIFY_API_KEY），不會出現在網頁裡。

const DIFY_URL = "https://api.dify.ai/v1/chat-messages";
const MAX_QUERY = 300;          // 問題最長字數
const PER_IP_PER_MIN = 6;       // 每個 IP 每分鐘最多幾次
const hits = new Map();         // 簡易限流（同一個 Worker 執行個體內有效）

function cors(origin, allowed) {
  const ok = origin === allowed || /^http:\/\/localhost(:\d+)?$/.test(origin || "");
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > PER_IP_PER_MIN;
}

const clip = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s);

// 只挑出網頁需要的欄位，其餘（含內部 ID、使用量）一律丟掉
function slim(evt) {
  const d = evt.data || {};
  switch (evt.event) {
    case "workflow_started":
      return { type: "start" };
    case "node_started":
      return { type: "node_start", node: d.node_type, title: d.title };
    case "node_finished": {
      const out = { type: "node_end", node: d.node_type, title: d.title, status: d.status, ms: Math.round((d.elapsed_time || 0) * 1000) };
      if (d.node_type === "knowledge-retrieval" && Array.isArray(d.outputs?.result)) {
        out.chunks = d.outputs.result.slice(0, 5).map((r) => ({
          doc: r.metadata?.document_name || r.title || "",
          score: typeof r.metadata?.score === "number" ? Math.round(r.metadata.score * 100) / 100 : null,
          text: clip(r.content || "", 160),
        }));
      }
      if (d.node_type === "llm" && d.process_data?.model_name) out.model = d.process_data.model_name;
      if (d.error) out.error = clip(String(d.error), 200);
      return out;
    }
    case "message":
      return { type: "token", text: evt.answer || "" };
    case "message_end":
      return {
        type: "end",
        conversation_id: evt.conversation_id,
        sources: (evt.metadata?.retriever_resources || []).map((r) => r.document_name).filter(Boolean),
      };
    case "error":
      return { type: "error", message: clip(evt.message || "發生錯誤", 200) };
    default:
      return null;
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const headers = cors(origin, env.ALLOWED_ORIGIN || "https://dinling1922.github.io");
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (request.method !== "POST") return new Response("Not found", { status: 404, headers });
    if (!env.DIFY_API_KEY) return Response.json({ error: "中繼站尚未設定金鑰" }, { status: 500, headers });

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (limited(ip)) return Response.json({ error: "試用次數太頻繁，請一分鐘後再試。" }, { status: 429, headers });

    let body;
    try { body = await request.json(); } catch { return Response.json({ error: "格式錯誤" }, { status: 400, headers }); }
    const query = String(body.query || "").trim();
    if (!query || query.length > MAX_QUERY) return Response.json({ error: `問題請在 1～${MAX_QUERY} 字之間` }, { status: 400, headers });

    const upstream = await fetch(DIFY_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.DIFY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: {},
        query,
        response_mode: "streaming",
        conversation_id: typeof body.conversation_id === "string" ? body.conversation_id : "",
        user: "portfolio-" + (await hashIp(ip)),
      }),
    });
    if (!upstream.ok || !upstream.body) {
      return Response.json({ error: `Dify 回應 ${upstream.status}，請稍後再試。` }, { status: 502, headers });
    }

    // 把 Dify 的 SSE 轉成精簡過的 SSE
    const { readable, writable } = new TransformStream();
    (async () => {
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = block.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            let evt; try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
            const out = slim(evt);
            if (out) await writer.write(enc.encode(`data: ${JSON.stringify(out)}\n\n`));
          }
        }
      } catch {
        await writer.write(enc.encode(`data: ${JSON.stringify({ type: "error", message: "連線中斷，請再試一次。" })}\n\n`));
      } finally {
        await writer.close();
      }
    })();
    return new Response(readable, { headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  },
};

async function hashIp(ip) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}
