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
