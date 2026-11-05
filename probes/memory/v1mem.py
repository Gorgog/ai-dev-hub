"""Records of a v1 `errors.md`: a record is a top-level bullet (`- ` at column 0) with its indented continuation
lines; headings, comments and blank lines are not records."""
import hashlib


def records(text):
    """[{'line': first line number (1-based), 'text': the record joined to one line, 'sha': sha256[:12]}]"""
    out, cur = [], None
    in_comment = False
    for no, raw in enumerate(text.splitlines(), 1):
        line = raw.rstrip('\r')
        if in_comment or line.lstrip().startswith('<!--'):
            in_comment = '-->' not in line
            cur = None
            continue
        if line.startswith('- '):
            cur = {'line': no, 'parts': [line[2:].strip()]}
            out.append(cur)
        elif cur is not None and line.strip() and line[:1] in (' ', '\t'):
            cur['parts'].append(line.strip())
        else:
            cur = None
    for r in out:
        r['text'] = ' '.join(r.pop('parts'))
        r['sha'] = hashlib.sha256(r['text'].encode()).hexdigest()[:12]
    return out
