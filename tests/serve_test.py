#!/usr/bin/env python3
"""Tests for tools/serve.py (the curator server), against a temporary directory."""
import json, os, subprocess, sys, tempfile, time, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8769
failed = 0

def req(method, path, body=None):
    r = urllib.request.Request(f'http://127.0.0.1:{PORT}{path}', data=body, method=method)
    try:
        with urllib.request.urlopen(r) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def check(name, cond):
    global failed
    print(('ok   ' if cond else 'FAIL ') + name)
    if not cond: failed += 1

def doc(title, kind='example'):
    return json.dumps({'format': 'sample-factory-design', 'version': 2, 'kind': kind, 'meta': {'title': title}, 'board': {}}).encode()

tmp = tempfile.mkdtemp()
srv = subprocess.Popen([sys.executable, os.path.join(ROOT, 'tools', 'serve.py'), '--port', str(PORT), '--root', tmp], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try: req('GET', '/api/curate'); break
        except Exception: time.sleep(0.1)
    st, body = req('GET', '/api/curate')
    check('GET /api/curate reports an empty manifest', st == 200 and json.loads(body)['manifest'] == {'examples': []})
    st, body = req('PUT', '/api/examples/first-one.json', doc('First → one'))
    check('PUT saves a design', st == 200 and json.loads(body)['replaced'] is False and os.path.exists(os.path.join(tmp, 'examples', 'first-one.json')))
    req('PUT', '/api/examples/second.json', doc('Second'))
    st, body = req('PUT', '/api/examples/first-one.json', doc('First, renamed'))
    man = json.load(open(os.path.join(tmp, 'examples', 'index.json')))
    check('replacing keeps the menu order and updates the title', json.loads(body)['replaced'] and man['examples'] == [
        {'file': 'first-one.json', 'title': 'First, renamed'}, {'file': 'second.json', 'title': 'Second'}])
    text = open(os.path.join(tmp, 'examples', 'index.json')).read()
    check('the manifest is one entry per line', text == '{\n  "examples": [\n    {"file": "first-one.json", "title": "First, renamed"},\n    {"file": "second.json", "title": "Second"}\n  ]\n}\n')
    for bad in ['/api/examples/..%2Fevil.json', '/api/examples/Evil.json', '/api/examples/index.json', '/api/examples/x.txt', '/api/examples/a/b.json']:
        st, _ = req('PUT', bad, doc('x'))
        check(f'refuses {bad}', st == 400)
    st, _ = req('PUT', '/api/examples/notjson.json', b'{oops')
    check('refuses a body that is not JSON', st == 400)
    st, _ = req('PUT', '/api/examples/other.json', b'{"root": {}, "defs": {}}')
    check('refuses JSON that is not a design document', st == 400)
    check('nothing else was written', sorted(os.listdir(os.path.join(tmp, 'examples'))) == ['first-one.json', 'index.json', 'second.json'] and sorted(os.listdir(tmp)) == ['examples'])
    st, body = req('GET', '/examples/second.json')
    check('serves the saved files', st == 200 and json.loads(body)['meta']['title'] == 'Second')
    st, body = req('PUT', '/api/library/phasor.json', doc('Phasor', 'block'))
    lib = open(os.path.join(tmp, 'library', 'index.json')).read()
    check('library blocks go to library/, listed under "blocks"', st == 200 and lib == '{\n  "blocks": [\n    {"file": "phasor.json", "title": "Phasor"}\n  ]\n}\n')
    st, _ = req('PUT', '/api/library/x.json', doc('X', 'example'))
    st2, _ = req('PUT', '/api/examples/y.json', doc('Y', 'block'))
    check('each folder takes only its own kind of file', st == 400 and st2 == 400)
    st, body = req('GET', '/api/curate')
    check('GET /api/curate lists both folders', json.loads(body)['library']['blocks'][0]['file'] == 'phasor.json')
    # deleting goes to the trash, and can be undone
    st, body = req('DELETE', '/api/examples/first-one.json')
    j = json.loads(body)
    check('DELETE moves a file to the trash and out of the menu', st == 200 and not os.path.exists(os.path.join(tmp, 'examples', 'first-one.json'))
          and [e['file'] for e in j['manifest']['examples']] == ['second.json'] and os.path.exists(os.path.join(tmp, 'examples', '.trash', j['trashed'])))
    st, body = req('GET', '/api/curate')
    tr = json.loads(body)['trash']
    check('the trash lists it with its title', tr and tr[0]['file'] == 'first-one.json' and tr[0]['title'] == 'First, renamed' and tr[0]['folder'] == 'examples')
    st, _ = req('DELETE', '/api/examples/nothere.json')
    check('deleting a file that is not there is refused', st == 404)
    jb = lambda o: json.dumps(o).encode()
    st, body = req('POST', '/api/examples/restore', jb({'trashed': j['trashed']}))
    man = json.loads(body)['manifest']['examples']
    check('restore puts it back, at the end of the menu, with its title', st == 200 and man[-1] == {'file': 'first-one.json', 'title': 'First, renamed'}
          and os.path.exists(os.path.join(tmp, 'examples', 'first-one.json')) and not json.loads(body)['trash'])
    st, body = req('POST', '/api/examples/order', jb({'files': ['first-one.json', 'second.json']}))
    check('order rearranges the menu', st == 200 and [e['file'] for e in json.loads(body)['manifest']['examples']] == ['first-one.json', 'second.json'])
    st, _ = req('POST', '/api/examples/order', jb({'files': ['first-one.json']}))
    check('an order that leaves a file out is refused', st == 400)
    st, body = req('POST', '/api/examples/rename', jb({'from': 'first-one.json', 'to': 'the-first.json', 'text': doc('The first').decode()}))
    man = json.loads(body)['manifest']['examples']
    check('rename keeps the place in the menu, with the new title and text', st == 200 and man[0] == {'file': 'the-first.json', 'title': 'The first'}
          and not os.path.exists(os.path.join(tmp, 'examples', 'first-one.json')) and json.load(open(os.path.join(tmp, 'examples', 'the-first.json')))['meta']['title'] == 'The first')
    st, _ = req('POST', '/api/examples/rename', jb({'from': 'the-first.json', 'to': 'second.json', 'text': doc('X').decode()}))
    check('rename onto an existing file is refused', st == 409)
    st, _ = req('POST', '/api/examples/rename', jb({'from': 'the-first.json', 'to': '../x.json', 'text': doc('X').decode()}))
    check('rename to a bad name is refused', st == 400)
    st, _ = req('POST', '/api/examples/restore', jb({'trashed': '../../etc/passwd'}))
    check('restore only takes names from the trash', st == 404)
    st, _ = req('PUT', '/api/tools/serve.json', doc('x'))
    check('nothing outside examples/ and library/', st in (400, 404, 501) and not os.path.exists(os.path.join(tmp, 'tools')))
finally:
    srv.terminate()
print(f'\n{"all passed" if not failed else str(failed) + " failed"}')
sys.exit(1 if failed else 0)
