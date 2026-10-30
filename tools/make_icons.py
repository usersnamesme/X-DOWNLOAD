"""生成扩展图标：黑色底 + 白色下载箭头。

按尺寸做光学校正 —— 16/32 用更粗的笔画和更大的图形，48/128 用克制的细版。
小尺寸直接用大图缩放会发灰，这是本项目图标迭代最花时间的地方。

用法：python tools/make_icons.py
"""

import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024
WHITE = (255, 255, 255)


def vgrad(size, top, bottom):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (size, y)], fill=c)
    return img


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def build(bold=0.0, deco=True):
    """bold: 0 = 克制（大尺寸用），1 = 加粗放大（小尺寸用）"""
    radius = int(S * (0.19 + 0.02 * bold))
    bg = vgrad(S, (24 + 8 * bold, 25 + 8 * bold, 28 + 8 * bold), (8, 8, 10)).convert("RGBA")
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    mask = rounded_mask(S, radius)
    icon.paste(bg, (0, 0), mask)

    if deco:
        glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(glow).ellipse(
            [-S * 0.45, -S * 0.75, S * 1.45, S * 0.25], fill=(255, 255, 255, 13)
        )
        icon = Image.alpha_composite(
            icon, Image.composite(glow, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask)
        )

    u = S / 1024.0
    sw = (88 + 62 * bold) * u             # 杆宽
    head_hw = (356 + 60 * bold) * u       # 三角总宽
    span = (594 + 150 * bold) * u         # 图形总高
    bar_h = (54 + 46 * bold) * u
    gap = (48 + 10 * bold) * u

    top = (S - span) / 2 + 6 * u
    bar_top = top + span - bar_h
    apex = bar_top - gap
    head_h = head_hw * 0.85               # 三角高宽比固定，箭头更修长
    mid = apex - head_h

    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = S / 2
    d.rounded_rectangle([cx - sw / 2, top, cx + sw / 2, mid], radius=sw / 2, fill=WHITE)
    d.polygon([(cx - head_hw / 2, mid), (cx + head_hw / 2, mid), (cx, apex)], fill=WHITE)
    bar_w = (392 + 60 * bold) * u
    d.rounded_rectangle(
        [cx - bar_w / 2, bar_top, cx + bar_w / 2, bar_top + bar_h],
        radius=bar_h / 2, fill=WHITE
    )
    icon = Image.alpha_composite(icon, layer)

    if deco:
        bd = ImageDraw.Draw(icon)
        bd.rounded_rectangle(
            [3, 3, S - 4, S - 4], radius=radius - 3,
            outline=(255, 255, 255, 34), width=max(2, int(S * 0.005))
        )
    return icon


# 每个尺寸单独调：小尺寸加粗、去装饰
PROFILE = {
    16: (1.0, False),
    32: (0.55, False),
    48: (0.2, True),
    128: (0.0, True),
}


if __name__ == "__main__":
    final = {}
    for size, (bold, deco) in PROFILE.items():
        im = build(bold, deco).resize((size, size), Image.LANCZOS)
        im.save(os.path.join(ROOT, f"icon{size}.png"), "PNG", optimize=True)
        final[size] = im
        print(f"icon{size}.png  {size}x{size}")

    # 尺寸对比图（放大到相近高度），方便肉眼检查小尺寸是否糊
    sheet = Image.new("RGB", (16 * 12 + 32 * 8 + 48 * 5 + 128 * 3 + 160, 420), (243, 244, 246))
    x = 30
    for size, scale in ((16, 12), (32, 8), (48, 5), (128, 3)):
        z = final[size].convert("RGBA").resize((size * scale, size * scale), Image.NEAREST)
        sheet.paste(z, (x, 140), z)
        x += size * scale + 40
    os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)
    sheet.save(os.path.join(ROOT, "docs", "icon-sizes.png"))
    print("docs/icon-sizes.png")
