# マルチチェーン取引トラッカー

Ethereum・BNB Chain・Solanaのウォレット取引履歴を一覧表示するReactアプリです(試作v1)。

## セットアップ

```bash
npm install
npm run dev
```

## APIキーについて

- **Ethereum・BNB Chain**: Etherscan APIキー(V2、無料枠あり)が共通で使えます。`https://etherscan.io/myapikey` で発行してください。
- **Solana**: Helius APIキー(無料枠あり)が必要です。`https://www.helius.dev` で発行してください。

アプリ右上の歯車アイコンから、それぞれのキーを貼り付けてください。ブラウザのlocalStorageにのみ保存されます。

## データの保存について

取引履歴・ウォレットアドレス・APIキーは、開いているブラウザの`localStorage`に保存されます。別の端末・別のブラウザとは同期されません。

## GitHubへのアップロード

```bash
git init
git add .
git commit -m "Initial commit: multi-chain wallet tracker"
git branch -M main
git remote add origin <あなたのGitHubリポジトリURL>
git push -u origin main
```

**重要:** アップロード時は`src`フォルダを維持したまま(App.jsx・main.jsx・storage.jsが`src/`の中に入った状態で)pushしてください。GitHubの「Upload files」でファイルを個別にドラッグすると、フォルダ構造が失われてビルドエラーになることがあります。

## 今後の拡張予定

- スワップの自動判定(現在は送金・受信のみ)
- 総平均法での損益計算(パーペチュアル損益トラッカーと同じ考え方)
- DeFi(流動性提供など)の扱い
