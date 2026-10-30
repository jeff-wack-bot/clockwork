#!/usr/bin/env python3
"""Serve Sample Factory locally, with curation: the app's "Save…" writes design
files into examples/ (whole designs) or library/ (blocks), and keeps each folder's
index.json (the Open menu and the library) in step.

    python3 tools/serve.py [--port 8000] [--root REPO]

Binds to 127.0.0.1 only. Writes are limited to examples/<name>.json and
library/<name>.json, where name is lower case letters, digits and dashes, and the
body must be a Sample Factory design document of the right kind, under 8 MB. Each file is written to a temporary name and renamed,
so a crash never leaves half a file. No dependencies beyond Python 3.

Curation requests (all keep index.json in step):
    PUT    /api/<folder>/<file>          save a design file
    DELETE /api/<folder>/<file>          move it to <folder>/.trash/ (restorable)
    POST   /api/<folder>/restore         {"trashed": name}: put it back
    POST   /api/<folder>/rename          {"from", "to", "text"}: same place in the menu, new name and text
    POST   /api/<folder>/order           {"files": [...]}: reorder the menu
    GET    /api/curate                   both menus and the trash
"""
import argparse, functools, http.server, json, os, re, tempfile, threading, time

FORMAT = 'sample-factory-design'
NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}\.json$')
MAX = 8 << 20
lock = threading.Lock()
# folder -> (manifest key, document kind)
COLLECTIONS = {'examples': ('examples', 'example'), 'library': ('blocks', 'block')}


def manifest_path(root, coll):
    return os.path.join(root, coll, 'index.json')


def read_manifest(root, coll):
    try:
        with open(manifest_path(root, coll)) as f:
            m = json.load(f)
    except FileNotFoundError:
        m = {}
    m.setdefault(COLLECTIONS[coll][0], [])
    return m


def write_atomic(path, text):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.tmp-')
    with os.fdopen(fd, 'w') as f:
        f.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def manifest_text(m, key):
    # one entry per line, so reordering shows up as a clean diff
    lines = ',\n'.join('    ' + json.dumps(e, ensure_ascii=False) for e in m[key])
    return '{\n  "' + key + '": [\n' + lines + ('\n' if lines else '') + '  ]\n}\n'


