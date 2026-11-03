import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
import av
import numpy as np
from fractions import Fraction

ROOT=Path(__file__).resolve().parents[1]


def generate(path):
    with av.open(str(path), "w") as target:
        video=target.add_stream("libx264",rate=24)
        video.width,video.height,video.pix_fmt=160,96,"yuv420p"
        audio=target.add_stream("aac",rate=48000)
        audio.layout="stereo"
        for i in range(48):
            pixels=np.zeros((96,160,3),dtype=np.uint8)
            pixels[:,:,0]=i*4
            frame=av.VideoFrame.from_ndarray(pixels,format="rgb24")
            frame.pts,frame.time_base=i,Fraction(1,24)
            for packet in video.encode(frame): target.mux(packet)
            t=(np.arange(2000)+i*2000)/48000
            sound=np.tile((np.sin(2*math.pi*440*t)*0.2).astype(np.float32),(2,1))
            frame=av.AudioFrame.from_ndarray(sound,format="fltp",layout="stereo")
            frame.sample_rate,frame.pts,frame.time_base=48000,i*2000,Fraction(1,48000)
            for packet in audio.encode(frame): target.mux(packet)
        for stream in (video,audio):
            for packet in stream.encode(None): target.mux(packet)


class MediaAcceptance(unittest.TestCase):
    def test_selected_frames_fixed_canvas_and_muted_audio(self):
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder);source=folder/"source.mp4";generate(source)
            manifest=folder/"manifest.json"
            manifest.write_text(json.dumps({"canvas":{"width":320,"height":320},"clips":[{"path":str(source),"inFrame":12,"outFrame":36,"mute":True}]}))
            result=subprocess.run([sys.executable,str(ROOT/"concat.py"),str(manifest),str(folder/"output.mp4")],capture_output=True,text=True,check=True)
            report=json.loads(result.stdout.strip().splitlines()[-1]);self.assertEqual(report["frames"],24);self.assertEqual(report["audioSamples"],48000)
            with av.open(str(folder/"output.mp4")) as output:
                frames=list(output.decode(video=0));self.assertEqual(len(frames),24);self.assertEqual((frames[0].width,frames[0].height),(320,320))
                pixels=frames[0].to_ndarray(format="rgb24");self.assertLess(float(pixels[0].mean()),3);self.assertAlmostEqual(float(pixels[160,:,0].mean()),48,delta=6)
            with av.open(str(folder/"output.mp4")) as output:
                sound=np.concatenate([f.to_ndarray() for f in output.decode(audio=0)],axis=1);self.assertLess(float(np.abs(sound).max()),0.001)

    def test_background_audio_mixes_over_muted_clip_and_preserves_duration(self):
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder);source=folder/"source.mp4";generate(source)
            manifest=folder/"manifest.json";manifest.write_text(json.dumps({"canvas":{"width":160,"height":96},"clips":[{"path":str(source),"inFrame":0,"outFrame":24,"mute":True},{"path":str(source),"inFrame":24,"outFrame":48,"gain":0.5,"fade":0.1}],"background":{"path":str(source),"gain":0.2}}))
            result=subprocess.run([sys.executable,str(ROOT/"concat.py"),str(manifest),str(folder/"output.mp4")],capture_output=True,text=True,check=True)
            report=json.loads(result.stdout.strip().splitlines()[-1]);self.assertEqual(report["frames"],48);self.assertEqual(report["audioSamples"],96000)
            with av.open(str(folder/"output.mp4")) as output:
                sound=np.concatenate([f.to_ndarray() for f in output.decode(audio=0)],axis=1);self.assertGreater(float(np.sqrt(np.mean(sound[:,:48000]**2))),0.01);self.assertGreater(float(np.sqrt(np.mean(sound[:,50000:90000]**2))),0.05)

    def test_archive_roundtrip_and_corruption_rejection(self):
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder);media=folder/"test.png";media.write_bytes(b"owned media")
            manifest=folder/"manifest.json";manifest.write_text(json.dumps({"schemaVersion":1,"files":[{"path":str(media),"archive":"media/test.png"}]}))
            subprocess.run([sys.executable,str(ROOT/"archive-project.py"),"pack",str(manifest),str(folder/"archive.zip")],capture_output=True,check=True)
            subprocess.run([sys.executable,str(ROOT/"archive-project.py"),"unpack",str(folder/"archive.zip"),str(folder/"restored")],capture_output=True,check=True)
            self.assertEqual((folder/"restored/media/test.png").read_bytes(),media.read_bytes())
            with zipfile.ZipFile(folder/"archive.zip") as archive: data=json.loads(archive.read("project.json"))
            with zipfile.ZipFile(folder/"bad.zip","w") as archive:
                archive.writestr("project.json",json.dumps(data));archive.writestr("media/test.png",b"tampered")
            result=subprocess.run([sys.executable,str(ROOT/"archive-project.py"),"unpack",str(folder/"bad.zip"),str(folder/"bad")],capture_output=True)
            self.assertNotEqual(result.returncode,0)

    def test_archive_cannot_write_outside_import_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder)
            with zipfile.ZipFile(folder/"unsafe.zip","w") as archive: archive.writestr("../outside.txt","bad")
            result=subprocess.run([sys.executable,str(ROOT/"archive-project.py"),"unpack",str(folder/"unsafe.zip"),str(folder/"restored")],capture_output=True)
            self.assertNotEqual(result.returncode,0);self.assertFalse((folder/"outside.txt").exists())


if __name__=="__main__": unittest.main(verbosity=2)
