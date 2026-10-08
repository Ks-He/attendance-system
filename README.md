# 随机点名 · Random Picker

从一份名单里随机抽人，结果在浏览器网页里展示。适合课堂点名、抽签、抽奖。

同时是一个 **Claude Code 技能**：装好之后，直接说「随机点个名」就能唤起。

- **零依赖** —— 没有 npm、没有打包器，纯 HTML / CSS / JS，离线可用
- **抽过的不再抽** —— 附撤销与重置
- **名单随便给** —— `.txt` / `.csv` / `.xlsx`，拖进页面就行
- **大字号** —— 为教室投屏准备
- **公平** —— 用 `crypto.getRandomValues` + 拒绝采样，没有取模偏差

## 快速开始

### 方式一：双击 `点名.bat`（Windows 最省事）

把名单文件丢进 `roster/` 文件夹，然后双击仓库根目录的 `点名.bat`。它会自动
挑 `roster/` 里的第一份名单（优先 `.xlsx`，然后 `.csv`、`.txt`），载入并打开
浏览器。`roster/` 是空的就只开一个空白页面。

> `roster/` 整个文件夹在 `.gitignore` 里 —— 真实名单（往往带学号、电话）
> 放这儿不会被推到公开仓库。示例数据请用 `sample-roster.txt` 那种虚构姓名。

### 方式二：直接双击网页（不需要 Python）

打开 `skills/random-picker/web/index.html`，把名单文件拖进页面，按空格开始抽。

### 方式三：命令行预载名单（推荐）

```bash
cd skills/random-picker
python scripts/launch.py --roster "名单.xlsx"     # 打开并自动载入
python scripts/launch.py                          # 打开空白页面
python scripts/launch.py --names "张三,李四,王五"   # 直接给名字
```

> 用 `python`，**不要用 `python3`** —— Windows 上 `python3` 往往是微软商店的
> 跳转桩，在非交互 shell 里静默无输出。

### 方式四：装成 Claude Code 技能

```bash
python install.py
```

然后重启 Claude Code（或执行 `/reload-skills`），之后：

> 随机点个名 —— 用 `D:/名单.xlsx` 这份名单

## 网页操作

| 操作 | 说明 |
|---|---|
| `空格` | 抽取下一位 |
| `Ctrl` + `Z` | 撤销上一次抽取 |
| 拖拽文件 | 直接导入 `.txt` / `.csv` / `.xlsx` |
| 导入名单 | 点按钮选文件 |
| 粘贴 / 编辑 | 手写或粘贴一份名单，一行一个 |
| 重置进度 | 清空已抽记录，名单保留 |

## 名单格式

`.txt` 一行一个名字；`.csv` / `.xlsx` 会自动找「姓名」列。

如果名单把班级排成左右两块（表头重复出现两次），**两块的人都会被收进来** ——
只取第一列会静默漏掉一半人。

纯数字（学号、电话）和 `男`/`女` 这类单字不会被当成姓名。
**同名同学各算一条，不做去重**，不然会有人永远抽不到。

详细规则和排错见 [`skills/random-picker/references/usage.md`](skills/random-picker/references/usage.md)。

## 目录结构

```
├── 点名.bat                       Windows 一键启动：双击即载入 roster/ 里的名单
├── roster/                        放名单的文件夹（整体 gitignore，不会外泄）
├── install.py                     把技能装到 ~/.claude/skills/
├── LICENSE                        MIT
├── README.md
└── skills/
    └── random-picker/
        ├── SKILL.md               技能入口
        ├── references/usage.md    详细用法与排错
        ├── scripts/launch.py      读名单 + 打开浏览器（仅标准库）
        └── web/
            ├── index.html         页面
            ├── app.js             抽取逻辑、名单导入
            ├── xlsx-lite.js       浏览器端 xlsx 解析（尽力而为）
            ├── style.css
            └── sample-roster.txt  示例名单（虚构姓名）
```

技能目录名必须和 `SKILL.md` 里 frontmatter 的 `name` 一致，所以这里是
`random-picker`。

## 两点设计取舍

**xlsx 的权威解析在 Python 侧。** `scripts/launch.py` 用 `zipfile` 读 xlsx，
它自动处理 deflate / stored / 数据描述符 / ZIP64。浏览器端的 `xlsx-lite.js` 是
为了「把文件直接拖进页面」这条路径而写的尽力而为版本，失败时会提示改用 CSV。

**不引入 SheetJS。** 体积约 930 KB，而且 npm 上的 `xlsx` 长期停在 0.18.5，
修复了原型污染漏洞的版本只在作者自己的 CDN 发布 —— 开源仓库里写 `npm i xlsx`
等于给别人装一个有已知漏洞的版本。

## 隐私

名单往往含真实姓名、学号、电话。`.gitignore` 已经挡住了 `*.xlsx`、`*.xls`、
`*.csv` 和生成的 `preload.js`，**别把这些提交上去**。要放示例数据请用虚构姓名。

## 常见问题

- **进度刷新后没了？** 直接双击打开时页面的 origin 是 opaque，浏览器不保证
  存储持久化。刷新后名单还在、已抽记录清空。
- **中文乱码？** 会自动依次尝试 UTF-8 BOM / UTF-16 / 严格 UTF-8 / GBK，一般
  不会乱。还乱就用记事本另存为 UTF-8。
- **`python3` 没反应？** 换成 `python`。
- 更多见 [`references/usage.md`](skills/random-picker/references/usage.md)。

## 开源发布

```bash
git remote add origin git@github.com:<你的账号>/<仓库名>.git
git push -u origin main
```

建议顺手把 `LICENSE` 里的 `attendance-system contributors` 换成你自己的名字。

## License

MIT
