"""Browser smoke test for the Telegram organization path (Requests -> AniList -> destinations -> publication).

The real markup (TelegramLibrary.astro + AnimeEnrichment.astro) and the real panel modules are served from a
temporary directory, so no Astro build is needed. Every API response is mocked with synthetic data and no
network is used. Preview and approval must never send Telegram files; only the explicit run step copies.

Environment:
  RHEA_LIBRARY_DIR  library directory to serve (default: this checkout), used for the "before" screenshots.
  RHEA_SHOTS_DIR    where to write screenshots (default: none).
  RHEA_BASELINE=1   skip assertions that only exist in the new interface and only capture screenshots.
"""
import functools
import os
import re
import shutil
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

web = Path(__file__).resolve().parents[1]
library = Path(os.environ.get('RHEA_LIBRARY_DIR') or web / 'src' / 'rhea' / 'library')
shots = Path(os.environ['RHEA_SHOTS_DIR']) if os.environ.get('RHEA_SHOTS_DIR') else None
baseline = os.environ.get('RHEA_BASELINE') == '1'
if shots:
    shots.mkdir(parents=True, exist_ok=True)

def body(path):
    text = path.read_text()
    if text.startswith('---'):
        text = text.split('---', 2)[2]
    return re.sub(r'<(script|style)>.*?</\1>', '', text, flags=re.S)

page_markup = body(library / 'TelegramLibrary.astro')
page_markup = page_markup.replace('{endpoint}', '"/api/rhea/telegram-mtproto"').replace('{String(autoLoad)}', '"false"')
page_markup = page_markup.replace('{animeMetadataEndpoint}', '"/api/rhea/anime-metadata"')
page_markup = re.sub(r'\{letters\.map\(.*?</button>\)\}', '', page_markup, flags=re.S)
page_markup = page_markup.replace('<AnimeEnrichment />', body(library / 'AnimeEnrichment.astro'))
assert 'enrich-form' in page_markup and 'forum-load' in page_markup, 'Telegram markup not found.'

site = Path(tempfile.mkdtemp(prefix='rhea-telegram-flow-'))
for item in library.glob('*.mjs'):
    shutil.copy(item, site / item.name)
shutil.copy(library / 'library.css', site / 'library.css')
tokens = (':root{--color-surface:#fff;--color-text-primary:#111;--color-text-muted:#555;--color-outline:#888;'
          '--color-outline-variant:#ccc;--color-accent:#1d6fb8;--color-on-accent:#fff;--color-text-heading:#000;color-scheme:light dark}'
          '@media (prefers-color-scheme:dark){:root{--color-surface:#16202c;--color-text-primary:#f2f6fb;'
          '--color-text-muted:#a9b6c6;--color-outline:#6f7f92;--color-outline-variant:#3a4a5d;--color-accent:#5aaaf0;'
          '--color-on-accent:#06121f;--color-text-heading:#fff}body{background:#0d141d}}'
          'body{margin:0;font:16px system-ui}.editorial-action{border:1px solid var(--color-outline);background:var(--color-surface);'
          'color:var(--color-text-primary);border-radius:.4rem;font:inherit}'
          '.rhea-primary{background:var(--color-accent);color:var(--color-on-accent);border-color:var(--color-accent)}')
modules = ['preview', 'mtproto-panel', 'forum-panel', 'mirror-panel', 'anime-metadata-panel', 'anime-enrichment-panel']
scripts = ''.join(f'<script type="module" src="/{name}.mjs"></script>' for name in modules)
(site / 'index.html').write_text(f'''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/library.css"><style>{tokens}</style><main class="library-main">{page_markup}</main>{scripts}''')

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(site)))
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'

GIB = 1_610_612_736  # 1.5 GiB per synthetic file
calls = []
lookups = []
state = {'lookup': [], 'local_closed': True}

