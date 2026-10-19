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

DSHの内部APIを利用するため、現在は次の組み合わせに固定しています。

- DeepSeek Harness `0.2.1-rc.2` のリリース版インストール（`dsh` コマンド）。Cordis `4.0.5`
- Node.js 22.19以降または24以降（DSH本体と同じ）
- 実行時の `@earendil-works/pi-ai` はDSHインストールに含まれる版（0.2.1-rc.2では1.3.0）
- Pi `@earendil-works/pi-coding-agent 1.1.0`（認証ファイルのロック実装を共用。Codexを使う時だけ必要）
- TUIを使う場合は `@deepseek-harness-tui/dsh-tui 0.16` 系

DSHの非公開ヘルパー（`dsh-llm-pi-ai` の `config` / `context` / `stream` とその依存）は
同じリリースタグ `dsh-v0.2.1-rc.2` から `src/vendor/` に同梱しています（[NOTICE](src/vendor/dsh-llm-pi-ai/NOTICE.md)）。
そのためDSHのソースcheckoutは不要です。パッケージのimportはすべて実行中のDSHインストールから解決され、
ホストとこの拡張が別々のCordisやDSHパッケージを読み込むことはありません。

このリポジトリはソース公開です。npmパッケージとしては公開していません。

## ビルド

```sh
git clone https://github.com/yukimaru77/dsh-pi-compat.git
cd dsh-pi-compat

# ビルドツール（tsdown / tsx / typescript など）だけを入れる。DSHパッケージはpeer
pnpm install --config.auto-install-peers=false

# PATH上の dsh のインストールからDSHパッケージをnode_modulesへリンク
# （pnpm install の後は毎回再実行）
node scripts/bootstrap.mjs

pnpm run build
pnpm run typecheck
pnpm test
```

bootstrapの引数（または `DSH_INSTALL`）でDSHインストールの `node_modules` を、
第2引数（または `PI_PACKAGE_DIR`）でPiパッケージを指定することもできます。
bootstrapはリンクを作るだけで、DSHやPiの設定・認証ファイルは変更しません。

buildで `lib/`、`presets/`、`cordis*.yml` が生成されます（Git管理対象外）。
生成YAMLはパッケージ名（`dsh-pi-compat`、`dsh-pi-compat/tools` など）で拡張を参照するので、
checkoutの場所には依存しません。profileへは `file:` で導入します。

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

TUI profileにこのcheckoutを追加します。`file:` は導入時点のビルドをコピーするので、
再ビルド後は `remove` してから `add` し直してください。

```sh
dsh plugin --profile dsh-tui add "file:$PWD"
```

続けて `cordis.tui.patch.yml` の内容を `~/.dsh/profiles/dsh-tui/cordis.patch.yml` に追記します
（Codexの認証をPi側に任せ、新規セッションを `pi-compatible` presetで始める設定です）。
初期モデル設定は `openai-codex / gpt-6.1-sol`、effortは `medium` です。
TUIに保存済みのモデル・effort設定がある場合はそちらが優先されます。

Piにまだログインしていなくても拡張は起動します。Codexへの最初の要求でPiの設定を読み込み、
未ログインならその要求だけがエラーになります。Piでログインした後は再起動なしで使えます。

## Webで使う

Web profileに独自のpi-ai provider設定がある場合は、先にprivate overlayへ保存します。
このリポジトリのルートで実行してください。

```sh
# provider設定を含むので、生成したoverlayは公開しない
umask 077
node --import tsx scripts/web-profile.ts \
  "${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml" \
  > "${DSH_HOME:-$HOME/.dsh}/pi-compat-providers.local.yml"

dsh plugin --profile web add "file:$PWD"
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
pnpm run typecheck
pnpm test
pnpm run build

# 初期化済みのTUI/Web profileがある場合
pnpm run test:smoke
pnpm run test:smoke:web
```

単体・統合テストは合成データを使用します。`tests/portable.test.ts` は公開済みの
`@deepseek-ai/dsh-agent-loop-testkit`（devDependency）を使います。smokeは一時HOMEにprofileをコピーし、このcheckoutをその `dsh-pi-compat` として実DSH loaderを起動し、
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