class Handler(http.server.SimpleHTTPRequestHandler):
    root = '.'

    def log_message(self, fmt, *args):
        if self.command != 'GET':
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/api/curate':
            return self.reply(200, {'ok': True, 'manifest': read_manifest(self.root, 'examples'), 'library': read_manifest(self.root, 'library'), 'trash': self.trash_list()})
        return super().do_GET()

    def do_PUT(self):
        m = re.fullmatch(r'/api/(examples|library)/([^/?#]+)', self.path)
        if not m or not NAME.match(m.group(2)) or m.group(2) == 'index.json':
            return self.reply(400, {'ok': False, 'error': 'file names are lower-case letters, digits and dashes, ending in .json'})
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX:
            return self.reply(413, {'ok': False, 'error': 'empty or too large'})
        text = self.rfile.read(n).decode('utf-8')
        try:
            doc = json.loads(text)
        except ValueError as e:
            return self.reply(400, {'ok': False, 'error': 'not JSON: ' + str(e)})
        if not isinstance(doc, dict) or doc.get('format') != FORMAT:
            return self.reply(400, {'ok': False, 'error': 'not a Sample Factory design'})
        coll, name = m.group(1), m.group(2)
        key, kind = COLLECTIONS[coll]
        if doc.get('kind', 'example') != kind:
            return self.reply(400, {'ok': False, 'error': f'{coll}/ takes {kind} files, not {doc.get("kind")}'})
        title = str((doc.get('meta') or {}).get('title') or name[:-5])
        with lock:
            existed = os.path.exists(os.path.join(self.root, coll, name))
            write_atomic(os.path.join(self.root, coll, name), text)
            man = read_manifest(self.root, coll)
            for e in man[key]:
                if e.get('file') == name:
                    e['title'] = title
                    break
            else:
                man[key].append({'file': name, 'title': title})
            write_atomic(manifest_path(self.root, coll), manifest_text(man, key))
        return self.reply(200, {'ok': True, 'file': name, 'replaced': existed, 'manifest': man})

    # ---- deleting (into a trash folder), restoring, renaming, reordering ----------------
    # Deleted files go to <folder>/.trash/, named <time>--<file>, with their menu
    # title kept beside them, so a delete can be undone from the app.
    def body_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX:
            return None
        try:
            return json.loads(self.rfile.read(n).decode('utf-8'))
        except ValueError:
            return None

    def do_DELETE(self):
        m = re.fullmatch(r'/api/(examples|library)/([^/?#]+)', self.path)
        if not m or not NAME.match(m.group(2)) or m.group(2) == 'index.json':
            return self.reply(400, {'ok': False, 'error': 'no such file'})
        coll, name = m.group(1), m.group(2)
        key = COLLECTIONS[coll][0]
        with lock:
            path = os.path.join(self.root, coll, name)
            if not os.path.exists(path):
                return self.reply(404, {'ok': False, 'error': f'{coll}/{name} does not exist'})
            man = read_manifest(self.root, coll)
            entry = next((e for e in man[key] if e.get('file') == name), {'file': name, 'title': name[:-5]})
            trash = os.path.join(self.root, coll, '.trash')
            os.makedirs(trash, exist_ok=True)
            tname = time.strftime('%Y%m%d-%H%M%S') + '--' + name
            while os.path.exists(os.path.join(trash, tname)):
                tname = '0' + tname
            os.replace(path, os.path.join(trash, tname))
            write_atomic(os.path.join(trash, tname + '.title'), entry.get('title', ''))
            man[key] = [e for e in man[key] if e.get('file') != name]
            write_atomic(manifest_path(self.root, coll), manifest_text(man, key))
        return self.reply(200, {'ok': True, 'trashed': tname, 'manifest': man})

    def trash_list(self):
        out = []
        for coll in COLLECTIONS:
            d = os.path.join(self.root, coll, '.trash')
            if not os.path.isdir(d):
                continue
            for t in sorted(os.listdir(d), reverse=True):
                if not t.endswith('.json') or '--' not in t:
                    continue
                try:
                    with open(os.path.join(d, t + '.title')) as f:
                        title = f.read()
                except OSError:
                    title = ''
                out.append({'folder': coll, 'trashed': t, 'file': t.split('--', 1)[1], 'title': title, 'when': t.split('--', 1)[0]})
        return out

    def do_POST(self):
        m = re.fullmatch(r'/api/(examples|library)/(restore|rename|order)', self.path)
        if not m:
            return self.reply(404, {'ok': False, 'error': 'unknown request'})
        coll, op = m.groups()
        key, kind = COLLECTIONS[coll]
        body = self.body_json()
        if not isinstance(body, dict):
            return self.reply(400, {'ok': False, 'error': 'expected a JSON object'})
        with lock:
            man = read_manifest(self.root, coll)
            files = [e.get('file') for e in man[key]]
            if op == 'order':
                order = body.get('files')
                if not isinstance(order, list) or sorted(order) != sorted(files):
                    return self.reply(400, {'ok': False, 'error': 'the new order must list exactly the files in the menu'})
                byfile = {e['file']: e for e in man[key]}
                man[key] = [byfile[f] for f in order]
            elif op == 'restore':
                t = str(body.get('trashed', ''))
                src = os.path.join(self.root, coll, '.trash', t)
                if '/' in t or '--' not in t or not os.path.exists(src):
                    return self.reply(404, {'ok': False, 'error': 'not in the trash'})
                name = t.split('--', 1)[1]
                if os.path.exists(os.path.join(self.root, coll, name)):
                    return self.reply(409, {'ok': False, 'error': f'{coll}/{name} exists again; delete or rename it first'})
                try:
                    with open(src + '.title') as f:
                        title = f.read() or name[:-5]
                except OSError:
                    title = name[:-5]
                os.replace(src, os.path.join(self.root, coll, name))
                if os.path.exists(src + '.title'):
                    os.remove(src + '.title')
                man[key].append({'file': name, 'title': title})
            else:   # rename: the file under a new name, in the same place in the menu, with new text (its new title)
                old, new, text = str(body.get('from', '')), str(body.get('to', '')), body.get('text')
                if not NAME.match(old) or not NAME.match(new) or 'index.json' in (old, new):
                    return self.reply(400, {'ok': False, 'error': 'file names are lower-case letters, digits and dashes, ending in .json'})
                if old not in files:
                    return self.reply(404, {'ok': False, 'error': f'{coll}/{old} is not in the menu'})
                if new != old and os.path.exists(os.path.join(self.root, coll, new)):
                    return self.reply(409, {'ok': False, 'error': f'{coll}/{new} already exists'})
                try:
                    doc = json.loads(text)
                except (TypeError, ValueError):
                    return self.reply(400, {'ok': False, 'error': 'the new text is not JSON'})
                if not isinstance(doc, dict) or doc.get('format') != FORMAT or doc.get('kind', 'example') != kind:
                    return self.reply(400, {'ok': False, 'error': f'not a Sample Factory {kind}'})
                write_atomic(os.path.join(self.root, coll, new), text)
                if new != old:
                    os.remove(os.path.join(self.root, coll, old))
                for e in man[key]:
                    if e['file'] == old:
                        e['file'], e['title'] = new, str((doc.get('meta') or {}).get('title') or new[:-5])
            write_atomic(manifest_path(self.root, coll), manifest_text(man, key))
        return self.reply(200, {'ok': True, 'manifest': man, 'trash': self.trash_list()})


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--root', default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    a = ap.parse_args()
    Handler.root = os.path.abspath(a.root)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', a.port), functools.partial(Handler, directory=Handler.root))
    print(f'Sample Factory with curation: http://127.0.0.1:{a.port}/  (saves into {Handler.root}/examples and /library)', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
