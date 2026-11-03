import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile


def pack(manifest_path, output):
    data = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for item in data["files"]:
            source = Path(item.pop("path"))
            digest = hashlib.sha256()
            with source.open("rb") as handle:
                for block in iter(lambda: handle.read(1024*1024), b""):
                    digest.update(block)
            item["sha256"] = digest.hexdigest()
            archive.write(source, item["archive"])
        archive.writestr("project.json", json.dumps(data, ensure_ascii=False), compress_type=zipfile.ZIP_DEFLATED)
    print(json.dumps({"bytes":Path(output).stat().st_size,"files":len(data["files"])}))


def unpack(source, destination):
    target = Path(destination).resolve()
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries)>10000 or sum(e.file_size for e in entries)>2*1024**3:
            raise ValueError("Archive exceeds import limits")
        for entry in entries:
            name = PurePosixPath(entry.filename)
            mode = entry.external_attr >> 16
            if name.is_absolute() or ".." in name.parts or "\\" in entry.filename or ":" in entry.filename or stat.S_ISLNK(mode):
                raise ValueError("Unsafe archive entry")
        if archive.getinfo("project.json").file_size>10*1024**2:
            raise ValueError("Project manifest is too large")
        data = json.loads(archive.read("project.json"))
        if data.get("schemaVersion")!=1 or not isinstance(data.get("files"),list):
            raise ValueError("Unsupported project archive")
        names = set()
        for item in data["files"]:
            name = PurePosixPath(item["archive"])
            if name.is_absolute() or ".." in name.parts or not str(name).startswith("media/") or "\\" in str(name) or ":" in str(name) or str(name) in names:
                raise ValueError("Unsafe media path")
            names.add(str(name))
            output = target.joinpath(*name.parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            with archive.open(str(name)) as incoming, output.open("xb") as handle:
                for block in iter(lambda: incoming.read(1024*1024), b""):
                    digest.update(block)
                    handle.write(block)
            if digest.hexdigest()!=item["sha256"]:
                raise ValueError("Media checksum mismatch")
        target.joinpath("project.json").write_text(json.dumps(data,ensure_ascii=False),encoding="utf-8")
    print(json.dumps({"files":len(data["files"])}))


if __name__=="__main__":
    {"pack":pack,"unpack":unpack}[sys.argv[1]](sys.argv[2],sys.argv[3])
