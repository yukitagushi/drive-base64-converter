# Gemini Lounge

Gemini Lounge は、Google Gemini API の File Search 機能を想定したナレッジ管理 &amp; QA UI です。API キーを手元で入力して、ファイルストアの作成、ドキュメントのアップロード、チャットによる検索を 1 つの画面で試せます。ミニマルな 1 ページ UI とポップアップモーダルで、ナビゲーションの遷移なく作業できるようにしました。

> ⚠️ 本サンプルは学習目的であり、Google Gemini API の仕様変更によりエンドポイントが異なる可能性があります。実運用前にドキュメントをご確認ください。

## 主な機能

- **API 設定モーダル**: ブラウザローカルに Gemini API Key / Project / Location を保存。
- **ストア管理**: File Search ストアの作成・一覧表示・削除。各ストアに紐づくファイルを表示。
- **ドキュメント登録**: PDF / TXT / Markdown などのファイルをドラッグ&ドロップでアップロード。
- **チャット型検索**: ChatGPT ライクな UI で Gemini 1.5 Flash に質問し、File Search から関連ドキュメントを引用。
- **引用表示**: Gemini の grounding metadata が返すドキュメント URI をチップとして表示。

## セットアップ

```bash
npm install  # 依存ライブラリは不要ですが、初回に lockfile を生成できます
npm run dev  # http://localhost:3000 で開発サーバーを起動
```

ブラウザで `http://localhost:3000` を開き、右上の「API 設定」から以下を入力してください。

- **API Key**: Google AI Studio で発行したキー
- **Project ID / Number**: File Search を有効にした Google Cloud プロジェクト
- **Location**: 例) `global` / `us-central1`

## 使い方

1. 「ナレッジを追加」からストアを作成します。
2. 作成したストアの「開く」でチャットを開始、または「ファイル追加」で資料をアップロードします。
3. チャット欄から質問すると、File Search ストアを指定した Gemini API 呼び出しを行い、回答と引用を表示します。

## カスタマイズ

- `public/styles.css` でフォント・配色・余白を調整できます。
- `public/app.js` 内の `askGemini` / `uploadFileToStore` などで API エンドポイントを変更できます。
- `server.js` は簡易な静的ファイルサーバーです。フレームワークに組み込む場合は不要です。

## 注意

- この UI で入力した API Key はローカルストレージに保存され、外部へ送信しません。
- File Search やアップロード API の利用には課金が発生する場合があります。料金は公式ドキュメントをご確認ください。
