# dsh-codex

ChatGPT Codex account pool, web/image tools, compaction, and session settings
for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

ChatGPT（Codex）の複数アカウントと、Codex向けの検索・画像・圧縮・設定を、DSH自身のagent/session上で使うための開発版です。
ログインと認証情報はDSHのcredential storeとauthorization（サインイン画面）で完結し、Piは不要です。

## 追加する機能

| 機能 | 動作 |
| --- | --- |
| **Codexアカウントpool** | `codex-pool` rowの `accounts` に並べたアカウントを、DSHのcredential store（`codex-pool/<アカウント名>` の grant record）に保存。OAuth更新はstoreのプロセス間ロック内で行い、会話・検索・画像・圧縮で同じ選択処理を使用 |
| サインイン | アカウントごとにDSHのauthorization flowを登録。WebのアカウントSettingsやTUIの `/auth` から、DSH標準のproviderと同じ手順でChatGPTにサインイン |
| アカウント選択 | 残量20%以上・週次resetが近い順の内蔵選択。`selectorScript` で独自の選択モジュールにも変更可能。残量キャッシュは30秒 |
| Web検索 | `web_run`。search / image_query / open / click / find / settings と参照IDを提供 |
| 画像生成・編集 | `codex_generate_image`。参照画像、DSH添付、対応環境でのworkspace保存 |
| 会話圧縮 | Codex Responses V2で圧縮し、Lunaでテキストの引き継ぎ情報へ変換。両方の成功後にDSHの履歴へ確定 |
| Fast・tier | `/fast`、`/service-tier`。Codexリクエストへ適用 |
| 圧縮の容量設定 | `/context-window`。モデル本来の容量以内でセッションごとの上限を指定 |
| 状態表示 | `/codex-pool`。選択アカウントとキャッシュ済み残量を表示 |

新規セッション用のpreset `codex`（表示名 Codex）を追加します。standard presetに上記のCodexツールと圧縮を加えたものです。

## 対応バージョン

DSHの内部APIを利用するため、現在は次の組み合わせに固定しています。

- DeepSeek Harness `0.2.1-rc.2` のリリース版インストール（`dsh` コマンド）。Cordis `4.0.5`
- Node.js 22.19以降または24以降（DSH本体と同じ）
- 実行時の `@earendil-works/pi-ai` はDSHインストールに含まれる版（0.2.1-rc.2では1.3.0）
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

bootstrapの引数（または `DSH_INSTALL`）でDSHインストールの `node_modules` を指定することもできます。
bootstrapはリンクを作るだけで、DSHの設定・認証ファイルは変更しません。

buildで `lib/`、`presets/`、`cordis*.yml` が生成されます（Git管理対象外）。
生成YAMLはパッケージ名（`dsh-codex`、`dsh-codex/tools` など）で拡張を参照するので、
checkoutの場所には依存しません。profileへは `file:` で導入します。

## アカウントの設定とサインイン

profileの `cordis.patch.yml` で、poolに入れるアカウント名を並べます
（小文字とハイフンの名前。省略時は `codex-1` 〜 `codex-3`）。

```yaml
- id: codex-pool
  config:
    accounts: [work, personal, lab]
    # 任意: 独自の選択モジュール（default exportの関数。絶対パス）
    # selectorScript: /Users/me/.dsh/codex-pool/selector.mjs
```

サインインは `/codex-login <アカウント名>` で行います。表示されたURL（`https://auth.openai.com/codex/device`）を開き、
そのアカウントにするChatGPTアカウントでログインしてコードを入力すると、バックグラウンドで完了します
（コードの有効期限は15分。完了したかは `/codex-pool` の `signedIn` で確認できます）。
各アカウントはDSHのauthorization flow（`codex-pool/<アカウント名>`）としても登録されるので、
plugin flowを開始できるDSHの画面があればそこからもサインインできます（0.2.1-rc.2のWeb/TUIには未搭載）。
アカウントごとに別のChatGPTアカウントでサインインしてください。
同じChatGPTアカウントを2つの枠に入れるとrefresh tokenを共有して互いのログインを無効にするため、拒否します。
認証情報はDSHのcredential store（既定では `~/.dsh/.credentials.yaml`）に保存されます。

