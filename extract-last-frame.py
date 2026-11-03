"""Decode the last displayed video frame and save a lossless RGB PNG."""
import json
import sys
from pathlib import Path
import av

source, destination = map(Path, sys.argv[1:3])
with av.open(str(source)) as container:
    last = None
    count = 0
    for frame in container.decode(video=0):
        last = frame
        count += 1
    if last is None:
        raise ValueError('The video contains no decodable frames.')
    image = last.to_image().convert('RGB')
destination.parent.mkdir(parents=True, exist_ok=True)
temporary = destination.with_suffix('.tmp.png')
image.save(str(temporary), format='PNG')
temporary.replace(destination)
print(json.dumps({'width': image.width, 'height': image.height, 'sourceFrames': count, 'sourceFrameIndex': count - 1}))
