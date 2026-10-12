#!/usr/bin/env python3
"""Run the interactivity tests (tests/ui/ui-tests.js) in headless Firefox.

Serves the repository on a local port, opens index.html?uitest=1 in a fresh
Firefox profile, waits for the page to POST its report, prints it and exits
non-zero on failure. No dependencies beyond Python 3 and Firefox.
Usage: python3 tests/run-ui.py   (FIREFOX=/path/to/firefox to override)
"""
import functools, http.server, json, os, shutil, subprocess, sys, tempfile, threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('UI_PORT', '8767'))
TIMEOUT = float(os.environ.get('UI_TIMEOUT', '240'))
done, report = threading.Event(), {}

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def do_POST(self):
        if self.path != '/__ui_result':
            self.send_error(404); return
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        report.update(json.loads(body or b'{}'))
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
        done.set()

def main():
    firefox = os.environ.get('FIREFOX') or shutil.which('firefox')
    if not firefox:
        print('firefox not found (set FIREFOX)'); return 2
    server = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), functools.partial(Handler, directory=ROOT))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    profile = tempfile.mkdtemp(prefix='sf-ui-')
    with open(os.path.join(profile, 'user.js'), 'w') as f:
        f.write('user_pref("browser.shell.checkDefaultBrowser", false);\n'
                'user_pref("datareporting.policy.dataSubmissionEnabled", false);\n'
                'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);\n')
    url = f'http://127.0.0.1:{PORT}/index.html?uitest=1&example=0'
    proc = subprocess.Popen([firefox, '--headless', '--no-remote', '--profile', profile, '--window-size=1400,900', url],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        finished = done.wait(TIMEOUT)
    finally:
        proc.terminate()
        try: proc.wait(10)
        except subprocess.TimeoutExpired: proc.kill()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    if not finished:
        print(f'no report from the page within {TIMEOUT:.0f} s'); return 1
    for r in report.get('results', []):
        print(('ok   ' if r['ok'] else 'FAIL ') + r['name'] + ('' if r['ok'] else '\n     ' + r.get('error', '')))
    for e in report.get('errors', []): print('page error: ' + e)
    print(f"\n{report.get('passed', 0)} passed, {report.get('failed', 0)} failed")
    return 0 if report.get('failed', 1) == 0 and report.get('passed', 0) > 0 else 1

if __name__ == '__main__':
    sys.exit(main())
