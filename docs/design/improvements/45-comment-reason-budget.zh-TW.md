[English](45-comment-reason-budget.md) | 繁體中文

# 45 — plan-review 留言共享 reason 預算

**狀態：已實作。**

## 問題

Hub 的 plan-review 抽屜邀請逐行錨定留言，並把它們熔成一次 replan 攜帶
的那條 `reason`。`composeReason` 無上限地串接——而 core 透過
`oneLineReason` 把每條閘門 reason 鉗在 `REPLAN_REASON_MAX`（1200），它
的省略號會把「尾巴上的留言」整條吃掉。兩三條普通的錨定留言就會組超過
1200，於是後面的留言無聲地永遠到不了下一輪 PLAN——正是逐行留言功能要修
的那個「模糊 replan」失敗，而且哪裡都沒有警告。

## 改了什麼

- **預算感知的組合。**舒適形（每條 note 400 字）裝得下時，輸出與從前逐
  字節相同。裝不下時，note 額度在留言間平均分配（下限 40），讓每一條留
  言都以裁剪後的樣子存活——丟掉每條 note 的尾巴勝過丟掉整條留言。最後的
  硬截斷只有在下限生效時（非常多留言）才可能觸及，那裡 core 自己的鉗子
  本來也會動手。
- **看得見的量表。**抽屜的送出列顯示 `reason N/1200`，並在 note 被壓縮
  時明說（「修剪或合併，讓每個論點都完整」）。
- **`REASON_BUDGET` 釘住 core。**因為 `comments.ts` 會被打包進瀏覽器、
  core 是 node 口味，所以常數在 web 側宣告；`comments.test.ts` 匯入
  core 的 `REPLAN_REASON_MAX` 斷言兩者相等，杜絕無聲漂移。

## 尖銳邊界

- **錨永遠完整存活**（各自 60 字上限裁剪）：引文是告訴下一輪 PLAN「這
  條 note 在說哪一步」的東西——沒有錨的 note 就是錨存在要防的「三個階段
  之後只剩『這裡不對』」失敗。
- **core 的鉗子不動。**`oneLineReason` 仍是每條寫入路徑的收口；這次改
  動是讓 hub 在鉗子「裡面」組合，而不是指望它截得漂亮。
