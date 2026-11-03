/**
 * 木琴 注文票読み取りバックエンド (Cloudflare Worker)
 *
 * POST /read  body: {"image": "<base64>", "media_type": "image/jpeg"}
 * 返り値: {"ok":true,"data":{"卓番号":3,"コースの数":1,"注文":[{"cell":"1b","数":1}],"flags":[{"cell":"2e","理由":"..."}]}}
 *
 * デプロイ後に Settings → Variables and Secrets で
 *   ANTHROPIC_API_KEY (Secret) を設定すること。
 * MODEL を変えたい場合は変数 MODEL を追加(省略時 claude-haiku-5-5)。
 */

const READ_PROMPT = `あなたは手書き注文票の読み取り係です。画像は蕎麦屋「木琴」のご注文票(様式 FORM: KIK-1)です。

用紙の仕様:
- 四隅に黒い角マーク。右下だけ白抜き(向きの判定に使う)
- 各記入マスの隅に薄いグレーの番地が印刷されている:
  - T=卓番号、C=コースの数
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

出力は次のJSONだけを返す。説明文・コードブロック記号は一切付けない:
{"卓番号": 数値またはnull, "コースの数": 数値, "注文": [{"cell": "番地", "数": 数値}], "flags": [{"cell": "番地", "理由": "短い説明"}]}
記入のないマスは注文に含めない。`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
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
      return json({ ok: false, error: "読み取り結果の解釈に失敗: " + e.message, raw: text.slice(0, 500) }, 502);
    }
    return json({ ok: true, data, model });
  },
};
