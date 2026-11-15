# 更新履歴

## 2026-11-15
* **Update**: ランチャーの版をタグから決めるようにし、タグと `package.json` の一致の確認をやめた。`package.json` と `Cargo.toml` の版は仮の `0.0.0` にした。[運用](operations.md) と [リポジトリの連携とCI](integration.md) に反映した。

## 2026-11-14
* **Update**: ランチャーが Release のzipの更新日時で版を判断し、GitHub の `digest` で検証するようにした。[仕組み](architecture.md) と [ランチャーの使い方](launcher.md) に反映した。
* **Update**: [コードの構造](code.md) に、ヘッダーのイベントのメニューと本文の改行の扱いを反映した。
* **Creation**: [リポジトリの連携とCI](integration.md) を追加した。operations.md の App の秘密鍵の作り方を現在の画面に合わせ、PAT のポリシーを任意とした。
* **Initialization**: README から分けて docs を作成し、OKF v0.2 の形式にした。
