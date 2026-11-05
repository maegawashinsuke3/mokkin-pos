/**
 * 木琴 注文票読み取りバックエンド (Cloudflare Worker)
 *
 * POST /read  body: {"image": "<base64>", "media_type": "image/jpeg"}
 * 返り値: {"ok":true,"data":{"卓番号":3,"コースの数":1,"注文":[{"cell":"1b","数":1}],"flags":[{"cell":"2e","理由":"..."}]}}
 *
 * デプロイ後に Settings → Variables and Secrets で
 *   ANTHROPIC_API_KEY (Secret) を設定すること。
 *   APP_KEY (Secret) を設定すると、アプリの「読み取りの合言葉」と一致しない呼び出しを拒否する。
 * MODEL を変えたい場合は変数 MODEL を追加(省略時 claude-haiku-5-5)。
 *
 * ===== 写真保管(R2) =====
 * Settings → Bindings → Add → R2 bucket で変数名 PHOTOS にバケットを紐付けると、
 * 読み取った注文票の写真を自動保存する(電子帳簿保存の原始記録)。
 * GET /photo?key=...(&k=合言葉) で画像を取得(締めの控え closings/... も同じ口で取得できる)。
 * POST /snapshot {date, kind, files} で締めの控え(CSV・JSON)を closings/<date>/ に保存。
 *
 * ===== 共有台帳(D1) =====
 * Settings → Bindings → Add → D1 database で変数名 DB にデータベースを紐付けると、
 * 複数端末で同じ伝票・在庫を共有できる。テーブルは初回アクセス時に自動作成。
 *   GET  /state           全データ取得 {slips,intake,meta}
 *   POST /slip   {slip}   伝票を保存(上書き)
 *   POST /intake {rec}    在庫入庫を保存
 *   POST /intake/delete {ts} 入庫を取消
 *   POST /meta   {k,v}    釣銭準備金・金種カウント等を保存
 */

const READ_PROMPT = `あなたは手書き注文票の読み取り係です。画像は蕎麦屋「木琴」のご注文票(様式 FORM: KIK-1)です。

用紙の仕様:
- 四隅に黒い角マーク。右下だけ白抜き(向きの判定に使う)
- 各記入マスの隅に薄いグレーの番地が印刷されている:
  - T=卓番号、N=人数(その卓の客の人数)、C=コースの数
  - 卓番号は数字のみ(室内1〜9、屋外は10以降の2桁)。書かれた数字を文字列で返す(例 "3", "12")。万一ハイフン等が書かれていても書かれた文字のまま返す
  - 蕎麦の表: 行1〜6 × 列a〜f。行: 1=三通り盛り蕎麦 2=山かけ蕎麦(冷) 3=釜揚げ蕎麦 4=かけ蕎麦 5=ニラ蕎麦 6=山かけ蕎麦(温)。列: a/b/c=単品の普通/大盛/倍盛、d/e/f=コースの蕎麦の普通/大盛/倍盛
  - 一品: G1=蕎麦炊きご飯 G2=出汁巻き卵 G3=炙り蕎麦がき G4=蕎麦ゼリーぜんざい G5=トッピング卵 G6=缶ビール G7=缶ノンアルコールビール
- 手書きは赤ペンが原則(黒や青で書かれていても読む)

読み取りルール:
1. ぐるぐると塗りつぶされた記入は無効。その隣や枠外に書き直された数字が有効
2. 矢印があれば、矢印の指し先のマスの値として扱う
3. 枠外に書かれた数字は、最も近い行・マスの値として解釈する
4. 「コースの数」と「コースの蕎麦(d/e/f列)の合計」は一致するはず。曖昧なマスの解釈にはこの整合を使ってよい
5. 読みに確信が持てないマス、枠外記入、二重訂正のあったマスは flags に理由付きで挙げる
6. 印刷された数字(記入例の2と1など)は手書きではないので無視する

出力規則(最重要):
- どんな場合でも、応答は次のJSONオブジェクト1個だけ。説明文・前置き・コードブロック記号・謝罪は一切禁止
- 画像が暗い・ぼやけている・注文票でない等で読めない場合も、JSONで返す:
  {"卓番号": null, "人数": null, "コースの数": 0, "注文": [], "flags": [{"cell": "全体", "理由": "読めない理由を短く"}]}
- 影や暗さがあっても、読める数字は読む。自信が低いマスはflagsに挙げた上で注文にも含める

{"卓番号": "文字列(例 \"3\" や \"10-1\")またはnull", "人数": 数値またはnull, "コースの数": 数値, "注文": [{"cell": "番地", "数": 数値}], "flags": [{"cell": "番地", "理由": "短い説明"}]}
記入のないマスは注文に含めない。`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-app-key",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

