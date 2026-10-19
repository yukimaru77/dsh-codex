# dsh-pi-compat

Pi-compatible Codex authentication, web/image tools, compaction, and session settings
for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Piで利用しているCodex認証と拡張機能を、DSH自身のagent/session上で使うための開発版です。
Piの拡張ファイルをそのままロードするものではありません。

## 追加する機能

| 機能 | 動作 |
| --- | --- |
| **Codexアカウント共有** | Piの `auth.json` と `multi-pass.json` を参照。Piと同じファイルロックでOAuthを更新し、会話・検索・画像・圧縮で同じ選択処理を使用 |
| アカウント選択 | 既存の `selectorScript`、または残量20%以上・週次resetが近い順の内蔵選択。残量キャッシュは30秒 |
| Web検索 | `web_run`。search / image_query / open / click / find / settings と参照IDを提供 |
| 画像生成・編集 | `codex_generate_image`。参照画像、DSH添付、対応環境でのworkspace保存 |
| 会話圧縮 | Codex Responses V2で圧縮し、Lunaでテキストの引き継ぎ情報へ変換。両方の成功後にDSHの履歴へ確定 |
| Fast・tier | `/fast`、`/service-tier`。Codexリクエストへ適用 |
| 圧縮の容量設定 | `/context-window`。モデル本来の容量以内でセッションごとの上限を指定 |
| 状態表示 | `/codex-pool`。選択アカウントとキャッシュ済み残量を表示 |

## 対応バージョン

DSHの内部ソースAPIを利用するため、現在は次の組み合わせに固定しています。

- DeepSeek Harness `0.2.1-rc.2`、commit [`687f282`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317) のビルド済みソースcheckout
- Node.js 24以降、Cordis `4.0.5`
- DSH checkoutに含まれるパッチ済み `@earendil-works/pi-ai 1.1.0`
- インストール済み `@earendil-works/pi-coding-agent 1.1.0`
- TUIを使う場合は `@deepseek-harness-tui/dsh-tui 0.16.0`

このリポジトリはソース公開です。npmパッケージとしては公開していません。
`npm install` だけでは必要なDSH内部ソースが揃わないため、以下のbootstrapを使用します。

## ビルド

DSHを上記commitでcheckoutし、上流の手順で依存をインストールしてビルドしてください。
そのDSHを `dsh` コマンドで起動できることを確認します。

```sh
git clone https://github.com/yukimaru77/dsh-pi-compat.git
cd dsh-pi-compat

# パスは自分のインストール先へ変更
node scripts/bootstrap.mjs \
  /path/to/deepseek-harness \
  /path/to/node_modules/@earendil-works/pi-coding-agent

npm run build
npm run typecheck
npm test
```

引数の代わりに `DSH_SOURCE` と `PI_PACKAGE_DIR` も指定できます。
bootstrapは指定先のバージョンを確認し、このリポジトリの `node_modules` にリンクを作ります。
DSHやPiの設定・認証ファイルは変更しません。

buildで `lib/`、`presets/`、`cordis*.yml` が生成されます。
生成YAMLにはこのcheckoutの絶対パスが入るため、ディレクトリを移動したら再ビルドしてください。
生成物はGit管理対象外です。

## Pi認証の準備

Pi側でCodexへログインし、番号付きのアカウント（`openai-codex-1` など）を登録してください。
既定の参照先は `~/.pi/agent/auth.json` と `~/.pi/agent/multi-pass.json` です。
アカウントの追加・削除・再ログインはPi側で行います。

必要なpool形式は [`examples/multi-pass.example.json`](examples/multi-pass.example.json) を参照してください。
これは認証情報を含まない形式例です。既存の設定を置き換えるためのファイルではありません。
`standardLogin: true`、有効な `openai-codex` pool、`strategy: custom`、
`selectionTiming: auth-use`、実際に認証済みの番号付きmembersが必要です。
POSIX環境では `auth.json` の権限を `600` にします。

参照先は `pi-compatible` の `authPath` / `poolConfigPath` で変更できます。
`poolName` を省略すると、条件に合う最初の有効poolが選ばれます。

## TUIで使う

TUIをインストールしてprofileを初期化した後、このリポジトリで実行します。

```sh
dsh --profile dsh-tui \
  --patch "$PWD/cordis.patch.yml" \
  --patch "$PWD/cordis.tui.patch.yml"
```

新規セッションのpresetは `pi-compatible`、初期モデル設定は
`openai-codex / gpt-6.1-sol`、effortは `medium` です。
TUIに保存済みのモデル・effort設定がある場合はそちらが優先されます。

## Webで使う

