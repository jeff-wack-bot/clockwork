#!/usr/bin/env python3
"""PipeWire bridge for Sample Factory: the design as a node in the PipeWire graph.

Run it as yourself, on the machine whose PipeWire you want to use:

    python3 tools/pwbridge.py            (then press "PipeWire" in the app)

It makes one PipeWire node, "Sample Factory", with a port for every In and Out
socket of the design that is open in the browser, named as the sockets are, so
the design can be patched like any other program (in Helvum, or in the app
itself). Audio goes between the browser and the node over a WebSocket on
127.0.0.1. The bridge also tells the app what else is in the graph (nodes,
ports and links) and makes or breaks links when asked (with pw-link).

Only Python 3 and PipeWire's own library and tools (libpipewire-0.3, pw-dump,
pw-link). Only pages served from this machine (localhost / 127.0.0.1) may
connect; --origin adds another.
"""
import argparse, base64, ctypes, hashlib, json, os, queue, shutil, socket, struct, subprocess, sys, threading, time

GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'   # RFC 6455
RATE = 48000


# ---- PipeWire: a filter node with named ports ------------------------------------------
class PipeWire:
    """One filter node whose ports are the design's sockets. Out sockets are the
    node's outputs (fed from the browser), In sockets its inputs (sent to it)."""
    FLAG_RT_PROCESS = 1 << 2

    def __init__(self, name, on_input):
        self.lib = pw = ctypes.CDLL('libpipewire-0.3.so.0')
        pw.pw_init(None, None)
        for f in ('pw_thread_loop_new', 'pw_thread_loop_get_loop', 'pw_properties_new', 'pw_filter_new_simple', 'pw_filter_add_port', 'pw_filter_get_dsp_buffer'):
            getattr(pw, f).restype = ctypes.c_void_p
        pw.pw_filter_get_node_id.restype = ctypes.c_uint32
        self.on_input = on_input
        self.lock = threading.Lock()
        self.outs, self.ins = [], []         # [(name, port pointer, ring bytearray)]
        self.loop = pw.pw_thread_loop_new(b'sample-factory', None)
        PROCESS = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p)

        class Events(ctypes.Structure):
            _fields_ = [('version', ctypes.c_uint32), ('destroy', ctypes.c_void_p), ('state_changed', ctypes.c_void_p),
                        ('io_changed', ctypes.c_void_p), ('param_changed', ctypes.c_void_p), ('add_buffer', ctypes.c_void_p),
                        ('remove_buffer', ctypes.c_void_p), ('process', PROCESS), ('drained', ctypes.c_void_p), ('command', ctypes.c_void_p)]
        self._cb = PROCESS(self._process)    # kept alive for as long as the filter
        self._events = Events(0, None, None, None, None, None, None, self._cb, None, None)
        props = pw.pw_properties_new(b'media.type', b'Audio', b'media.category', b'Filter', b'media.role', b'DSP',
                                     b'node.name', b'sample-factory', b'node.description', name.encode(),
                                     b'node.always-process', b'true', None)
        self.filter = pw.pw_filter_new_simple(ctypes.c_void_p(pw.pw_thread_loop_get_loop(ctypes.c_void_p(self.loop))), name.encode(),
                                              ctypes.c_void_p(props), ctypes.byref(self._events), None)
        pw.pw_filter_connect(ctypes.c_void_p(self.filter), ctypes.c_int(self.FLAG_RT_PROCESS), None, ctypes.c_uint32(0))
        pw.pw_thread_loop_start(ctypes.c_void_p(self.loop))

    def node_id(self):
        return self.lib.pw_filter_get_node_id(ctypes.c_void_p(self.filter))

    def set_ports(self, outs, ins):
        """Make the node's ports the design's sockets (by name, in order)."""
        pw = self.lib
        if [n for n, _, _ in self.outs] == outs and [n for n, _, _ in self.ins] == ins:
            return
        pw.pw_thread_loop_lock(ctypes.c_void_p(self.loop))
        try:
            with self.lock:
                for _, p, _ in self.outs + self.ins:
                    pw.pw_filter_remove_port(ctypes.c_void_p(p))
                self.outs, self.ins = [], []
                for names, direction, into in ((outs, 1, self.outs), (ins, 0, self.ins)):
                    for n in names:
                        props = pw.pw_properties_new(b'format.dsp', b'32 bit float mono audio', b'port.name', n.encode(), None)
                        p = pw.pw_filter_add_port(ctypes.c_void_p(self.filter), ctypes.c_int(direction), ctypes.c_int(1),
                                                  ctypes.c_size_t(0), ctypes.c_void_p(props), None, ctypes.c_uint32(0))
                        into.append((n, p, bytearray()))
        finally:
            pw.pw_thread_loop_unlock(ctypes.c_void_p(self.loop))

    def feed(self, chans):
        """Samples from the browser for the Out ports: one bytes object (float32) per port."""
        with self.lock:
            for (_, _, ring), data in zip(self.outs, chans):
                ring += data
                if len(ring) > 4 * RATE // 4:            # more than 250 ms behind: drop the oldest
                    del ring[:len(ring) - 4 * 4096]

    def _process(self, _data, position):
        # In PipeWire's realtime thread, once per quantum.
        n = ctypes.c_uint64.from_address(position + 96).value if position else 1024
        get = self.lib.pw_filter_get_dsp_buffer
        if not self.lock.acquire(blocking=False):
            return
        try:
            for _, p, ring in self.outs:
                buf = get(ctypes.c_void_p(p), ctypes.c_uint32(n))
                if not buf:
                    continue
                k = min(len(ring), 4 * n)
                if k:
                    ctypes.memmove(buf, bytes(ring[:k]), k)
                    del ring[:k]
                if k < 4 * n:
                    ctypes.memset(buf + k, 0, 4 * n - k)
            chunks = []
            for _, p, _ in self.ins:
                buf = get(ctypes.c_void_p(p), ctypes.c_uint32(n))
                chunks.append(ctypes.string_at(buf, 4 * n) if buf else bytes(4 * n))
        finally:
            self.lock.release()
        if chunks:
            self.on_input(chunks)

    def close(self):
        pw = self.lib
        pw.pw_thread_loop_stop(ctypes.c_void_p(self.loop))
        pw.pw_filter_destroy(ctypes.c_void_p(self.filter))
        pw.pw_thread_loop_destroy(ctypes.c_void_p(self.loop))


