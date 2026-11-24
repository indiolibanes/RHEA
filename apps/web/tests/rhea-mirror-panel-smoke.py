"""Mobile smoke test for the protected topic-mirror panel.

The real panel module and the real markup from TelegramLibrary.astro are served from a temporary
directory, so the test does not need a site build. Every API response is mocked; no network is used.
"""
import functools
import json
import re
import shutil
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

web = Path(__file__).resolve().parents[1]
library = web / 'src' / 'rhea' / 'library'
markup = (library / 'TelegramLibrary.astro').read_text()
section = re.search(r'<details class="library-section" id="mirror-panel">.*?</dialog>', markup, re.S)
assert section and 'id="mirror-dialog"' in section.group(0), 'Mirror markup not found.'
site = Path(tempfile.mkdtemp(prefix='rhea-mirror-panel-'))
shutil.copy(library / 'mirror-panel.mjs', site / 'mirror-panel.mjs')
shutil.copy(library / 'library.css', site / 'library.css')
(site / 'index.html').write_text(f'''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/library.css">
<style>:root{{--color-surface:#fff;--color-text-primary:#111;--color-outline:#888}}body{{margin:0;font:16px system-ui}}</style>
<div class="library" data-rhea-telegram-library data-telegram-endpoint="/api/rhea/telegram-mtproto">{section.group(0)}</div>
<script type="module" src="/mirror-panel.mjs"></script>''')

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(site)))
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
approval = 'A' * 43
posts = [{'id': 11, 'kind': 'video', 'label': 'Synthetic clip.mkv'}, {'id': 12, 'kind': 'text', 'label': 'Synthetic note'}]
calls = []
script = []
held = []

def respond(route):
    request = route.request
    operation = re.search(r'op=([a-z]+)', request.url).group(1)
    calls.append(operation)
    if operation == 'mirrorapprove':
        assert json.loads(request.post_data) == {'confirm': True, 'approval': approval}
    else:
        assert request.post_data is None
    entry = script.pop(0)
    if entry[0] == 'hold':
        held.append((route, entry[1], entry[2]))
        return
    route.fulfill(status=entry[0], json=entry[1])

def reset(*responses):
    calls.clear()
    script.clear()
    script.extend(responses)

def progress(local, backup, state='mirror_progress', total=2):
    body = {'state': state, 'mirror': {'total': total, 'copies': [{'sourceId': a, 'destinationId': b} for a, b in backup]}}
    if local is not None:
        body['mirror']['localCopies'] = [{'sourceId': a, 'destinationId': b} for a, b in local]
    return 200, body

def preview(local=None):
    mirror = {'approval': approval, 'expiresAt': 1, 'total': 2, 'source': 'Origem / RHEA Mirror Test',
              'destination': 'Reserva / RHEA Backup Test', 'posts': posts}
    if local:
        mirror['localDestination'] = local
    return 200, {'state': 'mirror_preview', 'mirror': mirror}

