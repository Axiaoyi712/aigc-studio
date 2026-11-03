import json
import sys
import av
with av.open(sys.argv[1]) as source:
    result = {"duration": float(source.duration or 0)/av.time_base}
    if source.streams.video:
        stream = source.streams.video[0]
        result.update(width=stream.width, height=stream.height, fps=float(stream.average_rate or 0))
    if source.streams.audio:
        stream = source.streams.audio[0]
        next(source.decode(audio=0))
        result.update(audio=True, rate=stream.rate)
    print(json.dumps(result))
