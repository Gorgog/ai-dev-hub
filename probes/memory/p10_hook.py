"""P10 PostToolUse hook: after every tool call, checks the scenario's file for the violation and logs the state;
in `lesson` mode the first violation also returns the lesson as additionalContext (once per session).
usage (from settings): python3 -I p10_hook.py <lesson|control> <scenario.json>"""
import json
import re
import sys
import time
from pathlib import Path

mode, cfg_file = sys.argv[1], sys.argv[2]
cfg = json.loads(Path(cfg_file).read_text())
d = json.load(sys.stdin)
target = Path(cfg['file'])  # absolute: the input's cwd follows a `cd` in Bash, and a miss would read as «fixed»
text = target.read_text() if target.exists() else ''
violation = bool(re.search(cfg['violation'], text))
log = Path(cfg['log'])
seen = log.exists() and any(json.loads(l).get('shown') for l in log.read_text().splitlines() if l.strip())
show = mode == 'lesson' and violation and not seen
with log.open('a') as f:
    f.write(json.dumps({'t': time.time(), 'tool': d.get('tool_name'), 'id': d.get('tool_use_id'),
                        'input': d.get('tool_input'), 'violation': violation, 'shown': show,
                        'agent': d.get('agent_id')}, ensure_ascii=False) + '\n')
if show:
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': cfg['lesson']}},
                     ensure_ascii=False))
