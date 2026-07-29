# デモ 3: Gemini 所見推敲 — バックエンド面（Java JAR）から外部 API を呼ぶ

自分で書いた**粗い所見のドラフト**と**表示中の画像**を Google の Gemini に渡し、
読影レポートとして通用する日本語へ**推敲**させるプラグインです。

```
人が粗く書く  →  画像を添付  →  JAR が Gemini に投げる  →  推敲後の所見 / 直した点 / 書き足す観点
```

これは **文章を書く練習のための教育用サンプル**であり、**診断支援ではありません**。

学べること:

1. **バックエンド面（Java JAR）**の作り方 — `GraphyPlugin` SPI の実装
2. **なぜ外部 API は JAR から呼ぶのか** — レンダラの CSP
3. **API キーの扱い** — どこに置き、どこに置かないか
4. **Maven ビルドを含むリリース** — CI で API jar を取得してビルドし zip に同梱する
5. **署名（minisign）と TOFU** — 実行コードを配るなら署名する

- 対象: [GRAPHY-Next](https://github.com/tatsunidas/GRAPHY-Next) v0.1.8 以降
- 動作モード: **デスクトップ版（standalone）のみ**。Web 版は `run()` が `501` になります（§9）
- 姉妹デモ: [デモ集ハブ](https://github.com/tatsunidas/graphy-next-plugin-demos) ／
  [デモ 1: Hello](https://github.com/tatsunidas/graphy-next-plugin-hello) ／
  [デモ 2: 平均化フィルタ](https://github.com/tatsunidas/graphy-next-plugin-mean-filter)

---

## ⚠️ 先に読んでください

- **実患者データを送信しないでください。** 入力した文章と画像は **Google のサーバーへ送信**されます。
  匿名化済みデータ・ファントム・公開データセットのみを対象にしてください。
  施設の規程・倫理審査の要否は各自でご確認ください。
- **診断ではありません。** プロンプトは「ドラフトに書かれている内容の言語化・整理」に限定しており、
  画像から新しい所見を診断させない作りにしてあります。出力は必ず人が確認してください。
- **API キーは自分のものを使います。** 料金・レート制限・利用規約はすべて利用者と Google の間の話です。
- ダイアログは、**確認チェックを入れるまで実行できません**（意図的にそうしてあります）。

> このリポジトリの README は**単体で完結**するように書いてあります。
> 他のデモの README と内容が重複していますが、そういう方針です。

---

## 目次

1. [動かす](#1-動かす)
2. [ファイルの中身](#2-ファイルの中身)
3. [`plugin.json` の全フィールド](#3-pluginjson-の全フィールド)
4. [`ui.js` と `host` API](#4-uijs-と-host-api)
5. [バックエンド面（Java JAR）](#5-バックエンド面java-jar)
6. [API キーをどこに置くか](#6-api-キーをどこに置くか)
7. [プロンプトの設計](#7-プロンプトの設計)
8. [リリースする（GitHub Release）](#8-リリースするgithub-release)
9. [GRAPHY-Next に入れる（デスクトップ版）／ Web 版](#9-graphy-next-に入れるデスクトップ版--web-版)
10. [鍵方式（署名）](#10-鍵方式署名)
11. [うまくいかないとき](#11-うまくいかないとき)
12. [できないこと（正直に）](#12-できないこと正直に)

---

## 1. 動かす

### 1-1. Gemini の API キーを取る

[Google AI Studio](https://aistudio.google.com/) でキーを発行します（`AIza…` で始まる文字列）。
料金体系・無料枠は Google の案内をご確認ください。

### 1-2. JAR をビルドする

このプラグインは Java 側を持つので、リリース資産を使わない場合は自分でビルドします。

```bash
# 1. GRAPHY-Next の Release から SPI の jar を取得する
gh release download v0.1.8 --repo tatsunidas/GRAPHY-Next \
  --pattern 'graphy-plugin-api-*.jar' --dir /tmp/api

# 2. ローカル Maven リポジトリへ登録する
mvn install:install-file \
  -Dfile=/tmp/api/graphy-plugin-api-0.1.8.jar \
  -DgroupId=com.vis.graphynext -DartifactId=graphy-plugin-api \
  -Dversion=0.1.8 -Dpackaging=jar

# 3. ビルド
mvn -f backend/pom.xml package
# → backend/target/gemini-findings.jar
```

> すでに Release がある場合は、GRAPHY-Next の 環境設定 ＞ プラグイン から
> `tatsunidas/graphy-next-plugin-gemini-findings` を指定して導入するほうが簡単です（§9）。

### 1-3. プラグイン格納ディレクトリに置く

| OS | 場所 |
|---|---|
| Windows | `%APPDATA%\GRAPHY-Next\plugins\` （実体は `C:\Users\<ユーザー名>\AppData\Roaming\GRAPHY-Next\plugins\`） |
| macOS | `~/Library/Application Support/GRAPHY-Next/plugins/` |
| Linux (AppImage) | `~/.config/GRAPHY-Next/plugins/` |

```
<plugins>/
└── gemini-findings/
    ├── plugin.json
    ├── ui.js
    └── gemini-findings.jar     ← plugin.json と同じ階層に置く
```

> **インストール先ではなく、OS のユーザーデータ領域**です。本体が読み取り専用（AppImage など）でも
> 書けること、アンインストーラがユーザーデータを巻き添えで消さずに済むことが理由です。

### 1-4. 使う

1. GRAPHY-Next を**完全に終了してから起動**する（**JAR を含むので再起動が必須**）
2. 2D ビューアでシリーズを表示する
3. **Plug-ins ＞ Gemini 所見推敲** をクリック
4. API キーを入れ、ドラフトを書き（サンプルが入っています）、確認チェックを入れて「推敲する」

> **反映のルール（重要）**
>
> | 変更した中身 | 必要な操作 | 理由 |
> |---|---|---|
> | `ui.js` だけ | 画面のリロード | フロントは起動時に `/api/plugins` を読んで動的 import するため |
> | **`*.jar` を含む** | **アプリの再起動** | クラスローダを id 単位でキャッシュしており、**同 id の JAR 差し替えを拾わない**ため |
>
> JAR を作り直したのに挙動が変わらないときは、まずこれを疑ってください。

---

## 2. ファイルの中身

```
plugin.json                     ← 必須。マニフェスト（entrypoint あり）
ui.js                           ← 画面側（ES モジュール・ビルド不要）
graphy-plugin.d.ts              ← エディタ補完用（配布物には含めない）
backend/
  pom.xml                       ← Java 側のビルド定義
  src/main/java/com/example/graphy/gemini/GeminiFindingsPlugin.java
.github/workflows/release.yml   ← タグ push で jar ビルド → zip + sha256 (+ 署名)
LICENSE
```

配布物（zip）に入るのは **`plugin.json` / `ui.js` / `gemini-findings.jar` の 3 つ**だけです。
ソースや README は入りません。

---

## 3. `plugin.json` の全フィールド

このデモの `plugin.json`:

```json
{
  "id": "gemini-findings",
  "name": "Gemini 所見推敲",
  "version": "0.1.0",
  "contributes": ["viewer2d.menu"],
  "ui": "ui.js",
  "entrypoint": "com.example.graphy.gemini.GeminiFindingsPlugin",
  "permissions": ["read-pixels", "network"],
  "engines": { "graphy": ">=0.1.8", "os": ["win32", "darwin", "linux"] },
  "description": "…", "author": "…", "homepage": "…", "license": "MIT"
}
```

| キー | 必須 | 説明 |
|---|---|---|
| `id` | ✅ | 一意な ID（`[A-Za-z0-9._-]`）。フォルダ名と揃えると分かりやすい |
| `name` | ✅ | メニューに出る表示名 |
| `version` | ✅ | semver。**リリースタグ `v<version>` と一致必須** |
| `contributes` | UI を出すなら | 出す先（サーフェス）の配列 |
| `ui` | UI を出すなら | フォルダ直下の ES モジュール名 |
| **`entrypoint`** | **JAR を持つなら** | **`GraphyPlugin` 実装クラスの完全修飾名** |
| `permissions` | 任意 | 要求権限。**宣言のみで、現状は強制されない** |
| `engines.graphy` | 推奨 | 対応する本体の版の範囲 |
| `engines.os` | 推奨 | 対応 OS |
| `description` / `author` / `homepage` / `license` | 任意 | 一覧・同意画面の表示用 |

### `permissions` は宣言であって強制ではない

`"network"` と書いてありますが、**現状これは同意画面に表示されるだけで、実際の通信は
制限されていません。** 書く意味は「利用者に意図を伝える」ことにあります。
逆に言えば、**利用者は「宣言されていないから安全」とは考えてはいけません**。

### サーフェス（`contributes`）— どこに出るか

| 値 | 出る場所 | 用途 |
|---|---|---|
| `viewer2d.menu` | 2D ビューアの **Plug-ins** メニュー | 表示中の画像に対する処理・ツール |
| `mainscreen.menu` | データベース画面の **Plug-Ins** メニュー | DB・エクスポート等、画像に依存しない機能 |
| `viewer2d.toolbar` | （予約） | ツールバーへの常設ボタン。描画は将来 |

### `engines` — 入れる前に弾くための宣言

- **`engines.graphy`**: 本体の版と照合します。演算子は `>= <= > < =` と空白 AND（`">=0.1.8 <0.3.0"`）。
  **バックエンド面を持つプラグインは、SPI の版に縛られる**ので、上限も書いておくのが安全です。
- **`engines.os`**: `win32` / `darwin` / `linux`。**非対応と判定されると、ユーザーが同意しても
  展開前に拒否されます**（fail-closed）。このデモは純 Java なので 3 つとも書いています。
  JNI やネイティブバイナリを含むなら必ず絞ってください。

---

## 4. `ui.js` と `host` API

`ui.js` は **ES モジュール**です。バンドラは不要で、backend が `text/javascript` として配信し、
フロントが動的 `import()` で読み込みます。メニューがクリックされると `activate(host)` が呼ばれます。

### `host` に入っているもの

**すべてのサーフェス共通**

| プロパティ | 型 | 説明 |
|---|---|---|
| `surface` | `string` | 呼び出し元（`"viewer2d.menu"` / `"mainscreen.menu"` …） |
| `pluginId` | `string` | 自分の `plugin.json` の `id` |
| `t(key)` | `(k: string) => string` | ホストの i18n 取得関数（アプリの言語に追従） |
| `notify(msg)` | `(m: string) => void` | ユーザーへの簡易通知 |
| **`runBackend(payload?)`** | `(p?: unknown) => Promise<unknown>` | **`POST /api/plugins/{id}/run` を呼ぶ** |

**`viewer2d.menu` / `viewer2d.toolbar` のとき追加**

| プロパティ | 説明 |
|---|---|
| `actions` | 表示中タイルへの操作。`fit()` / `reset()` / `rotate90()` / `flipH()` / `flipV()` / `invert()` / `undo()` / `redo()` / `setWindowLevel(center, width)` / `resetWindow()` ほか |

**`mainscreen.menu` のとき追加**

| プロパティ | 説明 |
|---|---|
| `selectedStudyUid` | 選択中スタディの UID（未選択なら `null`） |

### 型補完（ビルド不要）

同梱の `graphy-plugin.d.ts` をプラグインフォルダに置き、`ui.js` の先頭に次の 2 行を書くと、
TypeScript を導入しなくても VS Code で `host` に補完が効きます。

```js
/// <reference path="./graphy-plugin.d.ts" />
// @ts-check
```

### 4-1. 表示中の画像を取り出す

```js
for (const el of document.querySelectorAll("[data-tile-id]")) {
  const canvas = el.querySelector("canvas");   // Cornerstone3D のビューポート
  …
}
```

GRAPHY-Next は 2D ビューアの各タイルの外枠 `<div>` に
`data-tile-id="<studyUid>|<seriesUid>"` を持たせています。

> ⚠ **これは公式の `host` API ではなく DOM 依存**です。本体の版が上がると変わりうる点に注意
> してください（現状これが「いま何が開かれているか」を知る唯一の手段です）。

キャンバスはいったんオフスクリーンの 2D キャンバスへ `drawImage` してから `toDataURL("image/png")`
します（Cornerstone3D のキャンバスは 2D の場合も WebGL の場合もあるため、この経路なら両対応）。
長辺 1024 px に縮小してからエンコードしています（リクエストを軽くするため）。

### 4-2. なぜ外部 API を `ui.js` から直接呼ばないのか

**呼べないからです。** 配布版 GRAPHY-Next のレンダラには次の CSP が効いています。

```
connect-src 'self' http://localhost:* http://127.0.0.1:*
```

つまり `ui.js` から `https://generativelanguage.googleapis.com` を `fetch` すると
**ブラウザにブロックされます**。開発中（Vite dev サーバー）は CSP が入らないので動いてしまい、
**配布物にしたときだけ壊れる**という厄介な形で表面化します。

したがって **外部 API を叩く処理はバックエンド面（JAR）に置く**のが唯一の方法です。
`ui.js` の役目は「入力を集めて `host.runBackend()` に渡し、結果を表示する」ことに徹します。

```js
const res = await host.runBackend({ apiKey, model, findings, imageBase64, mimeType });
if (res.ok) showResult(res.text);
else showError(res.error);
```

---

## 5. バックエンド面（Java JAR）

### 5-1. 実装するのは 1 インターフェースだけ

```java
package com.vis.graphynext.plugin.spi;

public interface GraphyPlugin {
    Object run(Map<String, Object> args) throws Exception;   // 戻り値は JSON 化されて UI に返る
}
```

このデモの実装は `backend/src/main/java/com/example/graphy/gemini/GeminiFindingsPlugin.java` です。
やっていることは単純で、

1. `args` から `apiKey` / `model` / `findings` / `imageBase64` を取り出す
2. Gemini の `generateContent` 用 JSON を組み立てる
3. JDK の `HttpClient` で POST する
4. 応答から本文を取り出して `{ok, text, model, finishReason, usage}` として返す

### 5-2. API jar に対してコンパイルする

backend 全体ではなく、SPI だけの薄い **`graphy-plugin-api`** に対してコンパイルします。
GRAPHY-Next の [Release](https://github.com/tatsunidas/GRAPHY-Next/releases) に
`graphy-plugin-api-<version>.jar` が添付されています。

```bash
mvn install:install-file \
  -Dfile=graphy-plugin-api-0.1.8.jar \
  -DgroupId=com.vis.graphynext -DartifactId=graphy-plugin-api \
  -Dversion=0.1.8 -Dpackaging=jar
```

`pom.xml` では **`provided` スコープ**にします（ランタイムは GRAPHY-Next が供給するので、jar に同梱しない）。

### 5-3. Jackson も `provided` で使える（が、寄りかかりでもある）

プラグイン JAR は **親＝backend のクラスローダ**付きでロードされます
（`new URLClassLoader(urls, getClass().getClassLoader())`）。
そのため **backend の依存（Spring, Jackson, dcm4che …）が実行時に見えます**。
このデモは JSON の組み立て・解釈に Jackson を使い、`provided` で参照しています。

```xml
<dependency>
  <groupId>com.fasterxml.jackson.core</groupId>
  <artifactId>jackson-databind</artifactId>
  <version>2.17.2</version>
  <scope>provided</scope>
</dependency>
```

> ⚠ これは**本体の実装詳細に寄りかかった選択**です。本体の依存が変われば壊れます。
> 壊れたくないなら、この依存を外して **JDK だけで**組み立て・解釈するか、
> 必要なライブラリを shade して同梱してください（その場合 zip が大きくなります）。

### 5-4. 例外を投げるか、値で返すか

想定内の失敗（キー未入力、Gemini が 400 を返した、など）は **例外を投げずに
`{ok:false, error:"…"}` として返しています**。

理由: SPI から例外が漏れると HTTP `500` になり、UI 側には原因が伝わりません。
**利用者が対処できる失敗は、必ず値で返す**のが親切です。
このデモは HTTP ステータスごとに補足（「API キーが無効か、API が有効化されていません」など）も付けています。

### 5-5. 実行の流れ

```
メニュークリック → activate(host) → host.runBackend(payload)
   → POST /api/plugins/gemini-findings/run
   → backend が gemini-findings.jar を URLClassLoader でロード
   → GeminiFindingsPlugin.run(payload)
   → Gemini API へ HTTPS
   → 戻り値 JSON が Promise で返る
```

### 5-6. 知っておくべき制約

- **Web 版では `run()` は常に `501`** を返します（共有 JVM に任意 JAR を読ませないため）。
- **JAR は親クラスローダ付きでロードされる**ため、backend の依存が見えます（§5-3）。
- **同じ id の JAR を差し替えたら、アプリの再起動が必要**です（クラスローダのキャッシュ）。
- **JAR はアプリと同じ権限で動きます。** ファイル読み書きもネットワークも自由です。
  だからこそ利用者側に同意画面が出ますし、配布者は署名すべきです（§10）。

---

## 6. API キーをどこに置くか

| 置き場所 | このデモ | 補足 |
|---|---|---|
| ブラウザの `localStorage` | ✅ 使う（任意） | **平文**。「この端末に保存する」を外せば保存しない |
| バックエンド面（JAR）内 | ❌ 保存しない | 呼び出しごとに受け取り、使い捨てる。ログにも出さない |
| リポジトリ / 配布 zip | ❌ 絶対に入れない | 公開リポジトリに置けば即座に漏洩する |
| URL のクエリ文字列 | ❌ 使わない | ログ・プロキシ・履歴に残る。このデモは `x-goog-api-key` ヘッダを使う |

`localStorage` は共有端末では危険です。**共有端末では「保存する」を外してください**
（毎回入力になりますが、それが正しい挙動です）。

より堅くしたいなら、キーを GRAPHY-Next の設定ストアや OS のキーチェーンへ逃がす作りが考えられますが、
現状プラグインからそれらへアクセスする API はありません。

---

## 7. プロンプトの設計

`GeminiFindingsPlugin.INSTRUCTION` に埋め込んであります。要点は 3 つです。

**① 診断させない。** 最優先の制約として、

> 画像から新たな所見を「診断」しないでください。ドラフトに書かれている内容の
> 言語化・整理・用語の適正化に徹してください。
> ドラフトに無い病変・計測値・断定的な診断名を追加しないでください。

を先頭に置いています。画像を添付するのは「ドラフトの表現が画像と食い違っていないか」を
見てもらうためであって、読影させるためではありません。

**② 出力を 3 部構成にする。**

1. 推敲後の所見
2. **直した点（なぜ直したかを一言添える）**
3. **書き足すとよい観点（質問の形で）**

推敲結果だけ返ってきても学びになりません。**②と③が練習の本体**です。

**③ 温度を下げる。** `generationConfig.temperature = 0.3`。
推敲タスクで発散させても良いことはありません。

### 練習の進め方（提案）

1. 画像を見て、**まず自分の言葉で**粗く書く（サンプルのように口語でよい）
2. 推敲させる
3. 「直した点」を読み、**なぜそう直るのかを自分で説明できるか**確かめる
4. 「書き足すとよい観点」を見て、**自分がどの観点を落としたか**を記録する
5. 次の症例では、落とした観点を意識して書く

推敲結果をそのまま使うのではなく、**自分の書き方の癖を見つける道具**として使うのが趣旨です。

---

## 8. リリースする（GitHub Release）

配布は **GitHub Release の「ビルド済み zip 資産」**で行います。ソース tarball ではありません
（`ui.js` はトランスパイル後、`*.jar` はコンパイル後の成果物が要るため）。

### 8-1. リリース資産

| 資産 | 内容 | 必須か |
|---|---|---|
| `<id>-<version>.zip` | **直下に `plugin.json`** ＋ `ui.js` ＋ `*.jar` | ✅ 必須 |
| `<id>-<version>.zip.sha256` | 完全性検証用 | 実質必須（無いと既定で導入拒否） |
| `<id>-<version>.zip.minisig` | 署名（真正性） | **JAR を配るなら実質必須**（§10） |
| `minisign.pub` | 署名の公開鍵 | 署名するなら必要 |

### 8-2. CI がやること

同梱の [`.github/workflows/release.yml`](.github/workflows/release.yml) は、タグ `v<version>` の push で:

1. `plugin.json` の `version` とタグの一致を確認（ずれていたら落とす）
2. GRAPHY-Next の Release から `graphy-plugin-api-<ver>.jar` を取得し、ローカル Maven へ登録
3. `backend/pom.xml` をビルドして `gemini-findings.jar` を作る
4. `plugin.json` / `ui.js` / `*.jar` を zip に固め、sha256 を付ける
5. secrets があれば minisign で署名する
6. Release に添付する

対象の GRAPHY-Next の版は workflow 冒頭の `GRAPHY_VERSION` で一元管理しています。
**本体を上げるときは、ここと `plugin.json` の `engines.graphy` を一緒に見直してください。**

```bash
# plugin.json の version を 0.2.0 に上げてコミットしてから
git tag v0.2.0
git push origin v0.2.0
```

---

## 9. GRAPHY-Next に入れる（デスクトップ版）／ Web 版

### 9-1. 導入を許可する（初回だけ）

導入操作は **3 つの条件がすべて揃ったときだけ**許可されます。既定では 3 番目が OFF です。

| # | 条件 | 誰が決めるか | 既定 |
|---|---|---|---|
| 1 | デスクトップ版（standalone）であること | モード | Web は常に `403` |
| 2 | `graphy.plugins.manager-enabled` | 管理者（yml） | `true`（施設で一律禁止したい場合に `false`） |
| 3 | 設定キー `plugins.installEnabled` | **ユーザー** | **`false`** |

**環境設定 ＞ プラグイン ＞「プラグインの導入を許可する」を ON** にしてください。

> 分けてある理由: プラグインはアプリと同じ権限で動きます。「環境として許すか（管理者）」と
> 「今それを使うか（ユーザー）」は別の判断なので、2 段にしてあります。
> トグルを OFF に戻しても**導入済みプラグインは動き続けます**（止めたいなら個別に無効化）。

### 9-2. GitHub から入れる

環境設定 ＞ プラグイン で `tatsunidas/graphy-next-plugin-gemini-findings` と入れて「GitHub から導入」。

```
[1] ゲート判定        standalone か / 管理者ゲート / ユーザーのオプトイン
      │ 欠ければ 403（閲覧のみ）
      ▼
[2] 取得              Release から <id>-<ver>.zip ＋ .sha256 ＋ .minisig / minisign.pub
      │ ※ まだ展開していない
      ▼
[3] 検査 (inspect)    zip を展開せずに読み、中身を提示用データにする
      │
      ├─ 署名が既知の鍵で通った ─────────► [5] へ直行（確認画面なし＝押すだけ）
      │
      └─ 未署名 / 未知の鍵 / 警告あり
      ▼
[4] 同意画面          何を受け入れるのかを提示して承諾を得る
      │ 互換NGなら同意しても導入できない
      ▼
[5] 導入 (install)    再取得 → 同意した sha256 と一致するか確認 → 展開 → 台帳に記録
      ▼
[6] 反映              JAR 入り → **アプリ再起動**（再起動バナーが出る）
```

同意画面には次が出ます。**このプラグインは JAR を含むので、同意画面に
「アプリと同じ権限で動くコード」として赤字で表示されます。**

- id / name / version / 説明 / 作者 / ライセンス
- **同梱 JAR の一覧**（`gemini-findings.jar`）、`ui.js` の有無、ファイル数・総サイズ
- 宣言 `permissions`（`read-pixels` / `network`）
- 対応 OS の突き合わせ結果、コア版数の互換
- `sha256` と検証状態、署名の状態
- 同じ id が既に入っているか

**[5] の「同意した sha256 と一致するか確認」**は TOCTOU 対策です。同意画面を見てから導入するまでの間に
リリース資産が差し替えられても、**ユーザーが見ていない成果物は入りません**。

導入後は **アプリの再起動**が必要です（JAR を含むため。再起動バナーが出ます）。

### 9-3. Web 版では動きません

| | デスクトップ（standalone） | Web |
|---|---|---|
| 導入操作 | ✅ 環境設定 ＞ プラグイン | ❌ `403`（閲覧のみ） |
| 追加方法 | ユーザーが GitHub / ローカル zip から | 運営がイメージに焼き込む |
| **JAR の実行** | ✅ 同一 JVM | ❌ **`501`（サンドボックス未実装）** |
| UI のみ | ✅ | ✅（運営配備分のみ） |

理由は backend が**共有サーバー**だからです。任意の JAR を共有 JVM に読ませると、そのコードは
サーバー権限で全実行でき、**他患者データの読み取りや他テナント侵害**まで届きます。
このデモのように**外部へデータを送信する JAR** なら、なおさら共有サーバーには載せられません。

仮に運営が Web 版へ焼き込んだとしても、`run()` は `501` になるのでこのプラグインは機能しません。
UI だけが「Plug-ins メニューに出るが押すとエラー」という状態になります
（`ui.js` はそのケースを検出して分かりやすいメッセージを出します）。

> Web で同種のことを実現するなら、**サーバー側サンドボックス**（別プロセス / コンテナ /
> DICOMweb サイドカー）が必要です。現時点では未実装です。

### 9-4. 台帳

`<plugins>/installed.json` に、取得元・sha256・署名鍵・**同梱 JAR 名**・有効無効が記録されます。
JAR 名が記録されているのは、「再起動が必要かどうか」をアプリが判断するためでもあります。

---

## 10. 鍵方式（署名）

**実行コード（JAR）を配るなら、署名してください。** 未署名でも配れますが、
利用者は毎回「何を受け入れるのか」を自分で判断させられることになります。

### 10-1. なぜ必要か — sha256 だけでは足りない

導入時の検証は **4 段**あり、それぞれ守っている性質が違います。ここを混同しないことが重要です。

| 段 | 何を見るか | 守れる性質 | 失敗したら |
|---|---|---|---|
| A | zip の構造・`id`・展開先 | **安全な展開**（zip slip / 巨大 zip / パス脱出） | `422` で拒否 |
| B | `engines.os` / `engines.graphy` | **動く環境か** | 展開前に `422`（同意しても不可） |
| C | `<zip>.sha256` | **完全性**（転送中の破損・部分的な差し替え） | 既定で拒否。明示承諾時のみ通す |
| D | `.minisig`（Ed25519 署名） | **真正性**（誰が作ったか・乗っ取り検知） | **無条件で拒否** |

**sha256 は同じリリースから取ってきます。** リポジトリを支配した側は zip とハッシュを両方
差し替えられるので、これは「壊れていないこと」しか保証しません。**誰が作ったかは分かりません。**
そこに答えるのが署名です。

### 10-2. 仕組み — minisign（Ed25519）と TOFU

GRAPHY-Next は [minisign](https://jedisct1.github.io/minisign/) 形式の署名を検証します。
検証に使う鍵は次の順で探します。

| 順 | 鍵の出どころ | 状態 | 挙動 |
|---|---|---|---|
| ① | 本体設定 `trusted-keys`（GRAPHY-Next 公式配布鍵） | `trusted` | **確認画面なしで導入** |
| ② | 台帳に固定した前回の鍵 | `pinned` | **確認画面なしで導入** |
| ③ | リリース同梱の `minisign.pub`（初回のみ） | `first-use` | 確認画面を出し、導入時にこの鍵を固定 |
| — | 検証失敗・鍵 ID 不一致・**署名の剥がし** | `invalid` | **拒否**（承知しても通さない） |

②が **TOFU（trust on first use）** の核心です。初回に見た鍵を台帳に固定し、更新時は
**リリースが同梱してくる鍵ではなく、固定した鍵で**検証します。これにより
**リポジトリ乗っ取りや作者すり替えは、更新の時点で自動的に弾けます。**

「署名を剥がして未署名として出す」抜け道も塞いであります（固定鍵がある id の未署名パッケージは
`invalid` 扱い）。その代わり、**配布者にとって署名は片道の約束**になります。

> **利用者は鍵を一切扱いません。** 鍵の生成・保管は配布者、公式鍵の同梱は本体の仕事で、
> 利用者から見れば「署名されているものは押すだけで入る」だけです。

### 10-3. 作者としてやること（1 回だけ）

```bash
# 1. 鍵を作る。パスフレーズは必ず設定する（空にしない）
minisign -G -p minisign.pub -s minisign.key

# 2. 公開鍵はリポジトリにコミットしてよい（秘密ではない）
git add minisign.pub && git commit -m "add signing public key" && git push

# 3. 秘密鍵とパスフレーズを GitHub の secrets に登録する
gh secret set MINISIGN_SECRET_KEY < minisign.key
gh secret set MINISIGN_PASSWORD     # プロンプトでパスフレーズを入力
```

これだけです。以降、リリースごとの追加作業はありません
（同梱の `release.yml` が署名します。secrets が未登録なら署名ステップは自動でスキップされます）。

**`minisign` の入手**: Ubuntu 22.04 / Pop!\_OS のリポジトリには**ありません**。
[公式のスタティックバイナリ](https://github.com/jedisct1/minisign/releases)を `/usr/local/bin` 等に置いてください。
macOS は `brew install minisign`、Windows は `scoop install minisign` などが使えます。

### 10-4. 秘密鍵の保管がすべて

技術的には Ed25519 の鍵に**有効期限はありません**。失効リストも OCSP も無く、
X.509 証明書のように「期限切れで一斉に動かなくなる」ことは起きません。
鍵の寿命を決めるのは運用だけです。

| 事象 | 起きること | 復旧 |
|---|---|---|
| 秘密鍵を**紛失** | 以後の更新に署名できない。既存利用者は「前回は署名付き＝今回未署名」で**更新を拒否**される | 利用者側でアンインストール→再導入が必要（＝全利用者に影響） |
| 秘密鍵が**漏洩** | 攻撃者が正規の署名を作れる。TOFU も突破される | 鍵のローテーション＋告知 |
| 鍵を**変更**（意図的） | 利用者は「前回と違う鍵」として更新を拒否する | アンインストール→再導入を案内する |

**やること**: オフラインのバックアップを 2 か所（暗号化 USB ＋ パスワードマネージャのセキュアノート等）。
パスフレーズは鍵ファイルと**別の場所**に保管。

**やってはいけないこと**:

- 秘密鍵をリポジトリにコミットする（**公開鍵だけ**コミットする）
- パスフレーズ無しの鍵を作る
- 同じ鍵を他用途（SSH・コード署名など）と兼用する

### 10-5. GRAPHY-Next の「公式鍵」は第三者には配られない

`trusted-keys`（①）に載っているのは **Visionary Imaging Services が自社の公式プラグインを配るための鍵**で、
第三者の作者に渡されることはありません（渡した相手は何でも「公式」として確認画面なしで配れてしまうため）。

第三者の作者は **自分の鍵**を使います。利用者から見た違いは
「初回だけ確認画面が出て、2 回目以降は押すだけになる」ことです。

### 10-6. 手元で検証する

```bash
minisign -V -p minisign.pub -m gemini-findings-0.1.0.zip -x gemini-findings-0.1.0.zip.minisig
```

> **補足（実装者向け）**: 実物の minisign 0.12 は `-H` を付けなくても
> prehashed（algo `ED`・BLAKE2b-512）で署名します。GRAPHY-Next 側は両形式に対応しています。
> また minisign CLI は鍵 ID を**バイト逆順・大文字 hex** で表示します。
> アプリの同意画面も同じ表記に揃えてあるので、そのまま見比べられます。

---

## 11. うまくいかないとき

| 症状 | 見るところ |
|---|---|
| メニューに出ない | `plugin.json` が妥当な JSON か / `contributes` に `viewer2d.menu` があるか / アプリを再起動したか |
| メニューには出るがクリックで無反応 | `ui.js` が `activate` を **export** しているか / DevTools のコンソールに import エラーが出ていないか |
| `runBackend` が **`501`** | **Web 版では JAR 実行不可（仕様）**。デスクトップ版で試す |
| `runBackend` が `404` | `plugin.json` の `entrypoint` 未指定、または `id` 不一致 |
| `runBackend` が `500` | `entrypoint` の完全修飾名の誤り / クラスが `GraphyPlugin` 未実装 / JAR がフォルダ直下にない。アプリのログを見る |
| **JAR を作り直したのに挙動が変わらない** | クラスローダのキャッシュ。**アプリを完全に終了して再起動**する |
| `NoClassDefFoundError: com/fasterxml/…` | 本体の依存が変わった可能性。§5-3 の注意を参照（同梱するか、JDK だけで書き直す） |
| Gemini が `401` / `403` | API キーが無効、または Generative Language API が有効化されていない |
| Gemini が `404` | モデル名が存在しないか、そのキーで使えない。`gemini-2.5-flash` を試す |
| Gemini が `429` | レート制限。しばらく待つ |
| 「本文が返りませんでした」 | セーフティでブロックされた可能性。返された `blockReason` / `finishReason` を確認 |
| 画像が真っ黒で送られる | ビューアをクリック / スクロールして再描画してから実行する |
| 「実行する」が押せない | §5 の確認チェックを入れる（意図的な仕様） |
| 導入ボタンが押せない / `403` | 環境設定 ＞ プラグイン のトグルが OFF、または Web 版 |
| 導入が `422` で拒否される | `engines.os` / `engines.graphy` が非対応、または zip 構造が不正 |
| 「完全性を検証できません」 | Release に `<zip>.sha256` が無い。CI が付けているか確認 |
| CI が「version != tag」で落ちる | `plugin.json` の `version` とタグ `v<version>` を一致させる |
| CI で `graphy-plugin-api` が見つからない | `GRAPHY_VERSION` に対応する GRAPHY-Next の Release に jar が添付されているか確認 |
| 確認画面が毎回出る | 未署名。§10-3 で署名すると 2 回目以降は出なくなる |
| `signature check failed: … does not match` | 配布物が署名後に差し替わった、または別の鍵で署名した。**心当たりが無ければ乗っ取りを疑う** |
| `signature check failed: … different key` | 前回と違う鍵で署名した（TOFU）。回避はアンインストール→再導入 |

---

## 12. できないこと（正直に）

- **これは診断支援ではありません。** 文章の推敲練習のためのサンプルです。
  出力の正しさは何も保証されません。
- **送信データは外部（Google）へ渡ります。** 実患者データを送ってはいけません。
  データの取り扱いは Google の利用規約に従います。
- **API キーは `localStorage` に平文で保存されます**（保存を選んだ場合）。
  プラグインから OS キーチェーンや本体の設定ストアへアクセスする API はありません。
- **Web 版では動きません**（`run()` が `501`）。
- **シリーズの生ピクセル（HU 等）に触れる公式 API はまだありません。**
  添付する画像は表示中キャンバスのスクリーンショット相当（W/L 適用後の 8bit）です。
- **`data-tile-id` は公式 API ではありません。** 本体の版が上がると変わりうる DOM 依存です。
- **宣言 `permissions` は強制されません。** `"network"` と書かなくても通信できてしまいます。
- **実行時の隔離がありません。** JAR はアプリと同じ権限（同一 JVM）で動きます。
- **未署名プラグインの真正性は保証できません。** 同意画面は判断材料を出すだけです。

---

## 参考

- デモ集ハブ: <https://github.com/tatsunidas/graphy-next-plugin-demos>
- 本体: <https://github.com/tatsunidas/GRAPHY-Next>
- ユーザーマニュアル: <https://tatsunidas.github.io/GRAPHY-Next/>
- GRAPHY Lab: <https://graphy.vis-ionary.com/lab/>
- Gemini API: <https://ai.google.dev/gemini-api/docs>

## ライセンス

MIT。自分のプラグインの出発点として自由にコピーしてください。
Gemini API の利用条件は Google の規約に従います。