# ---- the graph: what else is there, and links --------------------------------------------
def read_graph():
    """Audio nodes, their ports and the links between them, from pw-dump."""
    out = subprocess.run(['pw-dump'], capture_output=True, text=True, timeout=10).stdout
    objs = json.loads(out or '[]')
    nodes, ports, links = {}, [], []
    for o in objs:
        t, props = o.get('type', ''), (o.get('info') or {}).get('props') or {}
        if t.endswith(':Node'):
            nodes[o['id']] = {'id': o['id'], 'name': props.get('node.name', ''), 'desc': props.get('node.description') or props.get('node.nick') or props.get('node.name', ''),
                              'cls': props.get('media.class', ''), 'app': props.get('application.name', '')}
        elif t.endswith(':Port'):
            fmt = props.get('format.dsp', '')
            if 'audio' not in fmt:
                continue                                  # MIDI and video are not for here
            ports.append({'id': o['id'], 'node': props.get('node.id'), 'name': props.get('port.name', ''), 'dir': 'out' if props.get('port.direction') == 'out' else 'in',
                          'monitor': props.get('port.monitor') == 'true'})
        elif t.endswith(':Link'):
            info = o.get('info') or {}
            links.append({'id': o['id'], 'out': info.get('output-port-id'), 'in': info.get('input-port-id')})
    ports = [p for p in ports if p['node'] in nodes]
    used = {p['node'] for p in ports}
    return {'nodes': [n for n in nodes.values() if n['id'] in used], 'ports': ports, 'links': links}


# ---- a minimal WebSocket server (RFC 6455), one client at a time --------------------------
class Client:
    def __init__(self, conn):
        self.conn, self.wlock, self.open = conn, threading.Lock(), True

    def send(self, payload, binary=False):
        if not self.open:
            return
        op = 0x2 if binary else 0x1
        data = payload if binary else payload.encode()
        n = len(data)
        head = bytes([0x80 | op]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack('>H', n) if n < 65536 else bytes([127]) + struct.pack('>Q', n))
        try:
            with self.wlock:
                self.conn.sendall(head + data)
        except OSError:
            self.open = False

    def recv(self):
        """The next message: (opcode, bytes), or None when the connection ends."""
        def exact(k):
            buf = b''
            while len(buf) < k:
                c = self.conn.recv(k - len(buf))
                if not c:
                    raise ConnectionError
                buf += c
            return buf
        msg, first_op = b'', None
        try:
            while True:
                b0, b1 = exact(2)
                op, n = b0 & 0x0F, b1 & 0x7F
                if n == 126:
                    n = struct.unpack('>H', exact(2))[0]
                elif n == 127:
                    n = struct.unpack('>Q', exact(8))[0]
                mask = exact(4) if b1 & 0x80 else b'\0\0\0\0'
                data = bytes(c ^ mask[i % 4] for i, c in enumerate(exact(n))) if n < 4096 else _unmask(exact(n), mask)
                if op == 0x8:
                    return None
                if op == 0x9:
                    with self.wlock:
                        self.conn.sendall(bytes([0x8A, len(data)]) + data)
                    continue
                if op in (0x1, 0x2):
                    first_op = op
                msg += data
                if b0 & 0x80:
                    return first_op, msg
        except (ConnectionError, OSError):
            return None


