# サムネイルバーの自動表示・非表示（Picasa 準拠）設計

- 日付: 2026-09-23
- 状態: 実装済み
- 関連: `PROJECT_SPEC.md` §Thumbnail Bar / §Image Info Overlay、`docs/code-rationale.md` Z1 / W1

## 1. 目的

Picasa Photo Viewer と同様に、サムネイルバーを普段は完全に非表示にし、ユーザーが「下へ素早く振る」か「バーにホバーする」ときだけ表示する。現状はバーが常に 50% 不透明で画像下部に重なっている（`src/App.css` `.thumbnail-bar`、ホバーで 100%）。

## 2. 要求（ユーザー原文の要約）

- R1 非アクティブ時は完全に非表示（不透明度 0）。
- R2 バーへのホバー、または一定以上の速度かつ距離（150px 程度）の下方向移動でアクティブになる。ゆっくりならどれだけ進んでも、速くても距離が足りなければ反応しない。
- R3 アクティブ中、下方向への移動が続く限りアクティブを維持する。
- R4 アクティブ中、停止または一定以下の速度（方向不問）が 2000ms 程度続くと非アクティブになる。
- R5 アクティブ中、一定以上の速度・距離の上方向移動で 2000ms を待たずに非アクティブになる。
- R6 切り替えは 500ms 程度のアニメーション。

## 3. 決定事項（レビューで確定）

- D1 **レイアウトは変えない**。最大化・全画面での 80px 帯の確保（`viewerLayoutArea`）、Z1、W1 はそのまま。変わるのはバーの見た目と入力受付のみで、表示切替で画像は動かない。全面使用（Picasa 同等のレイアウト）は別課題。
- D2 R3 の維持条件は **活性化より低い速度閾値（V_keep）で下方向に動いていること**（2 閾値方式）。
- D3 **起動時とフォルダ切替時は表示し、2000ms 後に通常どおり消える**（バーの存在を知らせる）。起動時の表示はフェードなしで即時。
- D4 **非表示中はクリックとホイールを受け付けない**。ホバーによる表示は受け付ける。
- D5 高速な水平移動、低速な移動（方向不問）はタイマーを延長しない。
- D6 ボタン押下中（パンのドラッグ等）の移動は無視する。
- D7 キーボードフォーカス（`:focus-visible`）はホバーと同等に扱う。マウスクリック後の通常フォーカスは数えない（数えるとクリック後にバーが消えなくなる）。
- D8 `prefers-reduced-motion` ではトランジションなし。
- D9 `.image-info`（ファイル名行）はバー内要素なので一緒に表示・非表示になる（PROJECT_SPEC の「同じ不透明度挙動」と一致）。
- D10 未使用の `view.thumbnailOpacity` / `setThumbnailOpacity` を削除する。

## 4. 振る舞い（状態機械）

### 4.1 状態

`hidden` / `shown` と、非表示予定時刻 `hideAt`。バーがホバー中またはキーボードフォーカス中は `hideAt` を停止し、離れた時点から 2000ms を数え直す。

### 4.2 入力サンプル

`window` の `pointermove`（`clientX`, `clientY`, `timeStamp`）。`buttons !== 0` のサンプルは無視し、進行中のストロークもリセットする（D6）。距離は CSS px（DPI 150% では物理 225px = 画面上の物理的な距離が一定）。

### 4.3 ストローク

同じ垂直方向への連続移動。

- 速度 `v` は直近約 60ms のサンプル窓で求める（イベント頻度 60Hz〜1000Hz の揺れを吸収するため）。
- 次のいずれかでストロークを切り、累積距離を 0 に戻す:
  - サンプル間隔が 100ms 以上（停止）
  - 方向の反転（4px までの逆走は揺れとして許容）
  - 垂直から 45° を超える傾き
  - 窓速度が V_on を下回る（活性化・即時非表示判定用のストロークのみ）

### 4.4 遷移

| 遷移 | 条件 |
|---|---|
| hidden → shown | バーへのホバー、または下方向ストロークが V_on 以上を保ったまま累積 150px 以上 |
| shown 維持（`hideAt` を延長） | 下方向の移動で窓速度が V_keep 以上 |
| shown → hidden（タイマー） | 最後の延長から 2000ms 経過、かつホバー・キーボードフォーカス中でない |
| shown → hidden（即時） | 上方向ストロークが V_on 以上を保ったまま累積 150px 以上 |
| → shown（強制） | 起動時、画像リスト変更（フォルダ切替）時。その後は通常の 2000ms |

held（ホバー中またはキーボードフォーカス中）は上方向ストロークの即時非表示（表の「shown → hidden（即時）」）も適用しない。ホバー/フォーカス自体が意図の表明であり、ここで隠すと hold の行き場がなくなる。

### 4.5 初期値

| 定数 | 値 | 根拠 |
|---|---|---|
| 活性化距離 | 150px | R2 |
| V_on | 800px/s | 150px を約 190ms 以内。意図的な「振り」と、画像を眺めながらの移動を分ける目安 |
| V_keep | 150px/s | D2。ゆっくりバーへ近づく動作で消えないように |
| 速度窓 | 60ms | 60Hz で 3〜4 サンプル |
| 停止判定 | 100ms | 60Hz の数フレーム欠落は停止とみなさない |
| 傾き上限 | 45° | 斜め下へ振る動作を許容し、水平移動を除外 |
| 逆走許容 | 4px | 手の揺れ |
| 非表示遅延 | 2000ms | R4 |
| フェード | 500ms | R6 |

