#!/usr/bin/env python3
"""Test tools/pwbridge.py against a private PipeWire (its own daemon and session
manager, in a temporary runtime directory, so the user's audio is not touched).

Checks: a page from elsewhere is refused; the WebSocket handshake is RFC 6455's;
the node's ports are named after the sockets; a link asked for by the app is made;
audio sent for an Out socket arrives at whatever it is linked to; audio linked
into an In socket comes back to the app.

Skipped (exit 0) where PipeWire, WirePlumber or pw-cat are not installed.
Usage: python3 tests/pwbridge_test.py
"""
import base64, hashlib, json, math, os, shutil, socket, struct, subprocess, sys, tempfile, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


def ws_connect(port, origin):
    s = socket.create_connection(('127.0.0.1', port), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f'GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n'
               f'Sec-WebSocket-Version: 13\r\nOrigin: {origin}\r\n\r\n').encode())
    resp = b''
    while b'\r\n\r\n' not in resp:
        c = s.recv(4096)
        if not c:
            break
        resp += c
    want = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    return s, resp.decode('latin-1'), want


def ws_send(s, data, binary=False):
    if isinstance(data, str):
        data = data.encode()
    mask, n = os.urandom(4), len(data)
    head = bytes([0x82 if binary else 0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack('>H', n) if n < 65536 else bytes([0x80 | 127]) + struct.pack('>Q', n))
    s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def ws_recv(s):
    def exact(k):
        b = b''
        while len(b) < k:
            c = s.recv(k - len(b))
            if not c:
                raise ConnectionError
            b += c
        return b
    b0, b1 = exact(2)
    n = b1 & 0x7F
    if n == 126:
        n = struct.unpack('>H', exact(2))[0]
    elif n == 127:
        n = struct.unpack('>Q', exact(8))[0]
    return b0 & 0x0F, exact(n)


def main():
    need = ['pipewire', 'wireplumber', 'pw-cat', 'pw-dump', 'pw-link']
    if not all(shutil.which(t) for t in need):
        print('skipped: needs ' + ', '.join(need))
        return 0
    rt = tempfile.mkdtemp(prefix='sf-pw-')
    os.chmod(rt, 0o700)
    env = dict(os.environ, XDG_RUNTIME_DIR=rt)
    env.pop('PIPEWIRE_REMOTE', None)
    procs = []
    spawn = lambda argv, **kw: procs.append(subprocess.Popen(argv, env=env, stdout=kw.get('stdout', subprocess.DEVNULL), stderr=subprocess.DEVNULL)) or procs[-1]
    failures = []
    check = lambda ok, what: (print(('ok   ' if ok else 'FAIL ') + what), ok or failures.append(what))
    try:
        spawn(['pipewire']); time.sleep(1.0)
        spawn(['wireplumber']); time.sleep(2.0)
        port = 8790 + os.getpid() % 100
        spawn([sys.executable, os.path.join(ROOT, 'tools', 'pwbridge.py'), '--port', str(port), '--poll', '0.3'])
        time.sleep(1.5)
        _, resp, _ = ws_connect(port, 'http://example.com')
        check(resp.startswith('HTTP/1.1 403'), 'a page from another site is refused')
        s, resp, want = ws_connect(port, 'http://127.0.0.1:8000')
        check(resp.startswith('HTTP/1.1 101') and f'Sec-WebSocket-Accept: {want}' in resp, 'the handshake is RFC 6455\'s')
        hello = json.loads(ws_recv(s)[1])
        check(hello['type'] == 'hello', 'hello')
        ws_send(s, json.dumps({'type': 'ports', 'outs': ['lead', 'bass'], 'ins': ['mic']}))
        listener = subprocess.Popen(['pw-cat', '--record', '--raw', '--format', 'f32', '--rate', '48000', '--channels', '1', '--target', '0',
                                     '-P', '{ node.name = "sf-test-listener" }', '-'], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        procs.append(listener)
        tone = subprocess.Popen(['pw-cat', '--playback', '--raw', '--format', 'f32', '--rate', '48000', '--channels', '1', '--target', '0',
                                 '-P', '{ node.name = "sf-test-tone" }', '-'], env=env, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
        procs.append(tone)
        sine = struct.pack('<%df' % 48000, *[0.25 * math.sin(2 * math.pi * 330 * i / 48000) for i in range(48000)])
        def play():
            try:
                for _ in range(4):
                    tone.stdin.write(sine)
            except (BrokenPipeError, ValueError):
                pass                                   # stopped at the end of the test
        threading.Thread(target=play, daemon=True).start()
        graph, t0 = None, time.time()
        while time.time() - t0 < 8:
            op, d = ws_recv(s)
            if op != 1:
                continue
            m = json.loads(d)
            names = {n['name'] for n in m.get('nodes', [])}
            if m.get('type') == 'graph' and {'sf-test-listener'} <= names and any(p['node'] == m['self'] for p in m['ports']):
                graph = m
                break
        check(graph is not None, 'the graph comes to the app')
        if not graph:
            return 1
        mine = {(p['name'], p['dir']) for p in graph['ports'] if p['node'] == graph['self']}
        check(mine == {('lead', 'out'), ('bass', 'out'), ('mic', 'in')}, 'the node\'s ports are the sockets, by name: ' + str(sorted(mine)))
        node = lambda name: next(n['id'] for n in graph['nodes'] if n['name'] == name)
        pid = lambda nid, d, name=None: next(p['id'] for p in graph['ports'] if p['node'] == nid and p['dir'] == d and (name is None or p['name'] == name))
        ws_send(s, json.dumps({'type': 'link', 'out': pid(graph['self'], 'out', 'lead'), 'in': pid(node('sf-test-listener'), 'in')}))
        tone_out = next((p['id'] for p in graph['ports'] if p['dir'] == 'out' and any(n['id'] == p['node'] and n['name'] == 'sf-test-tone' for n in graph['nodes'])), None)
        if tone_out:
            ws_send(s, json.dumps({'type': 'link', 'out': tone_out, 'in': pid(graph['self'], 'in', 'mic')}))
        got = {'in': 0, 'links': []}

        def reader():
            try:
                while True:
                    op, d = ws_recv(s)
                    if op == 2:
                        nch, n = struct.unpack('<II', d[:8])
                        vals = struct.unpack('<%df' % n, d[8:8 + 4 * n])
                        got['in'] = max(got['in'], max(abs(v) for v in vals))
                    elif op == 1 and json.loads(d).get('type') == 'graph':
                        got['links'] = json.loads(d)['links']
            except Exception:  # noqa: BLE001 (the connection closes at the end)
                pass
        threading.Thread(target=reader, daemon=True).start()
        k = 0
        for _ in range(60):                       # 1.3 s of a 440 Hz sine on "lead", silence on "bass"
            n = 1024
            a = struct.pack('<%df' % n, *[0.5 * math.sin(2 * math.pi * 440 * (k + i) / 48000) for i in range(n)])
            ws_send(s, struct.pack('<II', 2, n) + a + bytes(4 * n), binary=True)
            k += n
            time.sleep(n / 48000)
        time.sleep(0.4)
        listener.terminate()
        data = listener.stdout.read()
        vals = struct.unpack('<%df' % (len(data) // 4), data[:len(data) // 4 * 4])
        peak = max((abs(v) for v in vals), default=0)
        check(abs(peak - 0.5) < 0.01, f'the Out socket\'s audio arrives where it is linked (peak {peak:.3f})')
        check(any(l['in'] == pid(node('sf-test-listener'), 'in') for l in got['links']), 'the link the app asked for is in the graph')
        check(tone_out is not None and abs(got['in'] - 0.25) < 0.01, f'audio linked into the In socket comes back to the app (peak {got["in"]:.3f})')
        return 1 if failures else 0
    finally:
        for p in reversed(procs):
            try:
                p.terminate(); p.wait(3)
            except Exception:  # noqa: BLE001
                p.kill()
        shutil.rmtree(rt, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
