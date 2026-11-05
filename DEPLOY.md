# 写真読み取り(第2段階)を動かす手順

所要15分。プログラミングは不要、全部Cloudflareの画面上の操作です。

## 用意するもの

- Cloudflareアカウント(予約管理アプリで使っているものでOK)
- AnthropicのAPIキー(console.anthropic.com → カード登録 → $5チャージ → API Keys → Create Key。`sk-ant-` で始まる文字列を控える)

## 手順

1. **Cloudflareにログイン** → 左メニューの「Workers & Pages」→「Create」→「Create Worker」
2. 名前を `mokkin-reader` にして「Deploy」(まず空のまま作る)
3. 「Edit code」を開き、中身を全部消して、**worker.js の中身を丸ごと貼り付け** →「Deploy」
4. Workerの「Settings」→「Variables and Secrets」→「Add」
   - Type: **Secret** / 名前: `ANTHROPIC_API_KEY` / 値: 控えたAPIキー → 保存
5. Workerの画面に出ているURL(例 `https://mokkin-reader.◯◯◯.workers.dev`)をコピー
6. 注文会計アプリを開き、右上の「**設定**」→ 読み取りサーバーURLに貼り付け → 保存

これで「📷 注文票を撮影して読み取り」ボタンが生きます。押すとカメラが起動し、撮影→数秒→入力済みの伝票画面が開きます。

## 共有台帳(複数端末で同じ伝票・在庫を使う)

1. Cloudflare左メニュー「Storage & Databases」→「D1 SQL Database」→「Create」→ 名前 `mokkin-pos-db` で作成(テーブルは自動で作られるので中身の操作は不要)
2. Worker(mokkin-reader)の「Settings」→「Bindings」→「Add」→「D1 database」
   - Variable name: `DB`(この名前どおりに) / D1 database: mokkin-pos-db → 保存(Deploy)
3. これだけで、同じ読み取りサーバーURLを設定した全端末が同じ台帳を共有します。アプリ右上に「共有✓」と出れば接続OK

## 写真の自動保管(ペーパーレス保存)

1. Cloudflare左メニュー「Storage & Databases」→「R2 object storage」→「Create bucket」→ 名前 `mokkin-photos` で作成(初回はR2の有効化でカード登録を求められることがあります。無料枠10GB内なら請求は発生しません)
2. Worker(mokkin-reader)の「Settings」→「Bindings」→「Add」→「R2 bucket」
   - Variable name: `PHOTOS`(この名前どおりに) / Bucket: mokkin-photos → Deploy
3. 以後、読み取った注文票の写真が日付つきで自動保存され、伝票画面の「保存写真」リンクから開けます。追加注文は伝票画面の「📷 追加注文の紙を読み取り」で読むと、同じ伝票に合算+写真も保存されます
4. 税務用のペーパーレス保存(スキャナ保存)として使う場合は、運用方式を税理士か税務署に一度確認してください

## 合言葉(サーバーの不正利用防止・推奨)

1. Workerの「Settings」→「Variables and Secrets」→「Add」
   - Type: Secret / 名前: `APP_KEY` / 値: 好きな合言葉(例: ランダムな英数字20文字) → Deploy
2. アプリ右上「設定」→「読み取りの合言葉」に同じ文字列を入力 → 保存(全端末で)

## アプリのパスコード

アプリ右上「設定」→「アプリのパスコード」に数字4〜8桁。端末ごとに設定(店のレジ端末には必ず)。忘れたらブラウザのサイトデータ消去でリセット(伝票データも消えるので共有台帳があれば再取得されます)。

## 確認のしかた

- 検証済みの注文票(卓3のテスト2枚)を撮って、合計が6,550円 / 42,000円になるか
- 読み取りに迷いがあったマスは、伝票画面の上に赤い「読み取り要確認」として並びます。**必ず紙と見比べてから会計へ**

## うまくいかない時

- 「ANTHROPIC_API_KEYが設定されていません」→ 手順4のSecretが未保存
- 「API エラー 401」→ キーの貼り間違い
- 「API エラー 400 credit」系 → チャージ残高切れ(consoleで追加)
- 読み取り自体が変 → その写真をClaudeのチャットに貼って相談(プロンプトはworker.js冒頭のREAD_PROMPTにあり、ここを直して再Deployすれば読み方が変わる)

## 費用の目安

読み取り1枚あたり0.1円未満(Haiku 5.5)。$5チャージで実質使い切れないほど持ちます。


## 締めの確定を使うには(2026-11-06追加)

worker.js を新しい版に貼り直して Deploy するだけです(R2 の PHOTOS バインディングは写真保管で設定済みのものをそのまま使います)。
