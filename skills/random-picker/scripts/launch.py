#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""随机点名 —— 在浏览器里打开抽取页面，可选把一份名单预载进去。

只用 Python 标准库，不需要装任何东西。这个脚本做两件事：

1. 读名单（.txt / .csv / .xlsx），识别出「姓名」列
2. 把名字写进 web/preload.js，然后打开 web/index.html

xlsx 的解析放在这里而不是浏览器里，是因为 Python 的 zipfile 会自动处理
deflate / stored / 数据描述符 / ZIP64 这些情况，比浏览器端手写 ZIP 解析可靠。
浏览器端的 web/xlsx-lite.js 只服务「把文件直接拖进页面」那条路径。

用法：
    python launch.py                                  # 打开空白页面
    python launch.py --roster 名单.xlsx                # 打开并自动载入名单
    python launch.py --names "张三,李四,王五"           # 直接给名字
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import webbrowser
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

HERE = Path(__file__).resolve().parent
WEB_DIR = HERE.parent / "web"
INDEX = WEB_DIR / "index.html"
PRELOAD = WEB_DIR / "preload.js"

HAN = re.compile(r"[一-龥]")
NUMBERING = re.compile(r"^\s*\d+\s*[.、)．]\s*")
NAME_HEADER = re.compile(r"^(姓名|名字|学生姓名|名称|名单|name|fullname)$", re.I)
LATIN_NAME = re.compile(r"[A-Za-z][A-Za-z.'\-]{1,29}")
CELL_IS_NUMBERISH = re.compile(r"^[\d\s\-.+()（）]+$")

HEADER_WORDS = {"姓名", "名字", "名称", "学生", "学生姓名", "名单", "name", "fullname"}
BAD_HEADERS = (
    "学号", "序号", "编号", "学籍", "性别", "专业", "班级", "学院", "电话", "手机",
    "联系", "备注", "宿舍", "邮箱", "住址", "民族", "政治", "身份证",
    "id", "no", "num", "phone", "tel", "class", "major", "email",
)


# --------------------------------------------------------------------------
# 姓名识别（与 web/app.js 里的启发式保持一致）
# --------------------------------------------------------------------------

def tidy(value) -> str:
    """去掉编号前缀、零宽字符、全角空格 —— 从 Word/Excel 里粘出来的名单常带这些。"""
    text = "" if value is None else str(value)
    for ch in ("\u200b", "\ufeff"):
        text = text.replace(ch, "")
    text = text.replace("\u3000", " ").replace("\xa0", " ")
    text = NUMBERING.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def looks_like_name(value) -> bool:
    t = tidy(value).replace(" ", "")
    if not t:
        return False
    if CELL_IS_NUMBERISH.match(t):                 # 学号、电话、序号
        return False
    if t.lower() in HEADER_WORDS:
        return False

    han = len(HAN.findall(t))
    if han:
        # 2–6 个汉字，允许少数民族姓名的间隔号
        return 2 <= han <= 6 and not re.sub(r"[一-龥·]", "", t)
    return bool(LATIN_NAME.fullmatch(t))


def score_column(header, values) -> float:
    head = re.sub(r"\s", "", "" if header is None else str(header)).lower()
    score = 0.0
    if NAME_HEADER.match(head):
        score += 100
    if any(bad in head for bad in BAD_HEADERS):
        score -= 100

    filled = [v for v in values if tidy(v)]
    if not filled:
        return -1000.0

    score += sum(1 for v in filled if looks_like_name(v)) / len(filled) * 50
    # 姓名列基本不重复，"专业"列会大量重复
    score += len({tidy(v) for v in filled}) / len(filled) * 15
    return score


def names_from_table(rows) -> list:
    """从二维表里取出姓名列（可能有多列，见下面的注释）。"""
    if not rows:
        return []

    # 1) 找表头行，并收集该行里**所有**姓名列。
    #    有的名单把班级排成左右两块，表头重复出现（学号/姓名/… | 学号/姓名/…），
    #    只取第一列会静默漏掉一半人。
    for r, row in enumerate(rows[:12]):
        cols = [c for c, cell in enumerate(row)
                if NAME_HEADER.match(re.sub(r"\s", "", str(cell or "")))]
        if not cols:
            continue
        picked = []
        for col in cols:
            for line in rows[r + 1:]:
                value = tidy(line[col] if col < len(line) else "")
                if value and looks_like_name(value):
                    picked.append(value)
        if picked:
            return picked

    # 2) 没有表头：逐列打分，平分时取更靠左的列
    width = max((len(row) for row in rows), default=0)
    if not width:
        return []

    best_score, best_col = float("-inf"), -1
    for col in range(width):
        values = [row[col] if col < len(row) else "" for row in rows]
        score = score_column(rows[0][col] if col < len(rows[0]) else "", values)
        if score > best_score + 1e-9:
            best_score, best_col = score, col
    if best_col < 0:
        return []

    out = []
    for row in rows:
        value = tidy(row[best_col] if best_col < len(row) else "")
        if value and looks_like_name(value):
            out.append(value)
    return out


def split_names(text) -> list:
    out = []
    for line in re.split(r"\r\n|\n|\r", str(text or "")):
        for piece in re.split(r"[,，、;；\t|]+", line):
            name = tidy(piece)
            if name:
                out.append(name)
    return out


# --------------------------------------------------------------------------
# 读文件
# --------------------------------------------------------------------------

