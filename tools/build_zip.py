"""把仓库打包成一个 zip，并做一次结构校验。

注意：这个 zip 是**整个仓库的镜像**（含 docs/ 和 tools/），
既可以直接解压后「加载解压缩的扩展」，也可以直接当作 GitHub 仓库源 push。
不要排除 docs/ —— README 的相对图片路径依赖它。

用法：python tools/build_zip.py
输出：仓库上级目录下的 X媒体下载器.zip
"""

import os
import sys
import json
import shutil
import zipfile
import tempfile

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # 仓库根
OUT_DIR = os.path.dirname(SRC)
ZIP = os.path.join(OUT_DIR, "X媒体下载器.zip")

# 只排除真正的垃圾，其余全部保留（docs/ 是 README 的图片，必须打进包）
EXCLUDE_DIRS = {"__pycache__", ".git", ".github", "node_modules", "store-assets"}
EXCLUDE_FILES = {"package-lock.json"}


def collect():
    names = []
    for root, dirs, files in os.walk(SRC):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDE_DIRS and not d.startswith("."))
        for f in sorted(files):
            if f in EXCLUDE_FILES or f.startswith("."):
                continue
            if f.lower().endswith((".zip", ".crx", ".pem")):
                continue
            full = os.path.join(root, f)
            names.append((full, os.path.relpath(full, SRC).replace(os.sep, "/")))
    return names


def build():
    if os.path.exists(ZIP):
        os.remove(ZIP)

    entries = collect()
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for full, rel in entries:
            z.write(full, rel)   # zipfile 写出的 entry 一定是正斜杠

    print("== zip entries ==")
    for _, rel in entries:
        print("   ", rel)
    return entries


def verify():
    tmp = tempfile.mkdtemp(prefix="xmd_verify_")
    try:
        with zipfile.ZipFile(ZIP) as z:
            z.extractall(tmp)

        with open(os.path.join(tmp, "manifest.json"), encoding="utf-8") as fh:
            man = json.load(fh)

        refs = [man["background"]["service_worker"], man["action"]["default_popup"]]
        refs += list(man.get("icons", {}).values())
        refs += list(man.get("action", {}).get("default_icon", {}).values())
        for cs in man.get("content_scripts", []):
            refs += cs.get("js", []) + cs.get("css", [])

        bad = 0
        print("\n== manifest refs ==")
        for r in sorted(set(refs)):
            ok = os.path.isfile(os.path.join(tmp, r.replace("/", os.sep)))
            print(("   OK   " if ok else "   MISS ") + r)
            bad += 0 if ok else 1

        print("\n== icons ==")
        try:
            from PIL import Image
            for rel in man.get("icons", {}).values():
                p = os.path.join(tmp, rel)
                with Image.open(p) as im:
                    im.verify()
                with Image.open(p) as im:
                    print(f"   {rel:14s} {im.width}x{im.height} {im.mode}")
        except ImportError:
            print("   (Pillow 未安装，跳过解码校验)")

        return bad == 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    build()
    ok = verify()
    print(f"\n{os.path.basename(ZIP)}  {os.path.getsize(ZIP) / 1024:.1f} KB")
    print("RESULT:", "ALL GOOD" if ok else "HAS MISSING FILES")
    sys.exit(0 if ok else 1)