/** モデルの返答テキストから最初のJSONオブジェクトを取り出す */
function extractJson(text) {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("JSONが見つかりません");
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("JSONが途中で切れています");
}

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS slips (id TEXT PRIMARY KEY, date TEXT, data TEXT, updated INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS intake (ts TEXT PRIMARY KEY, date TEXT, data TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)"),
  ]);
  schemaReady = true;
}

async function handleLedger(request, env, path) {
  if (!env.DB) return json({ ok: false, error: "共有台帳が未設定です(WorkerにD1バインディングDBを追加してください)" }, 501);
  await ensureSchema(env);
  if (path === "/state" && request.method === "GET") {
    const [sl, ik, mt] = await Promise.all([
      env.DB.prepare("SELECT data FROM slips").all(),
      env.DB.prepare("SELECT data FROM intake").all(),
      env.DB.prepare("SELECT k, v FROM meta").all(),
    ]);
    const meta = {};
    for (const r of mt.results) meta[r.k] = r.v;
    return json({
      ok: true,
      slips: sl.results.map(r => JSON.parse(r.data)),
      intake: ik.results.map(r => JSON.parse(r.data)),
      meta,
    });
  }
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "JSONではありません" }, 400); }
  if (path === "/slip") {
    const slip = body.slip;
    if (!slip || slip.id == null) return json({ ok: false, error: "slipがありません" }, 400);
    await env.DB.prepare("INSERT OR REPLACE INTO slips (id, date, data, updated) VALUES (?1, ?2, ?3, ?4)")
      .bind(String(slip.id), slip.date || "", JSON.stringify(slip), Date.now()).run();
    return json({ ok: true });
  }
  if (path === "/intake") {
    const rec = body.rec;
    if (!rec || rec.ts == null) return json({ ok: false, error: "recがありません" }, 400);
    await env.DB.prepare("INSERT OR REPLACE INTO intake (ts, date, data) VALUES (?1, ?2, ?3)")
      .bind(String(rec.ts), rec.date || "", JSON.stringify(rec)).run();
    return json({ ok: true });
  }
  if (path === "/intake/delete") {
    await env.DB.prepare("DELETE FROM intake WHERE ts = ?1").bind(String(body.ts)).run();
    return json({ ok: true });
  }
  if (path === "/meta") {
    if (!body.k) return json({ ok: false, error: "kがありません" }, 400);
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?1, ?2)").bind(body.k, String(body.v ?? "")).run();
    return json({ ok: true });
  }
  return json({ ok: false, error: "不明なパス: " + path }, 404);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (env.APP_KEY) {
      const k = request.headers.get("x-app-key") || url.searchParams.get("k") || "";
      if (k !== env.APP_KEY) return json({ ok: false, error: "合言葉が一致しません。アプリの設定の「読み取りの合言葉」を確認してください" }, 401);
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/photo" && request.method === "GET") {
      if (!env.PHOTOS) return json({ ok: false, error: "写真保存が未設定です(R2バインディングPHOTOSを追加してください)" }, 501);
      const key = url.searchParams.get("key") || "";
      const obj = await env.PHOTOS.get(key);
      if (!obj) return json({ ok: false, error: "写真が見つかりません" }, 404);
      return new Response(obj.body, {
        headers: { "Content-Type": (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg", "Cache-Control": "private, max-age=86400", ...CORS },
      });
    }
    /* 締めの控え(R2): POST /snapshot {date, kind, files:{name:text}} → closings/<date>/<ts>-<kind>-<name> */
    if (path === "/snapshot" && request.method === "POST") {
      if (!env.PHOTOS) return json({ ok: false, error: "控えの保存先が未設定です(R2バインディングPHOTOSを追加してください)" }, 501);
      let body;
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: "JSONではありません" }, 400); }
      const date = String(body.date || "").replace(/[^0-9-]/g, "");
      const kind = String(body.kind || "close").replace(/[^a-z]/g, "") || "close";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: "日付が不正です" }, 400);
      const ts = Date.now();
      const keys = [];
      for (const name in (body.files || {})) {
        const safe = name.replace(/[^a-zA-Z0-9_.-]/g, "");
        const key = "closings/" + date + "/" + ts + "-" + kind + "-" + safe;
        const type = safe.endsWith(".csv") ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";
        await env.PHOTOS.put(key, String(body.files[name]), { httpMetadata: { contentType: type } });
        keys.push(key);
      }
      return json({ ok: true, keys });
    }
    if (path === "/state" || path === "/slip" || path === "/intake" || path === "/intake/delete" || path === "/meta") {
      return handleLedger(request, env, path);
    }
    if (request.method !== "POST") return json({ ok: false, error: "POSTで送ってください" }, 405);
    if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: "サーバーにANTHROPIC_API_KEYが設定されていません" }, 500);

    let body;
    try { body = await request.json(); } catch (e) {
      return json({ ok: false, error: "リクエストがJSONではありません" }, 400);
    }
    const image = body.image;
    const mediaType = body.media_type || "image/jpeg";
    if (!image || typeof image !== "string") return json({ ok: false, error: "imageがありません" }, 400);
    if (image.length > 8_000_000) return json({ ok: false, error: "画像が大きすぎます(縮小して送ってください)" }, 413);

    const model = env.MODEL || "claude-haiku-5-5";
    let apiRes;
    try {
      apiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          system: "あなたは注文票読み取り係。応答は必ず指定のJSONオブジェクト1個のみ。それ以外の文字を出力してはならない。",
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
              { type: "text", text: READ_PROMPT },
            ],
          }],
        }),
      });
    } catch (e) {
      return json({ ok: false, error: "APIに接続できません: " + e.message }, 502);
    }

    if (!apiRes.ok) {
      const t = await apiRes.text();
      return json({ ok: false, error: "API エラー " + apiRes.status + ": " + t.slice(0, 300) }, 502);
    }

    const payload = await apiRes.json();
    const text = (payload.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    let data;
    try { data = extractJson(text); } catch (e) {
      return json({ ok: false, error: "読み取り結果の解釈に失敗: " + e.message + (text ? " / AIの応答: " + text.slice(0, 160) : " / AIの応答が空でした"), raw: text.slice(0, 500) }, 502);
    }
    /* 注文票の写真を保管(電子帳簿保存の原始記録。R2未設定なら黙ってスキップ) */
    let photoKey = null;
    if (env.PHOTOS) {
      try {
        const bin = Uint8Array.from(atob(image), c => c.charCodeAt(0));
        const d = new Date();
        const dateStr = d.toISOString().slice(0, 10);
        photoKey = dateStr + "/" + d.getTime() + "-" + Math.floor(Math.random() * 1000) + ".jpg";
        await env.PHOTOS.put(photoKey, bin, { httpMetadata: { contentType: mediaType } });
      } catch (e) { photoKey = null; }
    }
    return json({ ok: true, data, model, photoKey });
  },
};
