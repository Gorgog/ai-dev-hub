#!/usr/bin/env python3
"""Scripted stand-in for the Anthropic Messages API: lets a real `claude` (ANTHROPIC_BASE_URL) run tool calls
without a model, so platform probes are deterministic, free and touch no account.

A scenario is JSON: {"scripts": [{"match": "<substring of the latest prompt (user text, not tool results)>",
"steps": [step, ...]}, ...], "compact": "<summary text>", "fallback": "<text>"}. A step is
{"tool": "Bash", "input": {...}} or {"text": "..."}; optional "usage_input" sets the reported input tokens (high
values make Claude Code compact). The n-th assistant turn after that prompt gets steps[n]; past the end — "done".
Every request is appended to <log> as one JSON line (path, which script, step, the request body).

usage: mockapi.py <scenario.json> <log.jsonl> [--port N]   (prints the port on stdout when ready)
"""
import json
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()


def text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for b in content or []:
        if b.get('type') == 'text':
            out.append(b.get('text', ''))
        elif b.get('type') == 'tool_result':
            out.append(text_of(b.get('content')))
    return '\n'.join(out)


def is_compact_request(body):
    """Claude Code asks for the summary as the last user turn; tools are usually absent."""
    msgs = body.get('messages') or []
    last = text_of(msgs[-1].get('content')) if msgs else ''
    return 'summary' in last.lower() and ('conversation' in last.lower()) and not body.get('tools')


def own_text(m):
    c = m.get('content')
    return c if isinstance(c, str) else '\n'.join(b.get('text', '') for b in c or [] if b.get('type') == 'text')


def pick(scenario, body):
    """The script whose marker is in the latest user text (tool-result turns carry reminders, so search back)."""
    msgs = body.get('messages') or []
    if is_compact_request(body):
        return 'compact', None, {'text': scenario.get('compact', '<summary>Earlier work: probe steps ran.</summary>')}
    for at in range(len(msgs) - 1, -1, -1):
        if msgs[at].get('role') != 'user':
            continue
        t = own_text(msgs[at])
        for i, s in enumerate(scenario.get('scripts', [])):
            if s['match'] in t:
                n = sum(1 for m in msgs[at:] if m.get('role') == 'assistant')
                steps = s['steps']
                return f'script{i}', n, steps[n] if n < len(steps) else {'text': 'done'}
    return 'fallback', None, {'text': scenario.get('fallback', 'ok')}


def blocks_for(step):
    if 'tool' in step:
        return [{'type': 'tool_use', 'id': 'toolu_' + uuid.uuid4().hex[:24], 'name': step['tool'],
                 'input': step.get('input', {})}], 'tool_use'
    return [{'type': 'text', 'text': step.get('text', 'ok')}], 'end_turn'


def sse(handler, event, data):
    handler.wfile.write(f'event: {event}\ndata: {json.dumps(data)}\n\n'.encode())


class Handler(BaseHTTPRequestHandler):
    scenario = {}
    log = None
    counters = {}

    def log_message(self, *a):  # quiet
        pass

    def do_POST(self):
        n = int(self.headers.get('content-length') or 0)
        body = json.loads(self.rfile.read(n) or b'{}')
        path = self.path.split('?')[0]
        if path.endswith('/count_tokens'):
            return self.reply_json({'input_tokens': 1000})
        which, idx, step = pick(self.scenario, body)
        with LOCK:
            with open(self.log, 'a') as f:
                f.write(json.dumps({'path': path, 'which': which, 'step': idx, 'model': body.get('model'),
                                    'body': body}, ensure_ascii=False) + '\n')
        blocks, stop = blocks_for(step)
        usage = {'input_tokens': int(step.get('usage_input', 1000)), 'output_tokens': 20,
                 'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0}
        msg = {'id': 'msg_' + uuid.uuid4().hex[:24], 'type': 'message', 'role': 'assistant',
               'model': body.get('model', 'mock'), 'content': blocks, 'stop_reason': stop, 'stop_sequence': None,
               'usage': usage}
        if not body.get('stream'):
            return self.reply_json(msg)
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.send_header('cache-control', 'no-cache')
        self.end_headers()
        sse(self, 'message_start', {'type': 'message_start', 'message': {**msg, 'content': [], 'stop_reason': None}})
        for i, b in enumerate(blocks):
            if b['type'] == 'text':
                sse(self, 'content_block_start', {'type': 'content_block_start', 'index': i,
                                                  'content_block': {'type': 'text', 'text': ''}})
                sse(self, 'content_block_delta', {'type': 'content_block_delta', 'index': i,
                                                  'delta': {'type': 'text_delta', 'text': b['text']}})
            else:
                sse(self, 'content_block_start', {'type': 'content_block_start', 'index': i,
                                                  'content_block': {**b, 'input': {}}})
                sse(self, 'content_block_delta', {'type': 'content_block_delta', 'index': i,
                                                  'delta': {'type': 'input_json_delta',
                                                            'partial_json': json.dumps(b['input'])}})
            sse(self, 'content_block_stop', {'type': 'content_block_stop', 'index': i})
        sse(self, 'message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None},
                                    'usage': {'output_tokens': 20}})
        sse(self, 'message_stop', {'type': 'message_stop'})
        self.wfile.flush()

    def do_GET(self):
        self.reply_json({'data': [], 'has_more': False})

    def reply_json(self, obj):
        data = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main(argv):
    scenario_file, log = argv[0], argv[1]
    port = int(argv[argv.index('--port') + 1]) if '--port' in argv else 0
    with open(scenario_file) as f:
        Handler.scenario = json.load(f)
    Handler.log = log
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(srv.server_address[1], flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main(sys.argv[1:])