サインイン前でも拡張は起動します。Codexへの要求はサインイン済みのアカウントだけから選び、
1つもない場合はその要求だけがエラーになります。サインイン後は再起動なしで使えます。

Fast・tierの既定値は `~/.dsh/codex-pool/service-tier.json`（`tierConfigPath` で変更可）から読みます。

## TUIで使う

TUI profileにこのcheckoutを追加します。`file:` は導入時点のビルドをコピーするので、
再ビルド後は `remove` してから `add` し直してください。

```sh
dsh plugin --profile dsh-tui add "file:$PWD"
```

続けて `cordis.tui.patch.yml` の内容を `~/.dsh/profiles/dsh-tui/cordis.patch.yml` に追記します
（Codexの認証をこのpoolに任せ、新規セッションを `codex` presetで始める設定です）。
初期モデル設定は `openai-codex / gpt-6.1-sol`、effortは `medium` です。
TUIに保存済みのモデル・effort設定がある場合はそちらが優先されます。

## Webで使う

Web profileに独自のpi-ai provider設定がある場合は、先にprivate overlayへ保存します。
このリポジトリのルートで実行してください。

```sh
# provider設定を含むので、生成したoverlayは公開しない
umask 077
node --import tsx scripts/web-profile.ts \
  "${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml" \
  > "${DSH_HOME:-$HOME/.dsh}/codex-providers.local.yml"

dsh plugin --profile web add "file:$PWD"
dsh web --patch "${DSH_HOME:-$HOME/.dsh}/codex-providers.local.yml"
```

Webでは新規セッションのpresetを `codex` にします。
既存の既定モデルは変更しません。必要に応じてWebのモデル選択でCodexを選んでください。
既存セッションのpresetは自動変更されません。
通常の `llm-pi-ai` は無効化され、非Codex providerを `codex-other-providers` が担当します。
以後のprovider設定変更はこのrowへ反映し、追加overlayとの優先順位も確認してください。

`scripts/web-profile.ts` は元ファイルを読み取るだけで、変換結果をstdoutへ出力します。
独自のprovider設定を別overlayで管理している場合は、その設定も
`codex-other-providers` へ引き継いでください。

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
`@deepseek-ai/dsh-agent-loop-testkit`（devDependency）を使います。smokeは一時HOMEにprofileをコピーし、このcheckoutをその `dsh-codex` として実DSH loaderを起動し、
ツール・コマンド・preset・圧縮エンジンの登録を確認します。
実際のOAuth更新、課金される画像生成、SSH接続の成功を保証するテストではありません。
別のprofileを使う場合は `DSH_TUI_PROFILE_SOURCE` / `DSH_WEB_PROFILE_SOURCE`、
CLIの実行ファイルを指定する場合は `DSH_CLI` を設定できます。

## Plugin API

別の拡張は `ctx.codexPool.adapter.registerPayloadTransform(id, transform)` で
Codexの送信payloadを加工できます。型は `dsh-codex/payload` の
`PayloadTransform` / `PayloadTransformRequest` / `PayloadTransformRegistry` を使用します。
transformにはpayloadと元のDSH `messages`、`purpose`、`sessionId`、`signal` が渡ります。
通常streamとnative compaction用serializerの両方でtier適用後に登録順で実行され、
返したpayloadを次へ渡します。Promiseにも対応し、例外が出た場合は送信を止めます。
同じidの重複登録はエラーです。返された解除関数を拡張のdispose時に呼んでください。

## 現在の制約

- DSHの内部APIに依存する開発版です。依存更新時には再ビルドと検証が必要です。
- 圧縮後のテキスト抽出はモデル生成であり、情報の完全保持を保証しません。抽出失敗や非対応メディアでは履歴を確定せず停止します。
- 暗号化checkpointは外形からtoken数を推定するため、早期圧縮や縮小判定の失敗が起こる場合があります。
- Fast/tierの送信対応はCodexのみです。実際の優先処理はサーバー側の対応に依存します。
- workspaceへの画像保存は、POSIX・Python 3・DSHのsandbox/承認機能が揃う環境で新規PNGのみ対応します。利用できない場合は添付で返します。
- セッション設定は `~/.dsh/codex-pool/session-settings/` に別保存します。セッションを他のマシンへ移す場合はこの設定も必要です。

## ライセンス

[MIT](LICENSE)。再利用したコードの出典とライセンスは
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) に記載しています。