def respond(route):
    request = route.request
    url = request.url
    if '/anime-metadata' in url:
        lookups.append(request.post_data_json)
        status, payload = state['lookup'].pop(0)
        route.fulfill(status=status, json=payload, headers={'Content-Type': 'application/json'})
        return
    operation = re.search(r'op=([a-z]+)', url).group(1)
    calls.append(operation)
    data = request.post_data_json if request.post_data else None
    if operation == 'status':
        route.fulfill(json={'state': 'connected'})
    elif operation == 'forumtopics':
        backup = data.get('scope') == 'backup'
        topics = [{'id': 8, 'title': 'Letra "T"'}] if backup else [
            {'id': 1, 'title': 'Requests'}, {'id': 12, 'title': 'Letter L'},
            {'id': 9, 'title': 'Letter T', 'closed': state['local_closed']}]
        route.fulfill(json={'state': 'forum_topics', 'forum': {
            'next': None, 'channelId': '11111' if backup else '22222', 'topics': topics, **({'scope': 'backup'} if backup else {})}})
    elif operation == 'forumpage':
        route.fulfill(json={'state': 'forum_page', 'forum': {'next': None, 'topicId': 1, 'channelId': '22222', 'posts': [
            {'id': 37, 'kind': 'document', 'filename': '[Fixture]_Tsuki_ga_Kirei_01_[1280x720].mkv', 'sizeBytes': GIB},
            {'id': 30, 'kind': 'document', 'filename': '[Fixture]_Tsuki_ga_Kirei_10_[1280x720][synthetic_release_tag_that_is_long_enough_to_force_wrapping_on_a_phone].mkv', 'sizeBytes': GIB}]}})
    elif operation == 'organizepreview':
        route.fulfill(json={'state': 'mirror_preview', 'mirror': {
            'approval': 'a' * 43, 'localDestination': 'Fixture group / Letter T', 'destination': 'Fixture backup / Letter T',
            'posts': [{'id': 37, 'label': 'Fixture E01'}, {'id': 30, 'label': 'Fixture E10'}]}})
    elif operation == 'organizeapprove':
        route.fulfill(json={'state': 'mirror_progress', 'mirror': {'total': 2, 'localCopies': [], 'copies': []}})
    elif operation == 'organizenext':
        step = calls.count('organizenext')
        done = [{'sourceId': 37, 'destinationId': 48}, {'sourceId': 30, 'destinationId': 49}]
        if step == 1:
            route.fulfill(json={'state': 'mirror_progress', 'mirror': {'total': 2, 'localCopies': done[:1], 'copies': []}})
        elif step == 2:
            route.fulfill(json={'state': 'mirror_progress', 'mirror': {'total': 2, 'localCopies': done, 'copies': done[:1]}})
        else:
            route.fulfill(json={'state': 'mirror_done', 'mirror': {'total': 2, 'localCopies': done, 'copies': done}})
    else:
        route.fulfill(status=404, json={'state': 'unexpected'})

candidate = {'titles': ['Tsuki ga Kirei'], 'episodes': 12, 'year': 2017, 'format': 'TV', 'studios': ['feel.'], 'genres': ['Romance']}

def no_overflow(page, label):
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'horizontal overflow at ' + label

def small_targets(page):
    return page.evaluate("""() => [...document.querySelectorAll('#anime-enrichment button, #anime-enrichment select, #anime-enrichment input, #anime-enrichment summary')]
      .filter(el => el.offsetParent !== null).map(el => [el.id || el.textContent.trim().slice(0, 20), el.getBoundingClientRect().height])
      .filter(([, h]) => h < 43.5)""")

def reach_enrichment(page):
    page.goto(base)
    page.locator('#forum-load').click()
    page.locator('#forum-topic').select_option('1')
    expect(page.locator('#forum-status')).to_contain_text('2 arquivos disponíveis')
    page.locator('#forum-organize').click()
    expect(page.locator('#enrich-title')).to_have_value('Tsuki ga Kirei')

def snap(page, name):
    if shots:
        page.screenshot(path=str(shots / f'{name}.png'), full_page=True)

