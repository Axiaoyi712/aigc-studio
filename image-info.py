"""Validate one still image without changing its bytes."""
import json
import os
import sys
import warnings
from PIL import Image

Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)

try:
    path = sys.argv[1]
    if not 0 < os.path.getsize(path) <= 20 * 1024 * 1024:
        raise ValueError("图片大小必须在 0～20MB 内。")
    extensions = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".webp": "WEBP"}
    expected = extensions.get(os.path.splitext(path)[1].lower())
    if expected is None:
        raise ValueError("只支持 PNG、JPEG、WebP 图片。")
    with Image.open(path) as image:
        width, height = image.size
        if image.format != expected:
            raise ValueError("图片格式与扩展名不一致。")
        if width * height > 40_000_000 or width < 1 or height < 1:
            raise ValueError("图片不能超过 4000 万像素。")
        if getattr(image, "n_frames", 1) != 1:
            raise ValueError("首帧需要静态图片，请使用单张 PNG、JPEG 或 WebP。")
        image.verify()
    with Image.open(path) as image:
        image.load()
    print(json.dumps({"width": width, "height": height, "format": expected}))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
