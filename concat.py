"""Render selected frame ranges to a fixed canvas, with independent audio gains."""
import json
import sys
from fractions import Fraction
import av
import numpy as np
from PIL import Image, ImageOps


def audio_samples(path):
    chunks = []
    with av.open(path) as source:
        if not source.streams.audio:
            return np.zeros((2, 0), dtype=np.float32)
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=48000)
        for frame in source.decode(audio=0):
            chunks.extend(item.to_ndarray() for item in resampler.resample(frame))
        chunks.extend(item.to_ndarray() for item in resampler.resample(None))
    return np.concatenate(chunks, axis=1) if chunks else np.zeros((2, 0), dtype=np.float32)


def concatenate(manifest_path, output_path):
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    legacy = isinstance(manifest, list)
    clips = [{"path": p} for p in manifest] if legacy else manifest["clips"]
    with av.open(clips[0]["path"]) as first:
        original = first.streams.video[0]
        canvas = {} if legacy else manifest.get("canvas", {})
        width, height = canvas.get("width", original.width), canvas.get("height", original.height)
    background = None if legacy else manifest.get("background")
    bed = audio_samples(background["path"]) if background else np.zeros((2, 0), dtype=np.float32)
    video_count, audio_count = 0, 0
    with av.open(output_path, mode="w", options={"movflags": "+faststart"}) as output:
        video = output.add_stream("libx264", rate=24)
        video.width, video.height, video.pix_fmt = width, height, "yuv420p"
        video.options = {"crf": "20", "preset": "fast"}
        audio = output.add_stream("aac", rate=48000)
        audio.layout, audio.bit_rate = "stereo", 192000
        for clip_index, clip in enumerate(clips):
            start, end = clip.get("inFrame", 0), clip.get("outFrame")
            clip_frames = 0
            with av.open(clip["path"]) as source:
                if source.streams.video[0].average_rate != 24:
                    raise ValueError("Only verified 24 fps studio clips are accepted.")
                for index, frame in enumerate(source.decode(video=0)):
                    if index < start:
                        continue
                    if end is not None and index >= end:
                        break
                    if (frame.width, frame.height) != (width, height):
                        image = ImageOps.contain(frame.to_image(), (width, height), Image.Resampling.LANCZOS)
                        canvas_image = Image.new("RGB", (width, height), "black")
                        canvas_image.paste(image, ((width-image.width)//2, (height-image.height)//2))
                        frame = av.VideoFrame.from_image(canvas_image)
                    frame = frame.reformat(width=width, height=height, format="yuv420p")
                    frame.pts, frame.time_base = video_count, Fraction(1, 24)
                    video_count += 1
                    clip_frames += 1
                    for packet in video.encode(frame):
                        output.mux(packet)
            if not clip_frames:
                raise ValueError("The selected frame range is empty.")
            target = clip_frames * 2000
            samples = np.zeros((2, target), dtype=np.float32)
            if not clip.get("mute", False):
                original_audio = audio_samples(clip["path"])
                selected = original_audio[:, start*2000:start*2000+target]
                samples[:, :selected.shape[1]] = selected * clip.get("gain", 1)
            fade = min(int(clip.get("fade", 0)*48000), target//2)
            if fade:
                samples[:, :fade] *= np.linspace(0, 1, fade)
                samples[:, -fade:] *= np.linspace(1, 0, fade)
            if bed.shape[1]:
                indices = np.arange(audio_count, audio_count+target) % bed.shape[1]
                samples += bed[:, indices] * background.get("gain", 0.2)
            samples = np.clip(samples, -1, 1)
            for offset in range(0, target, 48000):
                piece = np.ascontiguousarray(samples[:, offset:offset+48000])
                frame = av.AudioFrame.from_ndarray(piece, format="fltp", layout="stereo")
                frame.sample_rate, frame.time_base, frame.pts = 48000, Fraction(1,48000), audio_count
                audio_count += frame.samples
                for packet in audio.encode(frame):
                    output.mux(packet)
            print(json.dumps({"completed":clip_index+1,"total":len(clips)}), flush=True)
        for stream in (video, audio):
            for packet in stream.encode(None):
                output.mux(packet)
    print(json.dumps({"frames":video_count,"duration":video_count/24,"width":width,"height":height,"audioSamples":audio_count}), flush=True)


if __name__ == "__main__":
    concatenate(sys.argv[1], sys.argv[2])
