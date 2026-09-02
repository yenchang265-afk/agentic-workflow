[English](47-checkpoint-screen.md) | 繁體中文

# 47 —— 自動檢查點會篩選它掃進來的東西

**狀態：已實作。**

## 問題

`commitAll`——兩種 host 上每個工作階段結尾的檢查點——就是一個 `git add -A`。
它唯一的排除是待辦目錄（worktree 模式）與 lockfile，所以任何階段留在樹裡、
`.gitignore` 沒蓋到的東西都會搭上 feature 分支：安裝腳本寫下的 `.env`、安裝步
驟掉出的 `.pem`、測試框架產生的 `credentials.json`、下載的 fixture 或覆蓋率壓縮
檔。設計 05 的遮罩涵蓋的是持久的**文字**產物（稽核註記、計畫、執行紀錄）；它從
未看過檢查點提交的程式碼，而檢查點是 PR 所攜帶分支上的永久歷史。

## 改了什麼

- **`screenCheckpoint` 在 `commitAll` 內部執行**，先於 `add -A`：讀取
  `git status --porcelain -z --untracked-files=all`，保留掃描會納入的每條路徑
  （略過刪除與 rename 來源），並拒絕依檔名**形似機密**者
  （`CHECKPOINT_SECRET_BASENAMES`：dotenv 檔，`.example`/`.sample`/
  `.template`/`.dist`/`.defaults` 慣例除外；`*.pem|key|p12|pfx|jks|keystore|
  asc|gpg|kdbx`；SSH 私鑰；`credentials.json`/`service-account*.json`/
  `client_secret*.json`；`.netrc`/`.pgpass`/`.git-credentials`；`*.tfstate`）
  或**過大**者（以 `stat` 判定、超過 `CHECKPOINT_BLOB_MAX` 5 MiB 的一般檔案）。
- **被拒的路徑成為同一個 `add` 上的 `:(exclude,literal)` pathspec**，正是
  lockfile 排除已在用的機制——用 `literal` 是因為被篩掉的路徑是一個**名字**，
  裡頭的 glob 字元不可放大成樣式。
- **`commitAll` 回傳 `{ committed, screened }`**，每個 host 呼叫點（OpenCode
  driver 的 `checkpoint`、Claude 伺服器的終結 port、其 build 檢查點、以及
  `workflow_checkpoint`）都記錄 `screenedWarning`——「N 條路徑被排除在自動掃描
  之外 —— `.env`（secret-shaped）…… 以明確的 `git add <path>` 提交」。

## 尖銳邊角

- **篩選住在 `commitAll` 裡，不在呼叫端**，這樣沒有任何檢查點呼叫點能繞過它——
  現有的四個呼叫點正是逐呼叫端規則會被漏掉的證明。
- **它只收窄「自動」掃描，別無其他。** BUILD 明確 stage 的路徑不受影響，一如
  lockfile 規則已承諾的；被篩掉但確實屬於變更的路徑，代價是一次明確的
  `git add`。刻意收緊，因為誤判的代價是那一道指令，漏判的代價是歷史裡的機密。
  `.npmrc`/`.pypirc` **不**篩：倉庫會為 mirror 設定而提交它們。
- **它偏向掃描失敗。** status 探測失敗就不篩任何東西；無法 `stat` 的路徑不是
  blob。檢查點上的守衛永遠不能賠上檢查點。
- **porcelain 以原始形式讀取。** `run` 的 `trim` 會吃掉 ` M path` 項目開頭的空
  白，把路徑的第一個字元當成 XY 碼交給解析器——因此有 `runRaw`，以及一個把該
  項目放在第一位的測試。
