"""生成上架用的商店素材：300x300 logo、440x280 宣传图。

用法：python tools/make_store_assets.py
输出：store-assets/（已在 .gitignore 中忽略，需要时再生成）
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_icons import build  # 复用同一套图形

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "store-assets")
os.makedirs(OUT, exist_ok=True)

ICON = build(0.0, True)  # 1024 主图标


def font(names, size):
    for n in names:
        try:
            return ImageFont.truetype(n, size)
        except Exception:
            continue
    return ImageFont.load_default()


F_BOLD = font([r"C:\Windows\Fonts\msyhbd.ttc", "/System/Library/Fonts/PingFang.ttc",
               "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"], 30)
F_SUB = font([r"C:\Windows\Fonts\msyh.ttc", "/System/Library/Fonts/PingFang.ttc"], 15)
F_SMALL = font([r"C:\Windows\Fonts\msyh.ttc", "/System/Library/Fonts/PingFang.ttc"], 13)


def make_logo():
    logo = Image.new("RGBA", (300, 300), (0, 0, 0, 0))
    ic = ICON.resize((256, 256), Image.LANCZOS)
    logo.paste(ic, (22, 22), ic)
    logo.save(os.path.join(OUT, "store-logo-300.png"))


def make_promo():
    promo = Image.new("RGB", (440, 280), (0, 0, 0))
    d = ImageDraw.Draw(promo)

    # 很淡的径向光，避免死黑
    for r in range(260, 0, -6):
        a = int(14 * (1 - r / 260))
        d.ellipse([220 - r, 140 - r, 220 + r, 140 + r], fill=(10 + a, 22 + a, 34 + a))

    ic = ICON.resize((92, 92), Image.LANCZOS)
    promo.paste(ic, (34, 94), ic)

    d.text((146, 96), "X 媒体下载器", font=F_BOLD, fill=(231, 233, 234))
    d.text((147, 140), "视频 · 图片  一键最高清", font=F_SUB, fill=(113, 118, 123))
    d.text((147, 166), "原样保存，不二次转码", font=F_SMALL, fill=(83, 100, 113))
    d.line([(34, 214), (406, 214)], fill=(35, 38, 43), width=1)
    d.text((34, 226), "x.com 角标 · 右键菜单 · 批量下载", font=F_SMALL, fill=(83, 100, 113))

    promo.save(os.path.join(OUT, "promo-440x280.png"))


if __name__ == "__main__":
    make_logo()
    make_promo()
    print("store-assets/store-logo-300.png")
    print("store-assets/promo-440x280.png")
