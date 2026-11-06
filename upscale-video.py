"""Stream video frames through a local upscale model, preserving timestamps and audio."""
import argparse
import json
import os
from pathlib import Path
import sys
import av
import numpy as np
from PIL import Image, ImageOps


def enhance_video(source_path, output_path, enhance, width=1920, height=1080, progress=None):
    output_path = Path(output_path)
    if Path(source_path).resolve() == output_path.resolve() or output_path.exists():
        raise ValueError('输出文件必须是新的独立文件。')
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(output_path.stem + '.partial.mp4')
    count = 0
    try:
        with av.open(str(source_path)) as source, av.open(str(temporary), 'w', options={'movflags': '+faststart'}) as target:
            video = source.streams.video[0]
            fps = video.average_rate
            if not fps or video.width > 4096 or video.height > 4096:
                raise ValueError('视频尺寸或帧率无效。')
            writer = target.add_stream('libx264', rate=fps)
            writer.width, writer.height, writer.pix_fmt = width, height, 'yuv420p'
            writer.options = {'crf': '18', 'preset': 'medium'}
            audio = source.streams.audio[0] if source.streams.audio else None
            audio_writer = target.add_stream_from_template(audio) if audio else None
            streams = [video] + ([audio] if audio else [])
            for packet in source.demux(streams):
                if packet.stream == audio:
                    if packet.dts is not None:
                        packet.stream = audio_writer
                        target.mux(packet)
                    continue
                for frame in packet.decode():
                    image = enhance(frame.to_ndarray(format='rgb24'))
                    image = ImageOps.pad(image, (width, height), method=Image.Resampling.LANCZOS, color='black')
                    result = av.VideoFrame.from_image(image)
                    result.pts, result.time_base = frame.pts, frame.time_base
                    for encoded in writer.encode(result):
                        target.mux(encoded)
                    count += 1
                    if progress:
                        progress(count, video.frames)
            for packet in writer.encode(None):
                target.mux(packet)
            if not count:
                raise ValueError('没有可读取的视频帧。')
        os.replace(temporary, output_path)
        with av.open(str(output_path)) as result:
            stream = result.streams.video[0]
            return {'width': stream.width, 'height': stream.height, 'fps': float(stream.average_rate), 'frame_count': count, 'duration': float(result.duration or 0) / av.time_base, 'audio': bool(result.streams.audio)}
    finally:
        if temporary.exists():
            temporary.unlink()


def load_enhancer(comfy_root, model_path):
    sys.path.insert(0, str(comfy_root))
    import torch
    from spandrel import ModelLoader
    from comfy.utils import tiled_scale
    if not torch.cuda.is_available():
        raise RuntimeError('高清精修需要可用的 NVIDIA CUDA 环境。')
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    state = torch.load(model_path, map_location='cpu', weights_only=True)
    state = state.get('params_ema', state.get('params', state))
    model = ModelLoader().load_from_state_dict(state).eval().to('cuda')

    def enhance(pixels):
        image = torch.from_numpy(pixels.copy()).permute(2, 0, 1).unsqueeze(0).float().to('cuda') / 255
        with torch.inference_mode():
            result = tiled_scale(image, model, tile_x=256, tile_y=256, overlap=32, upscale_amount=model.scale, output_device='cpu')
        rgb = result[0].clamp(0, 1).permute(1, 2, 0).numpy()
        return Image.fromarray((rgb * 255).round().astype(np.uint8))
    return enhance


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('output')
    parser.add_argument('comfy_root')
    parser.add_argument('model')
    args = parser.parse_args()
    with av.open(args.source) as video:
        w, h = video.streams.video[0].width, video.streams.video[0].height
    width, height = (1080, 1920) if h > w else (1080, 1080) if h == w else (1920, 1080)
    enhance = load_enhancer(args.comfy_root, args.model)
    def progress(value, maximum):
        print(json.dumps({'progress': {'value': value, 'max': maximum}}), flush=True)
    metadata = enhance_video(args.source, args.output, enhance, width, height, progress)
    print(json.dumps({'metadata': metadata}), flush=True)


if __name__ == '__main__':
    main()