Web profileがある状態で、既存の非Codex provider設定をprivate overlayへ保存し、
ローカルbundleを追加します。このリポジトリのルートで実行してください。

```sh
# provider設定を含むので、生成したoverlayは公開しない
umask 077
node --import tsx scripts/web-profile.ts \
  "${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml" \
  > "${DSH_HOME:-$HOME/.dsh}/pi-compat-providers.local.yml"

dsh plugin --profile web add "link:$PWD" -w --config.auto-install-peers=false
dsh web --patch "${DSH_HOME:-$HOME/.dsh}/pi-compat-providers.local.yml"
```

Webでは新規セッションのpresetを `pi-compatible` にします。
既存の既定モデルは変更しません。必要に応じてWebのモデル選択でCodexを選んでください。
既存セッションのpresetは自動変更されません。
通常の `llm-pi-ai` は無効化され、非Codex providerを `pi-compatible-other-providers` が担当します。
以後のprovider設定変更はこのrowへ反映し、追加overlayとの優先順位も確認してください。

`scripts/web-profile.ts` は元ファイルを読み取るだけで、変換結果をstdoutへ出力します。
独自のprovider設定を別overlayで管理している場合は、その設定も
`pi-compatible-other-providers` へ引き継いでください。

## 一緒に使う拡張

SSHとTUIは独立した既製パッケージです。こちらのリポジトリには同梱していません。

| パッケージ | バージョン | 公開Fork / 上流 |
| --- | --- | --- |
| `dsh-ssh-remote` | 0.1.5 | [Fork](https://github.com/yukimaru77/dsh-kylin-ssh-tunnel) / [上流](https://github.com/kkutysllb/dsh-kylin-ssh-tunnel) |
| `@deepseek-harness-tui/dsh-tui` | 0.16.0 | [Forkの導入版](https://github.com/yukimaru77/dsh-TUI/tree/installed-0.16.0) / [上流](https://github.com/ccch1mneyyy/dsh-TUI) |

```sh
dsh plugin --profile web add dsh-ssh-remote@0.1.5 -w
dsh plugin --profile dsh-tui add dsh-ssh-remote@0.1.5 -w
```

SSHは専用の `ssh_run` / `ssh_read` / `ssh_write` などを使います。
通常のファイル操作や画像の入出力はローカルのままです。
ホスト設定・接続方法はSSH拡張のREADMEを参照してください。

## 検証

```sh
npm run typecheck
npm test
npm run build

# 初期化済みのTUI/Web profileがある場合
npm run test:smoke
npm run test:smoke:web
```

単体・統合テストは合成データを使用します。smokeは一時HOMEで実DSH loaderを起動し、
ツール・コマンド・preset・圧縮エンジンの登録を確認します。
実際のOAuth更新、課金される画像生成、SSH接続の成功を保証するテストではありません。
別のprofileを使う場合は `DSH_TUI_PROFILE_SOURCE` / `DSH_WEB_PROFILE_SOURCE`、
CLIの実行ファイルを指定する場合は `DSH_CLI` を設定できます。

## Plugin API

別の拡張は `ctx.piCompat.adapter.registerPayloadTransform(id, transform)` で
Codexの送信payloadを加工できます。型は `dsh-pi-compat/payload` の
`PayloadTransform` / `PayloadTransformRequest` / `PayloadTransformRegistry` を使用します。
transformにはpayloadと元のDSH `messages`、`purpose`、`sessionId`、`signal` が渡ります。
通常streamとnative compaction用serializerの両方でtier適用後に登録順で実行され、
返したpayloadを次へ渡します。Promiseにも対応し、例外が出た場合は送信を止めます。
同じidの重複登録はエラーです。返された解除関数を拡張のdispose時に呼んでください。

## 現在の制約

- DSH内部APIとPiの認証ストアAPIに依存する開発版です。依存更新時には再ビルドと検証が必要です。
- 圧縮後のテキスト抽出はモデル生成であり、情報の完全保持を保証しません。抽出失敗や非対応メディアでは履歴を確定せず停止します。
- 暗号化checkpointは外形からtoken数を推定するため、早期圧縮や縮小判定の失敗が起こる場合があります。
- Fast/tierの送信対応はCodexのみです。実際の優先処理はサーバー側の対応に依存します。
- workspaceへの画像保存は、POSIX・Python 3・DSHのsandbox/承認機能が揃う環境で新規PNGのみ対応します。利用できない場合は添付で返します。
- セッション設定は `~/.dsh/pi-compat/session-settings/` に別保存します。セッションを他のマシンへ移す場合はこの設定も必要です。

## ライセンス

[MIT](LICENSE)。再利用したコードの出典とライセンスは
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) に記載しています。
