"""Probe and time-resample a short depth driver without copying its full source."""
import argparse
from fractions import Fraction
import json
import math
import os
from pathlib import Path

import av
from PIL import ImageOps, Image


def probe(path):
    with av.open(str(path)) as media:
        if not media.streams.video:
            raise ValueError('文件没有可解码的视频轨道。')
        v = media.streams.video[0]
        duration = float(v.duration * v.time_base) if v.duration else (media.duration or 0) / av.time_base
        if not (0 < duration <= 1800 and 0 < v.width <= 8192 and 0 < v.height <= 8192):
            raise ValueError('驱动视频应不超过30分钟，宽高不超过8192。')
        next(media.decode(v))
        return dict(width=v.width, height=v.height, duration=duration, fps=float(v.average_rate or 0), audio=bool(media.streams.audio))


def prepare(path, output, preview, start, end):
    meta = probe(path)
    if not (0 <= start < end <= meta['duration'] + .001 and end - start <= 5.17):
        raise ValueError('请选择有效的0～5.17秒片段；长视频请拆成多个镜头。')
    # Preview generation remains modest on 8GB; the delivery pass is independently >=720p.
    ratio = meta['width'] / meta['height']
    if ratio >= 1:
        width, height = 512, max(64, round(512 / ratio / 32) * 32)
    else:
        height, width = 512, max(64, round(512 * ratio / 32) * 32)
    effective = max(1, math.ceil((end - start) * 24 - 1e-7))
    count = max(39, 5 + math.ceil(max(0, effective - 5) / 17) * 17)
    output, preview = Path(output), Path(preview)
    output.parent.mkdir(parents=True, exist_ok=True)
    preview.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix('.partial.mp4')
    written = 0
    previous = None
    first_pts = None
    try:
        with av.open(str(path)) as source, av.open(str(temporary), 'w') as target:
            v = source.streams.video[0]
            writer = target.add_stream('libx264', rate=24)
            writer.width, writer.height, writer.pix_fmt = width, height, 'yuv420p'
            writer.options = {'crf': '12', 'preset': 'fast'}

            def emit(image):
                nonlocal written
                if written == 0:
                    image.save(preview)
                result = av.VideoFrame.from_image(image)
                result.pts, result.time_base = written, Fraction(1, 24)
                for packet in writer.encode(result):
                    target.mux(packet)
                written += 1

            # Use actual timestamps (including variable frame rate), never relabel 30fps as24fps.
            for f in source.decode(v):
                t = float(f.time) if f.time is not None else None
                if t is None:
                    raise ValueError('视频帧缺少时间戳，请先重新封装视频。')
                if first_pts is None:
                    first_pts = t
                t -= first_pts
                image = ImageOps.pad(f.to_image().convert('RGB'), (width, height), Image.Resampling.LANCZOS)
                while previous is not None and written < effective and start + written / 24 < t:
                    emit(previous)
                previous = image
                if written >= effective:
                    break
            if previous is None:
                raise ValueError('片段没有可读取的帧。')
            while written < count:
                emit(previous)
            for packet in writer.encode(None):
                target.mux(packet)
        os.replace(temporary, output)
        return dict(width=width, height=height, frames=count, effectiveFrames=effective, fps=24, duration=effective/24, sourceWidth=meta['width'], sourceHeight=meta['height'])
    finally:
        if temporary.exists():
            temporary.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['probe', 'prepare'])
    parser.add_argument('source')
    parser.add_argument('extra', nargs='*')
    args = parser.parse_args()
    result = probe(args.source) if args.action == 'probe' else prepare(args.source, args.extra[0], args.extra[1], float(args.extra[2]), float(args.extra[3]))
    print(json.dumps(result, ensure_ascii=False))
