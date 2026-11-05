"""Read a local depth-video segment without copying or saving source media."""
import math
from pathlib import Path

import av
import numpy as np
from PIL import Image, ImageOps
import torch
from comfy_api.latest import ComfyExtension, io


class AIGCDepthVideo(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="AIGCDepthVideo",
            display_name="白膜视频 · 读取本地片段",
            category="AIGC/白膜视频",
            description="读取任意本地文件夹的深度视频，按实际时间采样为24fps；不复制原片，不落盘缓存。",
            inputs=[
                io.String.Input("video_path", default="", display_name="白膜视频完整路径"),
                io.Float.Input("start_seconds", default=0, min=0, max=1e5, step=0.01, display_name="开始秒数"),
                io.Float.Input("duration_seconds", default=2.8, min=0.1, max=5.17, step=0.01, display_name="片段时长（秒）"),
                io.Int.Input("short_edge", default=768, min=64, max=2048, step=32, display_name="生成短边", tooltip="默认768，原生达到720p；8GB显存建议先做约3秒。"),
            ],
            outputs=[
                io.Image.Output(display_name="24fps深度帧"),
                io.Int.Output(display_name="生成宽度"),
                io.Int.Output(display_name="生成高度"),
                io.Int.Output(display_name="模型帧数"),
                io.Int.Output(display_name="实际帧数"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, video_path, **kwargs):
        path = Path(video_path.strip().strip('"'))
        info = path.stat()
        return (str(path.resolve()), info.st_size, info.st_mtime_ns)

    @classmethod
    def execute(cls, video_path, start_seconds, duration_seconds, short_edge):
        path = Path(video_path.strip().strip('"'))
        if not path.is_absolute() or not path.is_file() or path.suffix.lower() not in {".mp4", ".mov", ".mkv", ".webm", ".avi"}:
            raise ValueError("请粘贴本机白膜视频的完整文件路径，支持MP4、MOV、MKV、WEBM、AVI。")
        if not math.isfinite(start_seconds) or not math.isfinite(duration_seconds) or start_seconds < 0 or duration_seconds <= 0:
            raise ValueError("开始秒数应不小于0，片段时长应大于0。")
        frames = []
        with av.open(str(path)) as source:
            if not source.streams.video:
                raise ValueError("文件没有视频轨道。")
            stream = source.streams.video[0]
            duration = float(stream.duration * stream.time_base) if stream.duration else (source.duration or 0) / av.time_base
            if start_seconds + duration_seconds > duration + .001:
                raise ValueError(f"片段超出原视频，请调整开始秒数或时长；原片约{duration:.2f}秒。")
            width = max(32, round(stream.width * short_edge / min(stream.width, stream.height) / 32) * 32)
            height = max(32, round(stream.height * short_edge / min(stream.width, stream.height) / 32) * 32)
            cw = max(32, round(stream.width * 512 / max(stream.width, stream.height) / 32) * 32)
            ch = max(32, round(stream.height * 512 / max(stream.width, stream.height) / 32) * 32)
            effective = max(1, math.ceil(duration_seconds * 24 - 1e-7))
            count = max(39, 5 + math.ceil(max(0, effective - 5) / 17) * 17)
            origin = float(stream.start_time * stream.time_base) if stream.start_time is not None else 0
            if start_seconds:
                source.seek(int((origin + start_seconds) * av.time_base), backward=True)
            previous = None
            for frame in source.decode(stream):
                if frame.time is None:
                    raise ValueError("视频缺少帧时间戳，请先重新封装视频。")
                seconds = float(frame.time) - origin
                while previous is not None and len(frames) < effective and start_seconds + len(frames) / 24 < seconds:
                    frames.append(previous)
                if len(frames) >= effective:
                    break
                image = ImageOps.pad(frame.to_image().convert("RGB"), (cw, ch), Image.Resampling.LANCZOS)
                previous = np.asarray(image, dtype=np.float32) / 255
            if previous is None:
                raise ValueError("所选片段没有可解码的视频帧。")
            frames.extend([previous] * (count - len(frames)))
        return io.NodeOutput(torch.from_numpy(np.stack(frames)), width, height, count, effective)


class DepthWorkflowExtension(ComfyExtension):
    async def get_node_list(self):
        return [AIGCDepthVideo]


async def comfy_entrypoint():
    return DepthWorkflowExtension()