いずれも手探りの初期値で、実機で手動調整する。

### 4.6 見た目と入力受付

- `.thumbnail-bar` は `opacity: 0`、`.thumbnail-bar.shown` は `opacity: 1`、`transition: opacity 500ms ease`。
- 非表示中は `.thumbnail-container` に `pointer-events: none`、ホイールでのナビゲーションも無効（D4）。`<nav>` 自体はホバーを受ける。
- `display: none` は使わない（`scrollToActiveItem` が `offsetLeft` / `offsetWidth` に依存し、非表示中に中央寄せが壊れるため）。
- 既知の限界: ホバーで即時表示するため、バー上へのクリックは通常ホバーを経て届く。D4 が実際に効くのは、移動を伴わないクリック（フォーカス取得クリック、タップ）に限られる。
- 状態機械は App のマウント時に起動する（`ThumbnailBar` 自体は常にマウントされているが、`folder.images` が空の間は null を返す）。App 起動から 2000ms 以内にフォルダを開いた場合のみ、内部の `shown` がまだ true のうちに `<nav>` が初めて DOM に挿入されるため、CSS トランジションは初回スタイルを補間せずフェードなしで表示される。2000ms を超えてから初めてフォルダを開いた場合は、その時点で内部の `shown` が false に戻っているため `forceShow` で true に戻し、通常どおり 500ms でフェードインする。フォルダ切替時の再表示は常に 500ms でフェードインする。

## 5. 実装構成

| ファイル | 役割 |
|---|---|
| `src/utils/thumbnailBarGesture.ts`（新規） | 純粋な状態機械。`step(state, event) → state`。`event` は `move` / `tick` / `hoverChange` / `forceShow`、時刻は event に含める。DOM・タイマーを持たない。閾値は `THUMBNAIL_BAR_GESTURE` として export |
| `src/hooks/useThumbnailBarVisibility.ts`（新規） | `window` の `pointermove` 購読と `hideAt` の `setTimeout`。状態は ref に持ち、`shown` が反転したときだけ `setState`（mousemove ごとの再レンダリングを避ける）。`{ shown, barProps }` を返す |
| `src/components/ThumbnailBar.tsx` | `isHovered` をフックに置換、クラス名 `hovered` → `shown`、非表示中は `handleWheel` を早期 return、画像リスト変更で `forceShow` |
| `src/App.css` | §4.6 のスタイル、`prefers-reduced-motion` 上書き |
| `src/constants/timing.ts` | `THUMBNAIL_BAR_HIDE_DELAY_MS = 2000`（フェード 500ms は CSS にのみ書く。TS から参照されない定数は置かない） |
| store / types / testUtils / testFactories | D10 の削除 |
| `PROJECT_SPEC.md` | §Thumbnail Bar / §Image Info Overlay の書き換え、windowed mode の記述、`thumbnailOpacity` の削除 |

表示状態は ThumbnailBar のローカル状態に置く。他のコンポーネントは参照しないため store には入れない。

コードコメントはファイル先頭に `Spec: docs/superpowers/specs/2026-09-23-thumbnail-bar-auto-hide-design.md` を 1 回書き、以降は `§4.3` / `(D6)` で参照する。

## 6. テスト

- `thumbnailBarGesture.test.ts`（合成サンプルのテーブル駆動、60 / 144 / 1000Hz）
  - 低速で長い下方向（100px/s × 600px）→ 表示しない
  - 高速で短い下方向（2000px/s × 100px）→ 表示しない
  - 高速 150px の下方向 → 表示
  - 45° を超える斜め → 表示しない
  - 下方向 150px の途中に 120ms の停止 → 表示しない
  - ボタン押下中の下方向ストローク → 表示しない
  - 表示中に 200px/s で下方向 → 維持。停止 → 2000ms で非表示。低速の水平移動 → 2000ms で非表示。高速の水平移動 → 2000ms で非表示
  - 高速 150px の上方向 → 即時非表示
  - ホバー中はタイマー停止、離脱から数え直し
- `useThumbnailBarVisibility.test.ts`: `vi.useFakeTimers` と `PointerEvent` の dispatch。再レンダリングが遷移時のみであること、アンマウントでリスナーが外れること。
- `ThumbnailBar.test.tsx`: 既存の `hovered` テストを `shown` に置換。非表示中はクリック・ホイールが無効。マウント時に表示され 2000ms 後に消える。画像リスト変更で再表示。
- E2E: 変更不要の見込み。`centering` / `preview-display` / `window-fit` はバーの rect を読み、opacity の影響を受けない。`visual` の `:not(:hover)` 計算スタイル検査は opacity / `pointer-events` に依存しない。`npm run test:e2e` で確認する。
- bench: パフォーマンス変更ではないため対象外。
- 手動（実機チェックリスト）: 閾値の体感調整、DPI 150%、トラックパッド、ウインドウ化モード（W1 でバーが画像下部に重なる状態）。

## 7. 対象外

- 表示方式の設定トグル・閾値調整 UI（設定機構が無い）
- 非表示時の 80px 帯の回収（D1）
- キーボードナビゲーション時のバー表示
