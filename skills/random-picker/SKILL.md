---
name: random-picker
description: 从用户提供的名单里随机抽取一个人，并在浏览器中打开网页展示结果（课堂点名、抽签、抽奖）。当用户说「随机点名」「随机抽一个」「抽一个人」「从名单里抽」「抽签」「抽奖」，或提到 classroom roll call / randomly pick a name / lucky draw 时使用。也适用于这类后续请求：导入名单文件（.txt / .csv / .xlsx）、抽过的不再抽、撤销上一次抽取、重置点名进度、调整名单。
version: 1.0.0
license: MIT
---

# 随机点名（Random Picker）

从一份名单里随机抽人，结果在一个本地网页里展示——大字号、适合投屏，
默认「抽过的不再抽」，带撤销和重置。

页面是纯静态的，零依赖、可离线；本技能只是负责**备好名单**并**把浏览器打开**。

## 怎么用

三条命令，都在技能目录下执行：

```bash
# 1) 直接打开空白页面，让用户在网页里导入名单
python "${CLAUDE_SKILL_DIR}/scripts/launch.py"

# 2) 把一份名单文件预载进去（.txt / .csv / .xlsx）
python "${CLAUDE_SKILL_DIR}/scripts/launch.py" --roster "C:/path/to/名单.xlsx"

# 3) 用户直接在对话里给了名字
python "${CLAUDE_SKILL_DIR}/scripts/launch.py" --names "张三,李四,王五"
```

如果 `${CLAUDE_SKILL_DIR}` 没有被替换成实际路径，就改用 SKILL.md 所在的绝对路径，
例如 `python "D:/xxx/skills/random-picker/scripts/launch.py"`。两种写法都一样。

脚本用 `webbrowser.open` 打开页面后立刻返回，**不会阻塞会话**，正常当普通命令跑就行。

## 几个要点

- **必须用 `python`，不要用 `python3`。** Windows 上 `python3` 常常是微软商店的
  跳转桩（`AppInstallerPythonRedirector.exe`），在非交互 shell 里静默无输出，
  会让你误以为脚本没反应。
- **路径带空格一定要加引号**，仓库目录名本身就可能带空格。
- **用户在对话里贴了一串名字时，不要手工往网页里敲**，用 `--names` 传进去。
- `--roster` 支持 `.txt` / `.csv` / `.xlsx`。xlsx 由 Python 侧解析（`zipfile` 自动
  处理 deflate / stored / 数据描述符 / ZIP64），比浏览器端可靠。旧版 `.xls`
  和加密文件不支持，需要先另存为 `.xlsx` 或 `.csv`。
- 名单里的**同名同学各算一条**，不做去重——不然会有人永远抽不到。
- 识别「姓名」列时会扫描整行表头，**收集所有姓名列**：有的名单把班级排成左右
  两块，表头重复出现，只取第一列会静默漏掉一半人。

## 网页里能做什么

导入名单（拖拽文件或点按钮）、空格键抽取、`Ctrl+Z` 撤销、重置进度、
侧栏按顺序列出已抽名单。进度存在浏览器本地，尽量保留但不保证。

## 遇到问题

编码乱码、xlsx 读不出来、列识别错了、进度没保存等情况，
看 [references/usage.md](references/usage.md)。

## 隐私

名单往往含真实姓名、学号、电话。**不要把真实名单提交到公开仓库** ——
仓库的 `.gitignore` 已经挡住了 `*.xlsx`、`*.xls`、`*.csv` 和生成的 `preload.js`。
要放示例数据请用虚构姓名（参考 `web/sample-roster.txt`）。
