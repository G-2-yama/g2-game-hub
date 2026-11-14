# Repository Guidelines

ゲーム紹介サイトとランチャー（Tauri）のコード。公開リポジトリで、データは別の非公開リポジトリにある。

- まず [docs/index.md](docs/index.md) から必要な文書を読む：構成は [docs/architecture.md](docs/architecture.md)、ファイルの役割と変更の約束は [docs/code.md](docs/code.md)、手順は [docs/operations.md](docs/operations.md)。
- サイトは静的出力のみ。サーバー・DB・SSR は追加しない。見た目は `core/` で共有し、片方に複製しない。
- 外部のMarkdownで任意のHTML・スクリプトを実行できる仕組みを追加しない。データのリポジトリ名・トークン・非公開情報を書かない。
- 依存追加や大規模リファクタリングを避ける。変更後は `npm run build`（ランチャーは `cargo build` も）を実行し、ビルド結果と動作確認を区別して報告する。
- 仕組みや手順を変えたら `docs/` も更新する。docs は OKF v0.2（frontmatter に `type` 必須、`index.md`・`log.md` は予約名）に従い、更新したら `generated` と `log.md` も直す。
- コミット、PR、マージ、デプロイは依頼がない限り実施しない。
