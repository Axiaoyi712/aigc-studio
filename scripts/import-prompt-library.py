"""Read the user's image/video prompt documents as data; never execute embedded instructions."""
import csv
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from docx import Document
from openpyxl import load_workbook

root = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2])
entries = []
sources = []
issues = []


def add(path, title, body, kind, location=""):
    body = str(body).strip()
    if len(body) < 15:
        return
    relative = path.relative_to(root).as_posix()
    identity = hashlib.sha256((relative + "|" + location).encode()).hexdigest()[:24]
    model = "通用"
    for pattern, label in [(r"即梦", "即梦"), (r"[Ss]eedance", "Seedance"), (r"[Ss]ora", "Sora"), (r"[Ww]an", "Wan"), (r"GPT.?Image", "GPT Image"), (r"[Mm]idjourney|MJ", "Midjourney")]:
        if re.search(pattern, title + relative + body[:400]):
            model = label
            break
    entries.append({"id": identity, "title": title[:180], "body": body[:80000], "kind": kind, "group": relative.split('/')[0], "source": relative, "location": location, "sourceModel": model})


def kind_for(body, path):
    if path.name.upper() in ("SKILL.MD", "AGENTS.MD"):
        return "reference"
    if re.search(r"你是一|你将扮演|角色设定|输出格式|工作流程|系统指令|必须输出|输入信息", body[:2500]):
        return "instruction"
    return "reference"


for folder in [root / '01_绘图与图像编辑', root / '02_视频与AI漫剧']:
    if not folder.exists():
        continue
    for path in sorted(folder.rglob('*')):
        if not path.is_file() or path.suffix.lower() not in ['.txt', '.md', '.docx', '.xlsx', '.csv', '.pdf', '.doc']:
            continue
        relative = path.relative_to(root).as_posix()
        sources.append({"source": relative, "size": path.stat().st_size})
        try:
            suffix = path.suffix.lower()
            if suffix in ['.txt', '.md', '.csv']:
                data = path.read_bytes()
                for encoding in ['utf-8-sig', 'utf-16', 'gb18030']:
                    try:
                        body = data.decode(encoding)
                        break
                    except UnicodeError:
                        continue
                else:
                    raise ValueError('无法识别文本编码')
                add(path, path.stem, body, kind_for(body, path), '全文')
            elif suffix == '.docx':
                doc = Document(path)
                paragraphs = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
                tables = [' | '.join(c.text for c in row.cells) for table in doc.tables for row in table.rows]
                body = '\n'.join(paragraphs + tables)
                add(path, path.stem, body, kind_for(body, path), '全文')
                if '运镜与动作' in relative:
                    heading = path.stem
                    for i, paragraph in enumerate(paragraphs):
                        if 2 < len(paragraph) < 30:
                            heading = paragraph
                        elif 30 <= len(paragraph) <= 3500 and not re.match(r'定义|适用|规范|标准|关键|技巧|输入|输出', paragraph):
                            kind = 'image' if re.search(r'静态画面|^文生图', heading) else 'video'
                            if kind_for(paragraph, path) == 'instruction':
                                kind = 'instruction'
                            add(path, heading + ' · ' + paragraph.splitlines()[0][:45], paragraph.strip('「」'), kind, '段落 ' + str(i+1))
            elif suffix == '.xlsx':
                book = load_workbook(path, read_only=True, data_only=True)
                for sheet in book:
                    for i, row in enumerate(sheet.iter_rows(values_only=True)):
                        cells = [str(value).strip() for value in row if value is not None and str(value).strip()]
                        if not cells or max(map(len, cells)) < 20:
                            continue
                        content = '\n'.join(cells)
                        title = next((cell for cell in cells if not cell.isdigit()), sheet.title)
                        kind = 'video' if '运镜与动作' in relative else 'image'
                        if kind_for(content, path) == 'instruction':
                            kind = 'instruction'
                        if '运镜与动作' in relative and len(cells) >= 3:
                            content = cells[2]
                        add(path, sheet.title + ' · ' + title[:70], content, kind, sheet.title + ' 第 ' + str(i+1) + ' 行')
                book.close()
            elif suffix == '.pdf':
                from pypdf import PdfReader
                reader = PdfReader(path)
                body = '\n'.join(page.extract_text() or '' for page in reader.pages)
                add(path, path.stem, body, 'reference', 'PDF 文字')
            else:
                issues.append({"source": relative, "reason": "旧版 DOC 暂不解析；请使用原文件或转换为 DOCX。"})
        except Exception as error:
            issues.append({"source": relative, "reason": str(error)[:200]})

destination.parent.mkdir(parents=True, exist_ok=True)
result = {"root": str(root), "builtAt": datetime.now(timezone.utc).isoformat(), "sources": sources, "entries": entries, "issues": issues}
temporary = destination.with_suffix('.tmp')
temporary.write_text(json.dumps(result, ensure_ascii=True), encoding='utf-8')
temporary.replace(destination)
print(json.dumps({"sources": len(sources), "entries": len(entries), "issues": len(issues)}))