def run(playwright, name, viewport, scheme, mobile, reduced='reduce'):
    calls.clear(); lookups.clear()
    state['local_closed'] = True
    browser = playwright.chromium.launch()
    context = browser.new_context(viewport=viewport, is_mobile=mobile, has_touch=mobile, color_scheme=scheme, reduced_motion=reduced)
    context.route('**/api/rhea/**', respond)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    reach_enrichment(page)
    snap(page, f'{name}-1-start')
    if baseline:
        state['lookup'] = [(200, {'state': 'candidates', 'candidates': [candidate]})]
        page.locator('#enrich-search').click(force=True)
        page.locator('#enrich-candidates button').first.click(force=True)
        state['local_closed'] = False
        page.locator('#enrich-check-destinations').click(force=True)
        expect(page.locator('#enrich-destination-status')).to_contain_text('2 de 2')
        snap(page, f'{name}-2-result')
        no_overflow(page, name)
        browser.close()
        return

    steps = page.locator('#enrich-steps')
    expect(steps.locator('[aria-current="step"]')).to_contain_text('Buscar no AniList')

    # Timeout: clear message, retry label, manual continuation stays available, selection survives.
    state['lookup'] = [(504, {'state': 'provider_timeout'}), (200, {'state': 'candidates', 'candidates': [candidate]})]
    page.locator('#enrich-search').click()
    expect(page.locator('#enrich-status')).to_contain_text('demorou demais')
    expect(page.locator('#enrich-search')).to_have_text('Tentar novamente')
    expect(page.locator('#enrich-use-title')).to_be_enabled()
    expect(page.locator('#enrich-provider-search')).to_be_visible()
    expect(page.locator('#enrich-title')).to_have_value('Tsuki ga Kirei')
    snap(page, f'{name}-2-timeout')
    page.locator('#enrich-search').click()
    expect(page.locator('#enrich-candidates')).to_contain_text('Tsuki ga Kirei')
    expect(steps.locator('[aria-current="step"]')).to_contain_text('Confirmar obra')
    assert lookups == [{'title': 'Tsuki ga Kirei'}, {'title': 'Tsuki ga Kirei'}], lookups

    # Rate limit: the button waits for the provider's pause, then offers a retry.
    state['lookup'] = [(429, {'state': 'rate_limited', 'retryAfter': 1})]
    page.locator('#enrich-title').fill('Tsuki ga Kirei')  # editing must not skip a wait that has not started
    page.locator('#enrich-search').click()
    expect(page.locator('#enrich-status')).to_contain_text('pediu uma pausa')
    expect(page.locator('#enrich-search')).to_be_disabled()
    expect(page.locator('#enrich-search')).to_be_enabled(timeout=4000)
    expect(page.locator('#enrich-search')).to_have_text('Tentar novamente')

    state['lookup'] = [(200, {'state': 'candidates', 'candidates': [candidate]})]
    page.locator('#enrich-search').click()
    page.locator('#enrich-candidates button').first.click()
    expect(page.locator('#enrich-sum-work')).to_have_text('Tsuki ga Kirei')
    expect(page.locator('#enrich-sum-files')).to_have_text('2 arquivos · 3 GiB')
    expect(page.locator('#enrich-sum-letter')).to_have_text('T')
    expect(page.locator('#enrich-volume')).to_contain_text('3 GiB (3.221.225.472 bytes)')
    expect(steps.locator('[aria-current="step"]')).to_contain_text('Conferir destinos')
    snap(page, f'{name}-3-confirmed')

    # A closed topic is located but not ready; the operator gets its own message and the pilot note.
    page.locator('#enrich-check-destinations').click()
    expect(page.locator('#enrich-destinations')).to_contain_text('Letter T está fechado')
    expect(page.locator('#enrich-sum-destinations')).to_contain_text('Mesmo grupo: fechado · Backup: encontrado')
    expect(page.locator('#enrich-pilot-note')).to_be_visible()
    expect(page.locator('#enrich-publish')).to_be_hidden()
    state['local_closed'] = False
    page.locator('#enrich-check-destinations').click()
    expect(page.locator('#enrich-destination-status')).to_contain_text('2 de 2 destinos encontrados')
    expect(page.locator('#enrich-sum-destinations')).to_contain_text('Mesmo grupo: encontrado · Backup: encontrado')
    expect(steps.locator('[aria-current="step"]')).to_contain_text('Revisar publicação')
    snap(page, f'{name}-4-destinations')

    # Preview and approval never copy files; Escape returns focus to the review button.
    page.locator('#enrich-publish-review').click()
    expect(page.locator('#enrich-publish-dialog')).to_be_visible()
    page.keyboard.press('Escape')
    expect(page.locator('#enrich-publish-review')).to_be_focused()
    page.locator('#enrich-publish-review').click()
    snap(page, f'{name}-5-dialog')
    page.locator('#enrich-publish-approve').click()
    expect(page.locator('#enrich-publish-run')).to_be_visible()
    expect(page.locator('#enrich-publish-run')).to_be_focused()
    assert 'organizenext' not in calls, calls
    assert calls.count('organizepreview') == 2 and calls.count('organizeapprove') == 1, calls

    # Explicit run: the two destinations report separately and the pause stops the loop.
    page.locator('#enrich-publish-run').click()
    expect(page.locator('#enrich-publish-status')).to_contain_text('Cópia concluída.')
    expect(page.locator('#enrich-progress-local-text')).to_have_text('2 de 2 verificadas · concluído')
    expect(page.locator('#enrich-progress-backup-text')).to_have_text('2 de 2 verificadas · concluído')
    snap(page, f'{name}-6-done')

    no_overflow(page, name)
    assert small_targets(page) == [], small_targets(page)
    assert not errors, errors
    browser.close()

with sync_playwright() as playwright:
    run(playwright, 'mobile-light', {'width': 390, 'height': 844}, 'light', True)
    run(playwright, 'mobile-dark', {'width': 390, 'height': 844}, 'dark', True)
    run(playwright, 'tablet-light', {'width': 820, 'height': 1180}, 'light', True)
    run(playwright, 'desktop-dark', {'width': 1280, 'height': 900}, 'dark', False)
    if not baseline:
        # Motion is allowed here: transitions must not break the flow, and focus rings stay visible.
        run(playwright, 'mobile-motion', {'width': 390, 'height': 844}, 'light', True, reduced='no-preference')
print('Telegram flow smoke test passed.' if not baseline else 'Baseline screenshots captured.')