def _unmask(data, mask):
    m = int.from_bytes(mask * (len(data) // 4 + 1), 'little').to_bytes(len(data) // 4 * 4 + 4, 'little')[:len(data)]
    return (int.from_bytes(data, 'little') ^ int.from_bytes(m, 'little')).to_bytes(len(data), 'little')


def handshake(conn, origins):
    req = b''
    while b'\r\n\r\n' not in req:
        c = conn.recv(4096)
        if not c:
            return False
        req += c
    lines = req.decode('latin-1').split('\r\n')
    head = {k.strip().lower(): v.strip() for k, v in (l.split(':', 1) for l in lines[1:] if ':' in l)}
    origin = head.get('origin', '')
    allowed = any(origin.startswith(o) for o in origins)
    if 'sec-websocket-key' not in head or not allowed:
        conn.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
        print(f'refused a connection from {origin or "(no origin)"}', file=sys.stderr)
        return False
    accept = base64.b64encode(hashlib.sha1((head['sec-websocket-key'] + GUID).encode()).digest()).decode()
    conn.sendall(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                  f'Sec-WebSocket-Accept: {accept}\r\n\r\n').encode())
    return True


# ---- the bridge -----------------------------------------------------------------------------
class Bridge:
    def __init__(self, args):
        self.args, self.client = args, None
        self.inq = queue.Queue(maxsize=64)
        self.pw = PipeWire(args.name, self._input)
        self.graph_text = ''
        threading.Thread(target=self._graph_loop, daemon=True).start()
        threading.Thread(target=self._input_loop, daemon=True).start()

    def _input(self, chunks):                     # realtime thread: hand over, never block
        try:
            self.inq.put_nowait(chunks)
        except queue.Full:
            pass

    def _input_loop(self):
        while True:
            chunks = self.inq.get()
            c = self.client
            if c and c.open:
                c.send(struct.pack('<II', len(chunks), len(chunks[0]) // 4) + b''.join(chunks), binary=True)

    def _graph_loop(self):
        while True:
            try:
                g = read_graph()
                g['self'] = self.pw.node_id()
                text = json.dumps(dict(g, type='graph'), sort_keys=True)
                if text != self.graph_text and self.client:
                    self.graph_text = text
                    self.client.send(text)
            except Exception as e:  # noqa: BLE001 (keep going: pw-dump can fail while the graph changes)
                print('graph:', e, file=sys.stderr)
            time.sleep(self.args.poll)

    def serve(self, conn):
        c = Client(conn)
        if self.client:
            self.client.open = False
        self.client, self.graph_text = c, ''
        c.send(json.dumps({'type': 'hello', 'node': self.pw.node_id(), 'name': self.args.name, 'rate': RATE}))
        print('app connected')
        while True:
            m = c.recv()
            if m is None:
                break
            op, data = m
            if op == 0x2:                           # audio for the Out ports: header (channels, frames), float32 per channel
                if len(data) >= 8:
                    nch, n = struct.unpack('<II', data[:8])
                    body = data[8:]
                    self.pw.feed([body[i * 4 * n:(i + 1) * 4 * n] for i in range(nch)])
                continue
            try:
                msg = json.loads(data)
            except ValueError:
                continue
            t = msg.get('type')
            if t == 'ports':
                self.pw.set_ports([str(x) for x in msg.get('outs', [])], [str(x) for x in msg.get('ins', [])])
                self.graph_text = ''
            elif t == 'link':
                self._pwlink([str(int(msg['out'])), str(int(msg['in']))], c)
            elif t == 'unlink':
                self._pwlink(['-d', str(int(msg['id']))], c)
        c.open = False
        if self.client is c:
            self.client = None
            self.pw.set_ports([], [])
        print('app disconnected')

    def _pwlink(self, argv, c):
        r = subprocess.run(['pw-link'] + argv, capture_output=True, text=True, timeout=10)
        if r.returncode:
            c.send(json.dumps({'type': 'error', 'message': (r.stderr or r.stdout).strip() or 'pw-link failed'}))
        self.graph_text = ''


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--name', default='Sample Factory', help='the node\'s name in PipeWire')
    ap.add_argument('--origin', action='append', default=[], help='also accept pages from this origin')
    ap.add_argument('--poll', type=float, default=0.7, help='seconds between looks at the graph')
    args = ap.parse_args()
    for tool in ('pw-dump', 'pw-link'):
        if not shutil.which(tool):
            sys.exit(f'{tool} not found: install PipeWire\'s tools (pipewire-bin)')
    origins = ['http://127.0.0.1:', 'http://localhost:', 'http://[::1]:'] + args.origin
    bridge = Bridge(args)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('127.0.0.1', args.port))
    srv.listen(4)
    print(f'Sample Factory PipeWire bridge: node "{args.name}" (id {bridge.pw.node_id()}), app connects to ws://127.0.0.1:{args.port}')
    try:
        while True:
            conn, _ = srv.accept()
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            if handshake(conn, origins):
                threading.Thread(target=bridge.serve, args=(conn,), daemon=True).start()
            else:
                conn.close()
    except KeyboardInterrupt:
        pass
    finally:
        bridge.pw.close()
        os._exit(0)


if __name__ == '__main__':
    main()