with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True,
                                  device_scale_factor=2, reduced_motion='reduce')
    context.route('**/api/rhea/**', respond)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base + '/index.html')
    page.locator('#mirror-panel > summary').click()

    def no_overflow():
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'horizontal overflow'

    # 1. Previous response shape (single destination, no localCopies): both lists stay collapsed to one.
    reset(preview(), progress(None, []), progress(None, [(11, 31)]), progress(None, [(11, 31), (12, 32)], 'mirror_done'))
    page.locator('#mirror-preview').click()
    expect(page.locator('#mirror-dialog')).to_be_visible()
    expect(page.locator('#mirror-destination-label')).to_have_text('Destino')
    expect(page.locator('#mirror-local-row')).to_be_hidden()
    expect(page.locator('#mirror-dialog')).to_contain_text('nada é publicado até você tocar em Continuar cópia')
    no_overflow()
    page.locator('#mirror-approve').click()
    expect(page.locator('#mirror-continue')).to_be_visible()
    assert calls == ['mirrorpreview', 'mirrorapprove'], calls
    page.locator('#mirror-continue').click()
    expect(page.locator('#mirror-status')).to_contain_text('Cópia de teste concluída')
    page.locator('#mirror-receipts summary').click()
    expect(page.locator('#mirror-mapping')).to_contain_text('#12 → #32')
    expect(page.locator('#mirror-local-mapping')).to_be_hidden()
    assert calls[2:] == ['mirrornext', 'mirrornext'], calls

    # 2. Two destinations: both are named in the dialog, receipts stay in separate lists, pause and resume work.
    reset(preview('Origem / RHEA Organized Test'), progress([], []), progress([(11, 41)], []),
          ('hold', *progress([(11, 41)], [(11, 31)])),
          progress([(11, 41), (12, 42)], [(11, 31), (12, 32)], 'mirror_done'))
    page.locator('#mirror-preview').click()
    expect(page.locator('#mirror-local-row')).to_contain_text('Organized')
    expect(page.locator('#mirror-destination-label')).to_have_text('Backup')
    expect(page.locator('#mirror-destination')).to_contain_text('Reserva')
    no_overflow()
    page.locator('#mirror-approve').click()
    page.locator('#mirror-continue').click()
    expect(page.locator('#mirror-pause')).to_be_visible()
    page.wait_for_function('() => true')
    while not held:
        page.wait_for_timeout(20)
    page.locator('#mirror-pause').click()
    route, status, body = held.pop()
    route.fulfill(status=status, json=body)
    expect(page.locator('#mirror-pause')).to_be_hidden()
    expect(page.locator('#mirror-continue')).to_be_visible()
    assert calls.count('mirrornext') == 2, calls
    page.locator('#mirror-continue').click()
    expect(page.locator('#mirror-status')).to_contain_text('Cópia de teste concluída')
    page.locator('#mirror-receipts summary').click()
    expect(page.locator('#mirror-local-mapping')).to_have_text(re.compile(r'#11 → #41\s*#12 → #42'))
    expect(page.locator('#mirror-mapping')).to_have_text(re.compile(r'#11 → #31\s*#12 → #32'))
    assert 'mirror-local-mapping' != 'mirror-mapping'
    no_overflow()

    # 3. A stale or edited approval is refused with a Portuguese, actionable message and no copy button.
    reset(preview(), (409, {'state': 'mirror_changed'}))
    page.locator('#mirror-preview').click()
    page.locator('#mirror-approve').click()
    expect(page.locator('#mirror-status')).to_contain_text('divergiu da prévia')
    expect(page.locator('#mirror-continue')).to_be_hidden()
    expect(page.locator('#mirror-dialog')).not_to_be_visible()

    # 4. A rate limit pauses the loop, names the wait and offers to continue; later failures keep shown receipts.
    reset(progress([(11, 41)], [(11, 31)]), (429, {'state': 'rate_limited', 'retryAfter': 30}),
          (409, {'state': 'mirror_changed', 'issue': {'side': 'local', 'code': 'destination_in_use'}}))
    page.locator('#mirror-check').click()
    expect(page.locator('#mirror-continue')).to_be_visible()
    page.locator('#mirror-continue').click()
    expect(page.locator('#mirror-status')).to_contain_text('Aguarde cerca de 30 s')
    page.locator('#mirror-check').click()
    expect(page.locator('#mirror-status')).to_contain_text('Tópico organizado · Este tópico já está reservado')
    expect(page.locator('#mirror-local-mapping')).to_contain_text('#11 → #41')

    # 5. Provider detail never reaches the page; every failure maps to fixed copy.
    reset((503, {'state': 'unavailable', 'detail': 'RPCError FLOOD_WAIT secret-token', 'issue': {'code': 'unsupported_post', 'detail': 'raw'}}),
          (403, {'state': 'not_allowed'}))
    page.locator('#mirror-check').click()
    expect(page.locator('#mirror-status')).to_contain_text('O adaptador não respondeu')
    page.locator('#mirror-check').click()
    expect(page.locator('#mirror-status')).to_contain_text('Entre novamente pelo Cloudflare Access')
    assert 'secret-token' not in page.content() and 'RPCError' not in page.content()
    assert not errors, errors
    browser.close()

server.shutdown()
shutil.rmtree(site, ignore_errors=True)
print(json.dumps({'viewport': '390x844 Chromium touch, reduced motion', 'scenarios': 5}))