def read_text(path: Path) -> str:
    raw = path.read_bytes()
    if raw[:3] == b"\xef\xbb\xbf":
        return raw[3:].decode("utf-8")
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")          # Excel 的「Unicode 文本」导出
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    try:
        return raw.decode("gbk")             # WPS / Windows 导出常见
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="replace")


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _col_index(ref):
    match = re.match(r"([A-Z]+)", ref or "")
    if not match:
        return -1
    n = 0
    for ch in match.group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _cell_text(cell, shared) -> str:
    ctype = cell.get("t")
    if ctype == "inlineStr":                 # WPS / Google Sheets 导出大量使用
        return "".join(cell.itertext())      # itertext 会自动拼好富文本 run

    value = next((child for child in cell if _local(child.tag) == "v"), None)
    if value is None:
        return ""
    text = "".join(value.itertext())
    if ctype == "s":
        try:
            return shared[int(text)]
        except (ValueError, IndexError):
            return ""
    return text


def _first_sheet_path(zf, names) -> str:
    try:
        workbook = ET.fromstring(zf.read("xl/workbook.xml"))
        rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        sheet = next((node for node in workbook.iter() if _local(node.tag) == "sheet"), None)
        rid = None
        if sheet is not None:
            for key, value in sheet.attrib.items():
                if _local(key) == "id":
                    rid = value
                    break
        if rid:
            for rel in rels:
                if rel.get("Id") != rid:
                    continue
                target = (rel.get("Target") or "").lstrip("/")
                full = target if target.startswith("xl/") else "xl/" + target
                if full in names:
                    return full
    except Exception:
        pass

    candidates = sorted(n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
    return candidates[0] if candidates else ""


def read_xlsx(path: Path):
    """返回第一张工作表的二维文本数组。zipfile 会自动处理 deflate / stored /
    数据描述符 / ZIP64，所以这里不需要手写 ZIP 解析。"""
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())

        shared = []
        if "xl/sharedStrings.xml" in names:
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            # itertext 自动拼接富文本 run：<si><r><t>张</t></r><r><t>三</t></r></si> -> 张三
            shared = ["".join(node.itertext()) for node in root if _local(node.tag) == "si"]

        sheet_path = _first_sheet_path(zf, names)
        if not sheet_path:
            raise ValueError("这个 xlsx 里没有工作表")

        root = ET.fromstring(zf.read(sheet_path))
        rows = []
        for row in root.iter():
            if _local(row.tag) != "row":
                continue
            line = []
            for cell in row:
                if _local(cell.tag) != "c":
                    continue
                at = _col_index(cell.get("r"))
                if at < 0:
                    at = len(line)
                while len(line) <= at:              # 稀疏单元格要按列号补位
                    line.append("")
                line[at] = _cell_text(cell, shared)
            rows.append(line)
        return rows


def names_from_file(path: Path) -> list:
    suffix = path.suffix.lower()
    if suffix in (".xlsx", ".xlsm"):
        return names_from_table(read_xlsx(path))
    if suffix == ".xls":
        raise ValueError("不支持旧版 .xls，请在 Excel/WPS 中另存为 .xlsx 或 .csv 再导入")

    text = read_text(path)
    if suffix == ".csv":
        rows = [line for line in re.split(r"\r\n|\n|\r", text) if line.strip()]
        table = [[cell.strip('"') for cell in line.split(",")] for line in rows]
        if any(len([c for c in row if c.strip()]) > 1 for row in table):
            picked = names_from_table(table)
            if picked:
                return picked
    return split_names(text)


# --------------------------------------------------------------------------

def write_preload(names) -> None:
    """把名单写进 web/preload.js —— index.html 启动时读它。

    名字故意用 \\uXXXX 转义写成纯 ASCII：这样文件内容不受脚本编码探测影响，
    在任何浏览器或终端下都不会出现乱码。
    """
    payload = json.dumps(list(names), ensure_ascii=True)
    PRELOAD.write_text(
        "// generated by scripts/launch.py -- do not edit by hand (gitignored)\n"
        "window.__PRELOAD_NAMES__ = %s;\n" % payload,
        encoding="utf-8",
    )


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    parser = argparse.ArgumentParser(
        description="随机点名：在浏览器中打开抽取页面，可选预载一份名单。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--roster", "-r", metavar="文件",
                        help="名单文件（.txt / .csv / .xlsx），打开页面时自动载入")
    source.add_argument("--names", "-n", metavar="名字",
                        help="直接给名字，用逗号 / 空格 / 顿号分隔")
    parser.add_argument("--clear", action="store_true", help="清除上次预载的名单")
    parser.add_argument("--no-open", action="store_true", help="只准备页面，不自动打开浏览器")
    args = parser.parse_args()

    if not INDEX.exists():
        print("找不到页面文件：%s" % INDEX, file=sys.stderr)
        return 1

    if args.roster:
        path = Path(args.roster).expanduser()
        if not path.exists():
            print("找不到名单文件：%s" % path, file=sys.stderr)
            return 1
        try:
            names = names_from_file(path)
        except zipfile.BadZipFile:
            print("这个文件不是有效的 xlsx（可能已损坏或加密）", file=sys.stderr)
            return 1
        except Exception as exc:
            print("读取名单失败：%s" % exc, file=sys.stderr)
            return 1
        if not names:
            print("没能从 %s 里认出姓名，检查一下是否有「姓名」列（也可以先另存为 CSV）" % path.name,
                  file=sys.stderr)
            return 1
        write_preload(names)
        print("已载入 %d 人（来源：%s）" % (len(names), path.name))

    elif args.names:
        names = split_names(args.names)
        if not names:
            print("没有解析出名字", file=sys.stderr)
            return 1
        write_preload(names)
        print("已载入 %d 人" % len(names))

    elif args.clear:
        write_preload([])
        print("已清除预载名单")

    elif not PRELOAD.exists():
        write_preload([])          # 避免页面加载 preload.js 时 404

    url = INDEX.as_uri()
    if args.no_open:
        print(url)
    else:
        webbrowser.open(url)
        print("已在浏览器中打开：%s" % url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
