# 文型の例と選び方

## 文型ごとの例

例の主語は、架空の予約システムにしている。
実際の要求では、対象のシステム・部品の名前にする。

| 文型 | 例（日本語） | 例（英語） |
| --- | --- | --- |
| 常時 | 予約システムは、予約の一覧を開始日時の早い順に表示しなければならない。 | The booking system shall list bookings in ascending order of start time. |
| イベント駆動 | 利用者が予約を確定したとき、予約システムは、確定の通知を利用者に送らなければならない。 | When a user confirms a booking, the booking system shall send a confirmation notice to the user. |
| 状態駆動 | 保守の時間帯の間、予約システムは、新しい予約を受け付けてはならない。 | While the maintenance window is active, the booking system shall not accept new bookings. |
| 望まない振る舞い | 確定の時点で枠が埋まっていた場合、予約システムは、予約を確定してはならない。 | If the slot is full at confirmation, then the booking system shall not confirm the booking. |
| 望まない振る舞い | 確定の時点で枠が埋まっていた場合、予約システムは、空いている別の枠を3件まで示さなければならない。 | If the slot is full at confirmation, then the booking system shall show up to three other available slots. |
| オプション | 決済の機能を含む場合、予約システムは、確定の前に料金を表示しなければならない。 | Where the payment feature is included, the booking system shall display the price before confirmation. |
| 複合 | 利用者がログインしている間、予約を取り消したとき、予約システムは、取り消しの記録を残さなければならない。 | While a user is signed in, when the user cancels a booking, the booking system shall record the cancellation. |

望まない振る舞いの例は、同じ事象への応答が「確定しない」「別の枠を示す」の2つあるので、2つの要求に分けている。
同じ条件・きっかけでも、応答が2つあれば、1文にまとめずに要求を分ける。

## 選び方

| 問い | はい | いいえ |
| --- | --- | --- |
| 異常・失敗・不正な入力への応答か | 望まない振る舞い | 次の問いへ |
| 特定の機能・構成を含むときだけか | オプション | 次の問いへ |
| 出来事をきっかけに応答するか | イベント駆動（状態も要れば複合） | 次の問いへ |
| ある状態が続く間だけ成り立つか | 状態駆動 | 常時 |

- 「〜したとき」は出来事（一度起きる）で、イベント駆動にする
- 「〜の間」「〜している限り」は状態（続いている）で、状態駆動にする
- 失敗や誤りを「〜したとき」と書きたくなったら、望まない振る舞いにする

## 直す例

| 直す前 | 問題 | 直した後 |
| --- | --- | --- |
| システムは、速やかに検索結果を表示すること。 | 「速やかに」で合否を決められない | 利用者が検索を実行したとき、検索システムは、2 秒以内に結果を表示しなければならない。 |
| ログインに失敗したらロックし、管理者に通知する。 | 応答が2つ。異常系なのに文型が無い | R-1：ログインに連続して5回失敗した場合、認証システムは、そのアカウントを15分間ロックしなければならない。<br>R-2：認証システムがアカウントをロックしたとき、認証システムは、管理者に通知しなければならない。 |
| 一覧はデータベースから取得してキャッシュする。 | 実装の方法を書いている | 利用者が一覧の画面を開いたとき、表示システムは、1 秒以内に一覧を表示しなければならない。 |
