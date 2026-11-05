"""Records of a v1 memory file — the units the migration addresses one by one.

Two layouts:
- list files (errors.md, errors-index.md, recipes.md): a record is a top-level bullet (`- ` at column 0) with its
  indented continuation lines, joined to one line by spaces; any other text line (a paragraph, a lazy continuation) is
  a record of its own, so no text is lost silently;
- section files (decisions.md): a record is a `## ` section up to the next `## ` or `# ` heading, its lines as written
  (`### ` stays inside); text before the first section — paragraphs as above.
Headings (`# …`) and HTML comments are not records. A record's ref is `<file>#<sha>`: sha256 of its text, 12 hex (the
P6 probe's sha for bullets); an identical text met again in the same file gets `.2`, `.3`…
"""
import hashlib

SECTION_FILES = {'decisions.md'}


def _sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:12]


def records(text, name):
    """[{'ref', 'file', 'line', 'unit': bullet|para|section, 'head': nearest heading above, 'text'}]"""
    sections = name in SECTION_FILES
    out, cur = [], None
    in_comment = False
    head = ''

    def start(no, unit, first):
        nonlocal cur
        cur = {'file': name, 'line': no, 'unit': unit, 'head': head, 'lines': [first]}
        out.append(cur)

    for no, raw in enumerate(text.split('\n'), 1):
        line = raw.rstrip('\r')
        in_section = cur is not None and cur['unit'] == 'section'
        if in_comment or (line.lstrip().startswith('<!--') and not in_section):
            in_comment = '-->' not in line
            cur = None
            continue
        if sections and line.startswith('## '):
            head = line[3:].strip()
            start(no, 'section', line.rstrip())
            continue
        if in_section and not line.startswith('# '):
            cur['lines'].append(line.rstrip())
            continue
        if line.startswith('#'):
            head = line.lstrip('#').strip()
            cur = None
            continue
        if not line.strip():
            cur = None
        elif line.startswith('- '):
            start(no, 'bullet', line[2:].strip())
        elif cur is not None and line[:1] in (' ', '\t'):
            cur['lines'].append(line.strip())
        elif cur is not None and cur['unit'] == 'para':
            cur['lines'].append(line.strip())
        else:
            start(no, 'para', line.strip())
    seen = {}
    for r in out:
        lines = r.pop('lines')
        if r['unit'] == 'section':
            while lines and not lines[-1].strip():
                lines.pop()
            r['text'] = '\n'.join(lines)
        else:
            r['text'] = ' '.join(lines)
        sha = _sha(r['text'])
        seen[sha] = seen.get(sha, 0) + 1
        r['ref'] = f'{name}#{sha}' + (f'.{seen[sha]}' if seen[sha] > 1 else '')
    return out
