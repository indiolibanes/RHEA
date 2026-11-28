"""Browser smoke test for the Telegram organization path (Requests -> AniList -> destinations -> publication).

The real markup (TelegramLibrary.astro + AnimeEnrichment.astro) and the real panel modules are served from a
temporary directory, so no Astro build is needed. Every API response is mocked with synthetic data and no
network is used. Preview and approval must never send Telegram files; only the explicit run step copies.

Environment:
  RHEA_LIBRARY_DIR  library directory to serve (default: this checkout), used for the "before" screenshots.
  RHEA_SHOTS_DIR    where to write screenshots (default: none).
  RHEA_BASELINE=1   skip assertions that only exist in the new interface and only capture screenshots.
"""
import base64
import functools
import os
import re
import shutil
import tempfile
import threading
import time
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
state = {'backup': 'ok', 'lookup': [], 'local_closed': True, 'replacement': False, 'rebuild_blocked': False, 'rebuild_waits': [],
         'extra_intake': False, 'k_round': False, 'special': False, 'forum_id': '22222'}

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
        if state.get('topic_wait') and not backup:
            state['topic_wait'] = False
            route.fulfill(status=429, json={'state': 'rate_limited', 'retryAfter': 2})
            return
        if backup and state['backup'] == 'unconfigured':
            route.fulfill(status=409, json={'state': 'forum_disabled'})
            return
        topics = {'ok': [{'id': 8, 'title': 'Letra "T"'}], 'missing': [], 'closed': [{'id': 8, 'title': 'Letra "T"', 'closed': True}],
                  'duplicated': [{'id': 8, 'title': 'Letra "T"'}, {'id': 9, 'title': 'Letter T'}]}.get(state['backup'], []) if backup else [
            {'id': 1, 'title': 'Requests'}, {'id': 12, 'title': 'Letter L'},
            {'id': 9, 'title': 'Letter T', 'closed': state['local_closed']}]
        if not backup and state['replacement']:
            topics.append({'id': 81, 'title': 'Letter T [NEW]'})
        next_cursor = None
        if not backup and state['k_round']:
            if data['cursor'] is None:
                next_cursor = 'fixture-next-topics'
            else:
                assert data['cursor'] == 'fixture-next-topics'
                topics = [{'id': 11, 'title': 'Letter – “K”', 'closed': True}]
        route.fulfill(json={'state': 'forum_topics', 'forum': {
            'next': next_cursor, 'channelId': '11111' if backup else state['forum_id'], 'topics': topics, **({'scope': 'backup'} if backup else {})}})
    elif operation == 'forumpage':
        if data['topicId'] == 11:
            route.fulfill(json={'state': 'forum_page', 'forum': {'next': None, 'topicId': 11, 'channelId': '22222', 'posts': [
                {'id': 17, 'kind': 'document', 'filename': '[Fixture] Kumo Station - 01.mkv'},
                {'id': 16, 'kind': 'cover', 'heading': 'Kumo Station'},
            ]}})
            return
        if data['topicId'] == 9:
            route.fulfill(json={'state': 'forum_page', 'forum': {'next': None, 'topicId': 9, 'channelId': '22222', 'posts': [
                {'id': 19, 'kind': 'document', 'filename': '[Fixture] Tundra - 01.mkv'},
                {'id': 16, 'kind': 'document', 'filename': '[Fixture] Tapestry - 01.mkv'},
                {'id': 15, 'kind': 'cover', 'caption': 'Tapestry'},
            ]}})
            return
        extra = [
            {'id': 39, 'kind': 'document', 'filename': 'Tada-kun - 01.mkv', 'sizeBytes': GIB},
            {'id': 41, 'kind': 'document', 'filename': 'Tsuki ga Kirei - S02E01.mkv'},
            {'id': 42, 'kind': 'document', 'filename': 'Amber Archive - 01.mkv'},
        ] if state['extra_intake'] else []
        if state['special']:
            extra.append({'id': 40, 'kind': 'document', 'filename': '[Fixture] Tsuki ga Kirei - OVA [1080p].mkv'})
        if state['k_round']:
            extra.append({'id': 43, 'kind': 'document', 'filename': 'Kestrel Circuit - 01.mkv'})
        route.fulfill(json={'state': 'forum_page', 'forum': {'next': None, 'topicId': 1, 'channelId': state['forum_id'], 'posts': [
            *extra, {'id': 37, 'kind': 'document', 'filename': '[Fixture]_Tsuki_ga_Kirei_01_[1280x720].mkv', 'sizeBytes': GIB},
            {'id': 30, 'kind': 'document', 'filename': '[Fixture]_Tsuki_ga_Kirei_10_[1280x720][synthetic_release_tag_that_is_long_enough_to_force_wrapping_on_a_phone].mkv', 'sizeBytes': GIB}]}})
    elif operation.startswith('rebuild'):
        # The backup group's Letter topic (id 8) is the second destination whenever the plan includes it.
        dual = data.get('backupTopicId') == 8
        assert dual or 'backupTopicId' not in data, data
        names = {'source': 'Letter T + Requests', 'destination': 'Fixture backup / Letter T',
                 'localDestination': 'Fixture group / Letter T [NEW]'} if dual else {
                 'source': 'Letter T + Requests', 'destination': 'Letter T [NEW]'}
        copies = lambda order, n: [{'sourceId': id, 'destinationId': 100 + i} for i, id in enumerate(order[:n])]
        if state['extra_intake']:
            assert operation == 'rebuildpreview'
            assert data == {'sourceTopicId': 1, 'currentTopicId': 9, 'replacementTopicId': 81, 'backupTopicId': 8, 'beforeId': None,
                            # Files without a season marker count as the first season, so S02 follows them.
                            'letter': 'T', 'ids': [39, 37, 30, 41],
                            'insertions': [{'beforeId': 15, 'ids': [39]}, {'beforeId': 19, 'ids': [37, 30, 41]}]}
            order = [39, 15, 16, 37, 30, 41, 19]
            route.fulfill(json={'state': 'mirror_preview', 'mirror': {'total': len(order), 'approval': 'a' * 43,
                **names, 'posts': [{'id': id, 'label': 'Fixture'} for id in order]}})
            return
        assert {key: data[key] for key in ['sourceTopicId', 'currentTopicId', 'replacementTopicId', 'beforeId', 'ids']} == {
            'sourceTopicId': 1, 'currentTopicId': 9, 'replacementTopicId': 81, 'beforeId': 19, 'ids': [37, 30],
        }
        order = [15, 16, 37, 30, 19]
        if operation == 'rebuildpreview' and state['rebuild_blocked']:
            route.fulfill(status=409, json={'state': 'mirror_ineligible', 'issue': {
                'side': 'source', 'code': 'history_unverified',
            }})
        elif operation == 'rebuildpreview':
            route.fulfill(json={'state': 'mirror_preview', 'mirror': {'total': 5, 'approval': 'a' * 43,
                **names, 'posts': [{'id': id, 'label': 'Fixture'} for id in order]}})
        elif operation == 'rebuildapprove':
            assert data['confirm'] is True
            route.fulfill(json={'state': 'mirror_progress', 'mirror': {'total': 5, 'copies': [], **({'localCopies': []} if dual else {})}})
        elif state['rebuild_waits']:
            assert operation == 'rebuildnext'
            wait = state['rebuild_waits'].pop(0)
            route.fulfill(status=429, json={'state': 'rate_limited', 'retryAfter': wait,
                                           'retryAt': int(time.time() * 1000) + wait * 1000})
        else:
            assert operation == 'rebuildnext'
            route.fulfill(json={'state': 'mirror_done', 'mirror': {'total': 5, 'copies': copies(order, 5),
                **({'localCopies': copies(order, 5)} if dual else {})}})
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
      .filter(el => el.offsetParent !== null).map(el => [el.id || el.textContent.trim().slice(0, 20),
        (el.type === 'checkbox' && el.labels?.[0] ? el.labels[0] : el).getBoundingClientRect().height])
      .filter(([, h]) => h < 43.5)""")

def reach_enrichment(page, expected='Tsuki ga Kirei'):
    page.goto(base)
    page.locator('#forum-load').click()
    page.locator('#forum-topic').select_option('1')
    expect(page.locator('#forum-status')).to_contain_text('arquivos disponíveis')
    page.locator('#forum-organize').click()
    expect(page.locator('#enrich-title')).to_have_value(expected)

def snap(page, name):
    if shots:
        page.screenshot(path=str(shots / f'{name}.png'), full_page=True)

def run(playwright, name, viewport, scheme, mobile, reduced='reduce'):
    calls.clear(); lookups.clear()
    state['local_closed'] = True
    browser = playwright.chromium.launch(executable_path=os.environ.get('RHEA_BROWSER_PATH'),
                                          args=['--single-process'] if os.environ.get('RHEA_BROWSER_PATH') else [])
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
    expect(steps.locator('[aria-current="step"]')).to_contain_text('Consultar metadados')

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

    if name == 'mobile-light':
        # A separate provider request uses only the edited title and provider name.
        page.locator('#mal-settings > summary').click()
        page.locator('#mal-client-id').fill('a' * 32)
        page.get_by_role('button', name='Usar nesta sessão').click()
        expect(page.locator('#mal-client-id')).to_have_value('')
        expect(page.locator('#mal-client-status')).to_contain_text('Client ID pronto')
        page.locator('#enrich-provider').select_option('mal')
        state['lookup'] = [(200, {'state': 'candidates', 'candidates': [{
            **candidate, 'provider': 'mal', 'duration': 25, 'url': 'https://myanimelist.net/anime/1',
        }]})]
        page.locator('#enrich-search').click()
        page.locator('#enrich-candidates button').first.click()
        expect(page.locator('#enrich-match')).to_contain_text('MyAnimeList')
        expect(page.locator('#enrich-links a')).to_have_attribute('href', 'https://myanimelist.net/anime/1')
        assert lookups[-1] == {'title': 'Tsuki ga Kirei', 'provider': 'mal', 'malClientId': 'a' * 32}
        page.locator('#mal-client-clear').click()
        page.locator('#enrich-manual-open').click()
        page.locator('#enrich-manual input[name=link]').fill('https://anilist.co/anime/98202/Tsuki-ga-Kirei')
        state['lookup'] = [(503, {'state': 'provider_refused'})]
        page.get_by_role('button', name='Buscar pelo link').click()
        expect(page.locator('#enrich-status')).to_contain_text('O AniList recusou')
        expect(page.locator('#enrich-provider-search')).to_have_attribute('href', 'https://anilist.co/anime/98202')
        assert lookups[-1] == {'aniListId': 98202}
        state['lookup'] = [(200, {'state': 'candidates', 'candidates': [candidate]})]
        page.get_by_role('button', name='Buscar pelo link').click()
        expect(page.locator('#enrich-candidates button')).to_be_visible()
        previous_count = len(lookups)
        page.get_by_text('Usar uma captura como referência').click()
        pixel_data = page.evaluate("() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16; return canvas.toDataURL() }")
        pixel = base64.b64decode(pixel_data.split(',', 1)[1])
        paste_area = page.locator('#enrich-paste-area')
        paste_area.evaluate("""async (target, data) => {
            const blob = await (await fetch(data)).blob();
            const clipboard = new DataTransfer();
            clipboard.items.add(new File([blob], 'fixture.png', { type: blob.type }));
            target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
        }""", pixel_data)
        expect(page.locator('#enrich-capture-preview')).to_be_visible()
        expect(paste_area).to_have_value('')
        page.evaluate("""data => {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read: async () => [{
                types: ['image/png'], getType: async () => (await fetch(data)).blob()
            }] } });
        }""", pixel_data)
        page.locator('#enrich-capture-preview').evaluate("canvas => { canvas.hidden = true; }")
        page.get_by_role('button', name='Colar imagem', exact=True).click()
        expect(page.locator('#enrich-capture-preview')).to_be_visible()
        page.locator('#enrich-capture').set_input_files({'name': 'fixture.png', 'mimeType': 'image/png', 'buffer': pixel})
        expect(page.locator('#enrich-capture-preview')).to_be_visible()
        page.locator('#enrich-manual select[name=format]').select_option('TV')
        page.locator('#enrich-manual input[name=episodes]').fill('12')
        page.locator('#enrich-manual input[name=duration]').fill('25')
        page.get_by_role('button', name='Usar metadados preenchidos').click()
        expect(page.locator('#enrich-match')).to_contain_text('Dados preenchidos manualmente')
        expect(page.locator('#enrich-match')).to_contain_text('25 min por episódio')
        expect(page.locator('#enrich-links a')).to_have_attribute('href', 'https://anilist.co/anime/98202')
        assert len(lookups) == previous_count

        # The current Letter T remains intact; selecting an insertion point gates approval.
        state['replacement'] = True
        organization_calls = sum(call.startswith('organize') for call in calls)
        page.locator('#enrich-check-destinations').click()
        expect(page.locator('#enrich-rebuild-targets')).to_contain_text('Letter T + Requests → Letter T [NEW]')
        # The preview builds itself: there is no "build preview" button in the normal path.
        expect(page.locator('#enrich-rebuild-review')).to_be_hidden()
        expect(page.locator('#enrich-rebuild-items > li')).to_have_count(3)
        expect(page.locator('#enrich-rebuild-items summary').nth(0)).to_contain_text('Tapestry')
        expect(page.locator('#enrich-rebuild-items summary').nth(1)).to_contain_text('Tsuki ga Kirei')
        expect(page.locator('#enrich-rebuild-items summary').nth(2)).to_contain_text('Tundra')
        expect(page.locator('#enrich-rebuild-status')).to_contain_text('Prévia completa')
        expect(page.locator('#enrich-publish')).to_be_visible()
        assert sum(call.startswith('organize') for call in calls) == organization_calls
        expect(page.locator('#enrich-rebuild-anchor')).to_be_hidden()
        expect(page.locator('#enrich-position-badge')).to_contain_text('automática')
        expect(page.locator('#enrich-rebuild-neighbors li').nth(0)).to_contain_text('Antes')
        expect(page.locator('#enrich-rebuild-neighbors li').nth(1)).to_contain_text('Entra aqui')
        expect(page.locator('#enrich-rebuild-neighbors li').nth(1)).to_contain_text('Tsuki ga Kirei')
        expect(page.locator('#enrich-rebuild-neighbors li').nth(2)).to_contain_text('Tundra')
        expect(page.locator('#enrich-limit-intake')).to_contain_text('de 60')
        expect(page.locator('#enrich-limit-total')).to_contain_text('de 480')
        state['rebuild_blocked'] = True
        page.get_by_role('button', name='Revisar reconstrução').click()
        expect(page.locator('#enrich-publish-status')).to_contain_text('a leitura ficou incompleta')
        expect(page.locator('#enrich-publish-dialog')).to_be_hidden()
        state['rebuild_blocked'] = False
        page.get_by_role('button', name='Revisar reconstrução').click()
        expect(page.get_by_role('dialog', name='Aprovar reconstrução da letra')).to_be_visible()
        expect(page.locator('#enrich-publish-files > li').nth(2)).to_contain_text('#37')
        assert 'rebuildnext' not in calls
        page.locator('#enrich-publish-approve').click()
        expect(page.locator('#enrich-publish-run')).to_be_visible()
        assert 'rebuildnext' not in calls
        state['rebuild_waits'] = [2, 600, 2]
        page.locator('#enrich-publish-run').click()
        expect(page.locator('#enrich-publish-status')).to_contain_text('será retomada automaticamente nesta aba')
        expect(page.locator('#enrich-publish-run')).to_be_disabled()
        assert calls.count('rebuildnext') == 1
        page.get_by_role('button', name='Pausar retomada automática').click()
        expect(page.locator('#enrich-publish-status')).to_contain_text('Retomada automática pausada')
        expect(page.locator('#enrich-publish-run')).to_be_enabled(timeout=5000)
        assert calls.count('rebuildnext') == 1
        page.get_by_role('button', name='Retomar cópia').click()
        expect(page.locator('#enrich-publish-status')).to_contain_text('será retomada automaticamente nesta aba')
        saved_copy = "JSON.parse(localStorage.getItem('rhea:telegram:copy:v1:/api/rhea/telegram-mtproto'))"
        checkpoint = page.evaluate(saved_copy)
        assert set(checkpoint) == {'selection', 'retryAt', 'automatic'}
        assert set(checkpoint['selection']) == {'currentTopicId', 'sourceTopicId', 'replacementTopicId', 'backupTopicId', 'beforeId', 'letter', 'ids'}
        assert checkpoint['automatic'] is True
        page.reload()
        page.clock.set_system_time((checkpoint['retryAt'] - 210_000) / 1000)
        page.locator('[data-rhea-telegram-library]').dispatch_event('rhea:telegram-show')
        expect(page.locator('#enrich-publish-run')).to_have_text('Aguarde 210 s')
        expect(page.locator('#enrich-publish-run')).to_be_disabled()
        assert page.evaluate(saved_copy) == checkpoint
        assert calls.count('rebuildnext') == 2
        page.get_by_role('button', name='Reabrir cópia salva').click()
        expect(page.locator('#enrich-publish-status')).to_contain_text('será retomada automaticamente nesta aba')
        assert calls.count('rebuildnext') == 2
        page.clock.set_system_time(checkpoint['retryAt'] / 1000)
        expect(page.locator('#enrich-publish-status')).to_contain_text('Tópico [NEW]: 5 de 5', timeout=10000)
        assert calls.count('rebuildnext') == 4
        assert page.evaluate(saved_copy) is None
        # Both destinations report on their own, in text as well as in the bars.
        expect(page.locator('#enrich-progress-local-text')).to_have_text('5 de 5 verificadas · concluído')
        expect(page.locator('#enrich-progress-backup-text')).to_have_text('5 de 5 verificadas · concluído')
        expect(page.locator('#enrich-publish-status')).to_contain_text('Backup: 5 de 5 verificadas')
        state['extra_intake'] = True
        reach_enrichment(page, expected='Amber Archive')
        cards = page.locator('#enrich-letter-options li')
        expect(cards.locator('strong')).to_have_text(['Letra A · 1 série', 'Letra T · 2 séries'])
        expect(cards.first).to_contain_text('Sem tópico atual')
        expect(cards.last).to_contain_text('Tópico atual: Letter T')
        expect(cards.last).to_contain_text('Destino: Letter T [NEW]')
        assert calls[-2:] == ['forumtopics', 'forumpage'], calls[-3:]
        previous_count = len(lookups)
        state['lookup'] = [(200, {'state': 'candidates', 'candidates': [{**candidate, 'titles': ['Tada-kun']}]}),
                           (200, {'state': 'candidates', 'candidates': [candidate]})]
        page.get_by_role('button', name='Revisar letra T').click()
        expect(page.locator('#enrich-rebuild-legend')).to_contain_text('Séries da letra T')
        picks = page.locator('#enrich-rebuild-options')
        expect(picks.get_by_role('checkbox')).to_have_count(2)
        expect(picks.get_by_role('checkbox', name='Tsuki ga Kirei · 3 arquivos', exact=False)).to_be_visible()
        expect(picks.get_by_role('checkbox', name='Amber Archive', exact=False)).to_have_count(0)
        expect(page.locator('#enrich-rebuild-count')).to_have_text('2 séries · 4 arquivos')
        expect(page.locator('#enrich-rebuild-options small').first).to_contain_text('12 episódios')
        expect(page.locator('#enrich-rebuild-options small').last).to_contain_text('escolha a edição')
        expect(page.locator('#enrich-rebuild-neighbors li').first).to_contain_text('Tada-kun → no início, antes de Tapestry')
        expect(page.locator('#enrich-rebuild-neighbors li').last).to_contain_text('Tsuki ga Kirei → depois de Tapestry, antes de Tundra')
        expect(page.locator('#enrich-publish-review')).to_be_visible()
        reads = calls.count('forumpage')
        picks.get_by_role('checkbox', name='Tada-kun', exact=False).uncheck()
        expect(page.locator('#enrich-rebuild-neighbors li')).to_have_count(3)
        page.get_by_role('button', name='Limpar seleção').click()
        expect(page.locator('#enrich-rebuild-count')).to_have_text('Marque ao menos uma série para ver a prévia.')
        expect(page.locator('#enrich-publish')).to_be_hidden()
        page.get_by_role('button', name='Marcar todas').click()
        page.locator('#enrich-publish-review').click()
        expect(page.locator('#enrich-publish-files > li')).to_have_count(7)
        expect(page.locator('#enrich-publish-files')).not_to_contain_text('#42')
        assert calls.count('forumpage') == reads
        assert lookups[previous_count:] == [{'title': 'Tada-kun'}, {'title': 'Tsuki ga Kirei'}]
        page.get_by_role('dialog').get_by_role('button', name='Voltar').click()
        state['extra_intake'] = False
        state['replacement'] = False

        # A closed current topic is paired automatically before a replacement has been created.
        state['k_round'] = True
        topic_reads = calls.count('forumtopics')
        reach_enrichment(page, expected='Kestrel Circuit')
        expect(cards.first).to_contain_text('Tópico atual: Letter – “K”')
        expect(cards.first).to_contain_text('Destino [NEW] ausente')
        assert calls.count('forumtopics') == topic_reads + 2  # Initial inventory and its remaining topic page.
        state['lookup'] = [(503, {'state': 'provider_refused'})]
        page.get_by_role('button', name='Revisar letra K').click()
        expect(page.locator('#enrich-current-inventory')).to_contain_text('2 publicações lidas')
        expect(page.locator('#enrich-rebuild-items')).to_contain_text('Kumo Station')
        expect(page.locator('#enrich-rebuild-items summary').first).to_contain_text('Kestrel Circuit')
        expect(page.locator('#enrich-rebuild-items summary').last).to_contain_text('Kumo Station')
        expect(page.locator('#enrich-rebuild-lookup')).to_contain_text('O AniList recusou')
        expect(page.locator('#enrich-rebuild-status')).to_contain_text('crie um tópico [NEW]')
        expect(page.locator('#enrich-publish')).to_be_hidden()
        state['k_round'] = False

    # Correct a standalone extra with no metadata provider or publish operation.
    state['special'] = True
    reach_enrichment(page)
    page.locator('#forum-items').get_by_role('button', name='Editar no catálogo · Post #40').click()
    expect(page.locator('#correction-series')).to_be_focused()
    expect(page.locator('#correction-id')).to_have_value('40')
    expect(page.locator('#correction-id')).to_be_hidden()
    expect(page.locator('#correction-file')).to_contain_text('Tsuki ga Kirei - OVA')
    expect(page.locator('#correction-kind')).to_have_value('ova')
    expect(page.locator('#correction-season')).to_be_hidden()
    calls_before, lookups_before = len(calls), len(lookups)
    page.locator('#correction-series').select_option(label='Tsuki ga Kirei')
    page.get_by_role('button', name='Salvar correção').click()
    expect(page.locator('#correction-feedback')).to_have_text('Salvo neste navegador. Tsuki ga Kirei · OVA.')
    assert len(calls) == calls_before and len(lookups) == lookups_before
    # A post with the same ID in another forum keeps its own metadata.
    state['forum_id'] = '33333'
    reach_enrichment(page)
    expect(page.get_by_text('Posts sem série confirmada', exact=True)).to_be_visible()
    state['forum_id'] = '22222'
    # Navigation discards the live snapshot. Loading the original topic restores the exact correction.
    reach_enrichment(page)
    series = page.locator('#catalog-items summary').filter(has_text='Tsuki ga Kirei')
    series.click()
    expect(page.locator('#post-40')).to_contain_text('Arquivo · [Fixture] Tsuki ga Kirei - OVA [1080p].mkv')
    page.locator('#post-40').get_by_role('button', name='Editar no catálogo · Post #40').click()
    expect(page.locator('#correction-series')).to_have_value('forum-series-1')
    expect(page.locator('#correction-kind')).to_have_value('ova')
    page.get_by_role('button', name='Escolher outro post').click()
    expect(page.locator('#correction-id')).to_be_focused()
    page.get_by_role('button', name='Desfazer correção').click()
    expect(page.locator('#correction-feedback')).to_have_text('Correção removida do catálogo.')
    reach_enrichment(page)
    expect(page.get_by_text('Posts sem série confirmada', exact=True)).to_be_visible()
    state['special'] = False

    no_overflow(page, name)
    assert small_targets(page) == [], small_targets(page)
    assert not errors, errors
    browser.close()


def scenario_destination_wait(playwright):
    # All topic names, files and Telegram responses here are synthetic.
    state.update({'local_closed': False, 'replacement': False, 'topic_wait': False})
    calls.clear()
    browser = playwright.chromium.launch(executable_path=os.environ.get('RHEA_BROWSER_PATH'),
                                          args=['--single-process'] if os.environ.get('RHEA_BROWSER_PATH') else [])
    context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    context.route('**/api/rhea/**', respond)
    page = context.new_page()
    reach_enrichment(page)
    expect(page.locator('#enrich-letter-status')).to_contain_text('letra detectada')
    page.locator('#enrich-use-title').click()
    before = calls.count('forumtopics')
    state['topic_wait'] = True
    page.locator('#enrich-check-destinations').click()
    expect(page.locator('#enrich-destination-status')).to_contain_text('Telegram pediu uma pausa')
    expect(page.locator('#enrich-sum-destinations')).to_have_text('Consulta pausada · Backup não conferido')
    expect(page.locator('#enrich-destinations')).to_contain_text('Consulta pendente')
    expect(page.locator('#enrich-check-destinations')).to_be_disabled()
    assert calls.count('forumtopics') == before + 1, calls
    # Metadata edits cannot shorten the Telegram wait.
    page.locator('#enrich-use-title').click()
    expect(page.locator('#enrich-check-destinations')).to_be_disabled()
    expect(page.locator('#enrich-check-destinations')).to_be_enabled(timeout=5000)
    assert calls.count('forumtopics') == before + 1, calls
    state['replacement'] = True
    page.locator('#enrich-check-destinations').click()
    expect(page.locator('#enrich-destination-status')).to_contain_text('reconstrução foram encontrados')
    expect(page.locator('#enrich-destinations')).to_contain_text('Letter T [NEW]')
    assert not any(call.endswith(('preview', 'approve', 'next')) for call in calls), calls
    # A complete index already showing both topics must not be read again to identify the pair.
    reach_enrichment(page)
    expect(page.locator('#enrich-letter-options')).to_contain_text('Destino: Letter T [NEW]')
    before = calls.count('forumtopics')
    page.locator('#enrich-use-title').click()
    page.locator('#enrich-check-destinations').click()
    expect(page.locator('#enrich-destination-status')).to_contain_text('reconstrução foram encontrados')
    expect(page.locator('#enrich-destinations')).to_contain_text('Tópico atual (origem)')
    # Only the backup group's topic list is read now; the titular pair still comes from the complete index.
    # The letter reads run one at a time, so wait for the backup answer before counting.
    expect(page.locator('#enrich-backup-status')).to_contain_text('Backup encontrado')
    assert calls.count('forumtopics') == before + 1, calls
    assert not any(call.endswith(('preview', 'approve', 'next')) for call in calls), calls
    state['replacement'] = False
    browser.close()

def scenario_backup(playwright):
    calls.clear(); lookups.clear()
    state.update({'local_closed': False, 'replacement': True, 'rebuild_blocked': False, 'rebuild_waits': [], 'extra_intake': False, 'backup': 'missing'})
    browser = playwright.chromium.launch(executable_path=os.environ.get('RHEA_BROWSER_PATH'),
                                          args=['--single-process'] if os.environ.get('RHEA_BROWSER_PATH') else [])
    context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, reduced_motion='reduce')
    context.route('**/api/rhea/**', respond)
    page = context.new_page()
    reach_enrichment(page)
    page.locator('#enrich-use-title').click()
    page.locator('#enrich-check-destinations').click()
    expect(page.locator('#enrich-backup')).to_be_visible()
    # The backup was requested but its topic does not exist: say so and do not prepare any copy.
    expect(page.locator('#enrich-backup-status')).to_contain_text('Não há tópico Letter T neste grupo')
    expect(page.locator('#enrich-backup-retry')).to_be_visible()
    expect(page.locator('#enrich-rebuild-status')).to_contain_text('Backup: Não há tópico Letter T')
    expect(page.locator('#enrich-publish')).to_be_hidden()
    # A closed backup topic cannot receive posts either.
    state['backup'] = 'closed'
    page.locator('#enrich-backup-retry').click()
    expect(page.locator('#enrich-backup-status')).to_contain_text('está fechado')
    expect(page.locator('#enrich-publish')).to_be_hidden()
    # Fixing the topic makes the plan include it; unchecking is an explicit, visible choice.
    state['backup'] = 'ok'
    page.locator('#enrich-backup-retry').click()
    expect(page.locator('#enrich-backup-status')).to_contain_text('Backup encontrado: Letra "T"')
    expect(page.locator('#enrich-publish')).to_be_visible()
    page.locator('#enrich-backup-include').uncheck()
    expect(page.locator('#enrich-backup-status')).to_contain_text('O plano inclui apenas o grupo titular')
    page.locator('#enrich-publish-review').click()
    expect(page.locator('#enrich-publish-dialog')).to_be_visible()
    expect(page.locator('#enrich-publish-targets')).not_to_contain_text('Fixture backup')
    page.locator('#enrich-publish-dialog').get_by_role('button', name='Voltar').click()
    page.locator('#enrich-backup-include').check()
    expect(page.locator('#enrich-publish-targets')).not_to_contain_text('Fixture backup')
    page.locator('#enrich-publish-review').click()
    expect(page.locator('#enrich-publish-targets')).to_contain_text('Fixture backup / Letter T')
    expect(page.locator('#enrich-publish-targets')).to_contain_text('Fixture group / Letter T [NEW]')
    page.locator('#enrich-publish-dialog').get_by_role('button', name='Voltar').click()
    # An unconfigured backup still requires the operator to choose whether to continue without it.
    state['backup'] = 'unconfigured'
    reach_enrichment(page)
    page.locator('#enrich-use-title').click()
    page.locator('#enrich-check-destinations').click()
    expect(page.locator('#enrich-backup-status')).to_contain_text('precisa ser autorizado no Railway')
    expect(page.locator('#enrich-backup-include')).to_be_checked()
    expect(page.locator('#enrich-publish')).to_be_hidden()
    no_overflow(page, 'backup')
    snap(page, 'backup-unconfigured')
    assert not any(call.endswith(('approve', 'next')) for call in calls), calls
    state['backup'] = 'ok'
    state['replacement'] = False
    browser.close()

with sync_playwright() as playwright:
    if not baseline:
        scenario_destination_wait(playwright)
        scenario_backup(playwright)
    run(playwright, 'mobile-light', {'width': 390, 'height': 844}, 'light', True)
    run(playwright, 'mobile-dark', {'width': 390, 'height': 844}, 'dark', True)
    run(playwright, 'tablet-light', {'width': 820, 'height': 1180}, 'light', True)
    run(playwright, 'desktop-dark', {'width': 1280, 'height': 900}, 'dark', False)
    if not baseline:
        # Motion is allowed here: transitions must not break the flow, and focus rings stay visible.
        run(playwright, 'mobile-motion', {'width': 390, 'height': 844}, 'light', True, reduced='no-preference')
print('Telegram flow smoke test passed.' if not baseline else 'Baseline screenshots captured.')
