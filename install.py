#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 skills/random-picker 安装到 ~/.claude/skills/random-picker。

放在仓库根目录（而不是技能目录里面）是有意的：它是仓库的工具，
不应该被打包进技能，也避免"把目录复制进自身"的递归问题。

用法：
    python install.py            # 安装
    python install.py --force    # 覆盖已安装的旧版本
    python install.py --dest 某目录
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "skills" / "random-picker"
DEST = Path.home() / ".claude" / "skills" / "random-picker"

# 这些是本地生成物，不要跟着复制过去
IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", "preload.js")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    parser = argparse.ArgumentParser(description="安装 random-picker 技能到 Claude Code。")
    parser.add_argument("--force", action="store_true", help="目标已存在时先删除再复制")
    parser.add_argument("--dest", metavar="目录", help="自定义安装位置（默认 ~/.claude/skills/random-picker）")
    args = parser.parse_args()

    if not (SRC / "SKILL.md").exists():
        print("找不到技能源目录：%s" % SRC, file=sys.stderr)
        return 1

    dest = Path(args.dest).expanduser() if args.dest else DEST

    if dest.exists():
        if not args.force:
            print("目标已存在：%s" % dest, file=sys.stderr)
            print("加 --force 覆盖（会先删除旧目录）", file=sys.stderr)
            return 1
        shutil.rmtree(dest)

    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(SRC, dest, ignore=IGNORE)

    print("已安装到：%s" % dest)
    print()
    print("如果 ~/.claude/skills 是这次新建的，Claude Code 需要 /reload-skills（或重启）之后")
    print("才会加载它。之后你可以直接说「随机点个名」，或者用 /random-picker 调用。")
    print()
    print("注意：这里用的是复制而不是软链接，所以改完仓库里的源码要重新跑一次 install.py。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
