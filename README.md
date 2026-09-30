# PDF／影像合併與轉換工具

本機執行的 PDF／影像處理工具，網頁介面，資料完全不會上傳到任何伺服器。

## 功能

- **合併**：把多個 PDF 與 JPG／PNG 依指定順序合併成一份 PDF（支援拖曳排序、A4 縮放、加密 PDF 解鎖）
- **PDF 轉影像**：把 PDF 指定頁碼範圍轉成 PNG／JPG，可各自存檔或打包成 ZIP

## 啟動方式

### 方式一：直接執行 exe（不需要裝 Python）

雙擊 `dist/pdf-maker.exe`。第一次啟動會比較慢（幾秒內把程式解壓到暫存資料夾），之後自動開啟瀏覽器。

會跳出一個黑色主控台視窗顯示伺服器 log，這個視窗留著程式才會繼續跑。

沒有現成的 exe 檔案時，見下方「打包成 exe」自行建置。

### 方式二：用 Python 執行（開發用）

```bash
.venv\Scripts\python.exe main.py
```

第一次使用需要先建立虛擬環境並安裝套件：

```bash
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

啟動後會自動開瀏覽器到 `http://127.0.0.1:8765`。

## 關閉方式

- **看得到黑色主控台視窗**：直接關閉視窗，或點進視窗按 `Ctrl + C`
- **視窗不見了但瀏覽器還打得開**：開工作管理員（`Ctrl + Shift + Esc`），結束 `pdf-maker.exe`（或 `python.exe`）

關閉後，暫存的上傳檔案與尚未下載的處理結果會被清除，請先下載完成的檔案再關閉。

## 打包成 exe

```bash
.venv\Scripts\python.exe -m pip install pyinstaller
.venv\Scripts\python.exe -m PyInstaller pdf-maker.spec
```

產出的執行檔在 `dist/pdf-maker.exe`，可以獨立複製到其他 Windows 電腦執行，不需要該電腦裝 Python。

## 執行測試

```bash
.venv\Scripts\python.exe -m pytest
```
