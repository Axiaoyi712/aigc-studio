import importlib.util
from fractions import Fraction
from pathlib import Path
import tempfile
import unittest
import av
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT/file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result
driver = module('driver_video', 'driver-video.py')
upscale = module('upscale_video', 'upscale-video.py')


class DriverVideoTests(unittest.TestCase):
    def test_720p_preserves_all_aspects_and_does_not_reduce_existing_resolution(self):
        for w, h, expected in [(384,512,(720,960)),(512,384,(960,720)),(320,320,(720,720)),(1280,720,(1280,720)),(2048,1536,(2048,1536))]:
            self.assertEqual(upscale.delivery_size(w,h,720), expected)

    def test_timestamp_sampling_trims_range_and_pads_only_model_tail(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'source.mp4'
            with av.open(str(source),'w') as media:
                v=media.add_stream('libx264',rate=30)
                v.width,v.height,v.pix_fmt=72,96,'yuv420p'
                for i in range(90):
                    f=av.VideoFrame.from_image(Image.new('RGB',(72,96),(i*2,0,0)))
                    f.pts,f.time_base=i,Fraction(1,30)
                    for p in v.encode(f):media.mux(p)
                for p in v.encode(None):media.mux(p)
            before=source.read_bytes()
            result=driver.prepare(source,root/'clip.mp4',root/'first.png',1,2.2)
            self.assertEqual(result['effectiveFrames'],29)
            self.assertEqual((result['frames']-5)%17,0)
            self.assertEqual((result['width'],result['height']),(384,512))
            with av.open(str(root/'clip.mp4')) as media:
                frames=list(media.decode(video=0))
                self.assertEqual(len(frames),result['frames'])
                self.assertEqual(float(media.streams.video[0].average_rate),24)
                # First selected source is near1sec (frame30, red60), not the original frame0.
                red=frames[0].to_image().getpixel((180,250))[0]
                self.assertTrue(52<=red<=66,red)
                self.assertAlmostEqual(frames[-1].time-frames[0].time,(len(frames)-1)/24)
            self.assertEqual(source.read_bytes(),before)
            with self.assertRaises(ValueError):driver.prepare(source,root/'bad.mp4',root/'bad.png',2,1)


if __name__=='__main__':unittest.main()
