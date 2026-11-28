"""Browser smoke test for the automatic letter rebuild (letter K: 206 + 23 + 14 = 243 publications).

The real markup and panel modules are served from a temporary directory, with every API answer mocked by
synthetic data and the page clock controlled by Playwright. It proves that a Telegram wait counts down by
itself, resumes the pending read exactly once at the deadline, keeps the context when the operator switches
letters or leaves, places several series by alphabetical order without asking and never copies anything.

Environment:
  RHEA_LIBRARY_DIR  library directory to serve (default: this checkout).
  RHEA_SHOTS_DIR    where to write screenshots (default: none).
  RHEA_BASELINE=1   only reproduce the frozen countdown of the old interface and capture screenshots.
  RHEA_BROWSER_PATH optional Chromium executable.
"""
import functools
import json
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


markup = body(library / 'TelegramLibrary.astro')
markup = markup.replace('{endpoint}', '"/api/relay/telegram-mtproto"').replace('{String(autoLoad)}', '"false"')
markup = markup.replace('{animeMetadataEndpoint}', '"/api/relay/anime-metadata"')
markup = markup.replace('/api/rhea/', '/api/relay/')
markup = re.sub(r'\{letters\.map\(.*?</button>\)\}', '', markup, flags=re.S)
markup = markup.replace('<AnimeEnrichment />', body(library / 'AnimeEnrichment.astro'))
site = Path(tempfile.mkdtemp(prefix='rhea-letter-rebuild-'))
for item in library.glob('*.mjs'):
    shutil.copy(item, site / item.name)
shutil.copy(library / 'library.css', site / 'library.css')
tokens = (':root{--color-surface:#fff;--color-text-primary:#111;--color-text-muted:#555;--color-outline:#888;'
          '--color-outline-variant:#ccc;--color-accent:#1d6fb8;--color-on-accent:#fff;--color-text-heading:#000}'
          'body{margin:0;font:16px system-ui}.editorial-action{border:1px solid var(--color-outline);background:var(--color-surface);'
          'color:var(--color-text-primary);border-radius:.4rem;font:inherit;min-height:44px}'
          '.relay-primary,.rhea-primary{background:var(--color-accent);color:var(--color-on-accent);border-color:var(--color-accent)}')
modules = ['preview', 'mtproto-panel', 'forum-panel', 'mirror-panel', 'anime-metadata-panel', 'anime-enrichment-panel']
scripts = ''.join(f'<script type="module" src="/{name}.mjs"></script>' for name in modules if (site / f'{name}.mjs').exists())
(site / 'index.html').write_text(f'''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/library.css"><style>{tokens}</style><main class="library-main">{markup}</main>{scripts}''')


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(site)))
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'

# ---------------------------------------------------------------- synthetic fixture (no real names or files)
doc = lambda id, name: {'id': id, 'kind': 'document', 'filename': name, 'sizeBytes': 1_000_000}
CURRENT_WORKS = [('Kabuki Line', 26), ('Kaede Path', 26), ('Kamome Bay', 26), ('Kenzan Story', 26),
                 ('Kiseki Road', 26), ('Koyomi Days', 26), ('Kuon Garden', 25), ('Kyrie Note', 25)]
letter_k = []
next_id = 2001
for title, count in CURRENT_WORKS:
    for episode in range(1, count + 1):
        letter_k.append(doc(next_id, f'[Fixture] {title} - {episode:02d} [1080p].mkv'))
        next_id += 1
assert len(letter_k) == 206
requests = ([doc(1000 + n, f'[Fixture] Kanade Sky - {n:02d} [1080p].mkv') for n in range(1, 24)] +
            [doc(1100 + n, f'[Fixture] Kotone Field S02E{n:02d} [1080p].mkv') for n in range(1, 15)] +
            [doc(1200 + n, f'[Fixture] Tsuki ga Kirei - {n:02d} [720p].mkv') for n in range(1, 3)])
letter_t = [doc(3001, '[Fixture] Tapestry - 01 [BD].mkv'), doc(3002, '[Fixture] Tapestry - 02 [BD].mkv')]
TOPICS = {1: requests, 30: letter_k, 9: letter_t, 31: [], 41: []}
PAGES = {1: 20, 30: 100, 9: 100}

calls = []
lookups = []
held = []
state = {}


def fresh_state(**changes):
    state.clear()
    state.update({'waits': {}, 'fail': {}, 'hold': set(), 'backup_closed': False, 'lookup': {},
                  'lookup_waits': {}, 'lookup_hold': set()})
    state.update(changes)
    calls.clear(); lookups.clear(); held.clear()


def page_of(topic, cursor):
    posts = sorted(TOPICS[topic], key=lambda post: -post['id'])
    size = PAGES.get(topic, 100)
    start = int(cursor[1:]) if cursor else 0
    chunk = posts[start:start + size]
    following = 'p' + str(start + size) if start + size < len(posts) else None
    return {'state': 'forum_page', 'forum': {'next': following, 'topicId': topic, 'channelId': '22222', 'posts': chunk}}


def respond(route):
    request = route.request
    url = request.url
    if '/anime-metadata' in url:
        data = request.post_data_json
        lookups.append(data)
        provider = data.get('provider', 'anilist')
        if provider == 'mal' and not data.get('malClientId') and not state.get('mal_binding'):
            route.fulfill(status=503, json={'state': 'provider_unconfigured'})
            return
        key = (provider, data.get('title'))
        if key in state['lookup_hold']:
            state['lookup_hold'].discard(key)
            held.append((route, key))
            return
        wait = state['lookup_waits'].pop(key, None)
        if wait is not None:
            route.fulfill(status=429, json={'state': 'rate_limited', **({'retryAfter': wait} if wait else {})})
            return
        answer = state['lookup'].get(key) or state['lookup'].get(provider)
        status, payload = answer if answer else (200, {'state': 'candidates', 'candidates': []})
        route.fulfill(status=status, json=payload)
        return
    operation = re.search(r'op=([a-z]+)', url).group(1)
    data = request.post_data_json if request.post_data else {}
    key = (operation, data.get('topicId') or data.get('scope'), data.get('cursor'))
    calls.append(key)
    if key in state['hold']:
        state['hold'].discard(key)
        held.append((route, key))
        return
    wait = state['waits'].pop(key, None)
    if wait is not None:
        route.fulfill(status=429, json={'state': 'rate_limited', **({'retryAfter': wait} if wait else {})})
        return
    failure = state['fail'].pop(key, None)
    if failure:
        route.fulfill(status=failure[0], json={'state': failure[1]})
        return
    if operation == 'status':
        route.fulfill(json={'state': 'connected'})
    elif operation == 'forumtopics':
        if data.get('scope') == 'backup':
            route.fulfill(json={'state': 'forum_topics', 'forum': {'next': None, 'channelId': '11111', 'scope': 'backup', 'topics': [
                {'id': 80, 'title': 'Letra "K"', 'closed': state['backup_closed']}, {'id': 81, 'title': 'Letra "T"'}]}})
        else:
            route.fulfill(json={'state': 'forum_topics', 'forum': {'next': None, 'channelId': '22222', 'topics': [
                {'id': 1, 'title': 'Requests'}, {'id': 30, 'title': 'Letter K'}, {'id': 31, 'title': 'Letter K [NEW]'},
                {'id': 9, 'title': 'Letter T'}, {'id': 41, 'title': 'Letter T [NEW]'}]}})
    elif operation == 'forumpage':
        route.fulfill(json=page_of(data['topicId'], data.get('cursor')))
    elif operation == 'rebuildpreview':
        assert data['backupTopicId'] == 80, data
        order = [post['id'] for post in letter_k]
        for insertion in reversed(data['insertions']):
            at = order.index(insertion['beforeId'])
            order[at:at] = insertion['ids']
        route.fulfill(json={'state': 'mirror_preview', 'mirror': {
            'approval': 'fixture', 'source': 'Letter K', 'localDestination': 'Letter K [NEW]',
            'destination': 'Letra "K"', 'posts': [{'id': id, 'label': 'Publicação'} for id in order]}})
    else:
        route.fulfill(status=404, json={'state': 'unexpected'})


def telegram(topic=None, operation='forumpage'):
    return [call for call in calls if call[0] == operation and (topic is None or call[1] == topic)]


def copies():
    return [call for call in calls if call[0].startswith('organize') or call[0].startswith('mirror')]


def no_overflow(page, label):
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'horizontal overflow at ' + label


def snap(page, name):
    if shots:
        page.screenshot(path=str(shots / f'{name}.png'), full_page=False)


def snap_element(page, selector, name):
    if shots:
        page.locator(selector).screenshot(path=str(shots / f'{name}.png'))


def launch(playwright, viewport={'width': 390, 'height': 844}, mobile=True):
    browser = playwright.chromium.launch(executable_path=os.environ.get('RHEA_BROWSER_PATH'),
                                         args=['--single-process'] if os.environ.get('RHEA_BROWSER_PATH') else [])
    context = browser.new_context(viewport=viewport, is_mobile=mobile, has_touch=mobile, reduced_motion='reduce')
    context.route('**/api/relay/**', respond)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.install(time=1_800_000_000)  # seconds
    return browser, page, errors


def open_requests(page):
    page.goto(base)
    page.locator('#forum-load').click()
    page.locator('#forum-topic').select_option('1')
    expect(page.locator('#forum-organize')).to_be_visible()
    page.locator('#forum-organize').click()
    expect(page.locator('#enrich-letter-options')).to_contain_text('Letra K')
    # From here on, time only moves when the test moves it.
    now = page.evaluate('Date.now()')
    page.clock.pause_at((now + 1_000) / 1000)
    return now + 1_000


def set_hidden(page, hidden):
    page.evaluate("""hidden => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    }""", hidden)


countdown = lambda page: page.locator('#enrich-rebuild-wait-timer')
MAL = 'c' * 32
mal_kanade = {'id': 501, 'provider': 'mal', 'titles': ['Kanade Sky'], 'url': 'https://myanimelist.net/anime/501',
              'format': 'TV', 'year': 2021, 'episodes': 23, 'studios': ['Fixture Studio'], 'genres': []}
mal_kotone = [{'id': 601, 'provider': 'mal', 'titles': ['Kotone Field'], 'url': 'https://myanimelist.net/anime/601',
               'format': 'TV', 'year': 2019, 'episodes': 12, 'studios': ['Fixture Studio'], 'genres': []},
              {'id': 602, 'provider': 'mal', 'titles': ['Kotone Field 2nd Season'], 'url': 'https://myanimelist.net/anime/602',
               'format': 'TV', 'year': 2022, 'episodes': 14, 'studios': ['Fixture Studio'], 'genres': []}]
report = {}


def scenario_letter_k(playwright, viewport, mobile, label):
    fresh_state(waits={('forumpage', 30, None): 12}, lookup={
        'anilist': (503, {'state': 'provider_refused'}),
        ('mal', 'Kanade Sky'): (200, {'state': 'candidates', 'candidates': [mal_kanade]}),
        ('mal', 'Kotone Field'): (200, {'state': 'candidates', 'candidates': mal_kotone}),
    })
    browser, page, errors = launch(playwright, viewport, mobile)
    start = open_requests(page)
    expect(page.locator('#enrich-rebuild-provider')).to_have_value('mal')
    page.locator('#enrich-provider').select_option('anilist')
    page.get_by_role('button', name='Revisar letra K').click()
    expect(page.locator('#enrich-rebuild')).to_be_visible()
    expect(page.locator('#enrich-current-inventory')).to_have_text('A leitura de Letter K está em pausa.')
    expect(countdown(page)).to_have_text('Retomada automática em 00:12')
    before = len(telegram())
    rpc = lambda: len([call for call in calls if call[0] != 'status'])
    report['telegram_rpc_before_wait'] = rpc()
    # The shared pause also holds the rest of Requests and the backup check: one countdown names all three.
    expect(page.locator('#enrich-rebuild-wait-status')).to_have_text(
        'O Telegram pediu uma pausa. A RHEA retoma sozinha ao fim da espera: Letter K, Requests e backup.')
    expect(page.locator('#enrich-rebuild-requests')).to_have_text('A leitura de Requests está em pausa.')
    expect(page.locator('#enrich-backup-status')).to_have_text('A conferência do backup está em pausa.')
    assert not page.locator('#enrich-rebuild-review').is_visible(), 'no manual "build preview" button in the normal path'
    snap(page, f'{label}-1-wait-12')
    if label == 'mobile':
        snap_element(page, '#enrich-rebuild', 'mobile-rebuild-wait-12-section')
    # The ticks never move focus or redraw the panel.
    page.locator('#enrich-rebuild-select-all').focus()
    page.clock.run_for(5_000)
    expect(countdown(page)).to_have_text('Retomada automática em 00:07')
    expect(page.locator('#enrich-rebuild-select-all')).to_be_focused()
    snap(page, f'{label}-2-wait-07')
    # Suspension: the tab sleeps 4 s without timers; on return the value comes from the clock.
    set_hidden(page, True)
    page.clock.set_system_time((start + 9_000) / 1000)
    set_hidden(page, False)
    expect(countdown(page)).to_have_text('Retomada automática em 00:03')
    assert len(telegram()) == before, ('no Telegram call before the deadline', calls)

    # Metadata does not wait for the Telegram: AniList refuses, MyAnimeList is offered and configured inline.
    expect(page.locator('#enrich-rebuild-lookup')).to_contain_text('AniList recusou')
    page.locator('#enrich-rebuild-lookup-actions').get_by_role('button', name='Usar MyAnimeList').click()
    expect(page.locator('#enrich-rebuild-lookup')).to_contain_text('Configurar MyAnimeList')
    page.locator('#enrich-rebuild-lookup-actions').get_by_role('button', name='Configurar MyAnimeList').click()
    expect(page.locator('#mal-client-id')).to_be_focused()
    page.locator('#mal-client-id').fill(MAL)
    page.locator('#mal-client-form button[type="submit"]').click()
    expect(page.locator('#enrich-rebuild-options')).to_contain_text('Ficha do MyAnimeList')
    kotone = page.get_by_label('Edição no MyAnimeList')
    expect(kotone).to_have_count(1)
    kotone.select_option(index=2)
    expect(page.locator('#enrich-rebuild-options')).to_contain_text('confirmada por você')
    assert all(item.get('provider') == 'mal' and item.get('malClientId') == MAL for item in lookups if item.get('provider') == 'mal' and item.get('malClientId')), lookups
    assert len(telegram()) == before, ('metadata never reads Telegram', calls)

    page.clock.run_for(3_000)
    expect(page.locator('#enrich-rebuild-wait')).to_be_hidden()
    expect(page.locator('#enrich-current-inventory')).to_have_text('Letter K · 206 publicações lidas.')
    expect(page.locator('#enrich-rebuild-requests')).to_contain_text('Requests lido por completo · 39 publicações.')
    expect(page.locator('#enrich-backup-status')).to_contain_text('Backup encontrado')
    letter_reads = [call for call in telegram(30)]
    assert letter_reads == [('forumpage', 30, None), ('forumpage', 30, None), ('forumpage', 30, 'p100'), ('forumpage', 30, 'p200')], letter_reads
    report['telegram_rpc_during_wait'] = 0
    report['telegram_rpc_after_wait'] = rpc() - report['telegram_rpc_before_wait']
    report['letter_k_reads'] = letter_reads

    expect(page.locator('#enrich-limit-total')).to_contain_text('243 de 480 publicações · 206 na letra atual')
    expect(page.locator('#enrich-limit-intake')).to_contain_text('37 de 60 arquivos')
    expect(page.locator('#enrich-position-badge')).to_have_text('Posições automáticas · ordem alfabética')
    rows = page.locator('#enrich-rebuild-neighbors li')
    expect(rows).to_have_count(2)
    expect(rows.nth(0)).to_contain_text('Kanade Sky → depois de Kamome Bay, antes de Kenzan Story')
    expect(rows.nth(1)).to_contain_text('Kotone Field → depois de Kiseki Road, antes de Koyomi Days')
    expect(page.locator('#enrich-rebuild-status')).to_contain_text('Prévia completa')
    expect(page.locator('#enrich-publish-review')).to_be_visible()
    page.locator('.library-rebuild-order > summary').click()
    expect(page.locator('#enrich-rebuild-items')).to_contain_text('Kanade Sky · Série · 2021 · 23 episódios')
    expect(page.locator('#enrich-rebuild-items')).to_contain_text('Kotone Field 2nd Season · Série · 2022 · 14 episódios')
    snap(page, f'{label}-3-preview-ready')

    # Unchecking and checking a series reuses the pages: no Telegram call, and the confirmed ficha stays.
    reads = len(telegram())
    box = page.locator('[data-series] input[type="checkbox"]').nth(1)
    box.focus()
    page.keyboard.press('Space')
    expect(box).to_be_focused()
    expect(box).not_to_be_checked()
    expect(page.locator('#enrich-limit-total')).to_contain_text('229 de 480')
    page.locator('#enrich-rebuild-adjust').click()
    page.locator('#enrich-rebuild-anchor').select_option('end')
    page.evaluate("() => document.querySelector('[data-rhea-telegram-library]').dispatchEvent(new Event('rhea:forum-inventory-change'))")
    expect(page.locator('#enrich-position-badge')).to_have_text('Posição escolhida por você')
    expect(page.locator('#enrich-rebuild-anchor')).to_have_value('end')
    box.focus()
    page.keyboard.press('Space')
    expect(page.locator('#enrich-limit-total')).to_contain_text('243 de 480')
    expect(page.locator('#enrich-rebuild-options')).to_contain_text('confirmada por você')
    # A refreshed Requests inventory keeps the letter, the backup and the fichas.
    page.evaluate("() => document.querySelector('[data-rhea-telegram-library]').dispatchEvent(new Event('rhea:forum-inventory-change'))")
    expect(page.locator('#enrich-rebuild-items')).to_contain_text('2nd Season')
    expect(page.locator('#enrich-publish-review')).to_be_visible()
    page.clock.run_for(120_000)
    assert len(telegram()) == reads, calls
    assert copies() == [], ('preview never copies', calls)
    no_overflow(page, label)
    assert not errors, errors
    browser.close()


def scenario_context(playwright):
    # A held K read, then the operator switches to T: the late K answer must not touch the screen.
    fresh_state(hold={('forumpage', 30, None)})
    browser, page, errors = launch(playwright)
    open_requests(page)
    page.get_by_role('button', name='Revisar letra K').click()
    expect(page.locator('#enrich-current-inventory')).to_contain_text('Lendo Letter K')
    page.get_by_role('button', name='Revisar letra T').click()
    expect(page.locator('#enrich-rebuild-targets')).to_contain_text('Letter T [NEW]')
    route, _ = held.pop()
    try:
        route.fulfill(json=page_of(30, None))
    except Exception:
        pass  # the aborted request may already be gone
    expect(page.locator('#enrich-current-inventory')).to_have_text('Letter T · 2 publicações lidas.')
    expect(page.locator('#enrich-rebuild-targets')).to_contain_text('Letter T')
    assert 'Letter K' not in page.locator('#enrich-rebuild').inner_text()

    # A wait on T, then a switch to K: the T resume is cancelled, K waits for the same shared deadline.
    fresh_state(waits={('forumpage', 9, None): 6})
    page.get_by_role('button', name='Revisar letra T').click()
    expect(countdown(page)).to_contain_text('00:06')
    page.get_by_role('button', name='Revisar letra K').click()
    expect(page.locator('#enrich-rebuild-wait-status')).to_contain_text('espera: Letter K e backup.')
    expect(countdown(page)).to_contain_text('00:06')
    page.clock.run_for(7_000)
    expect(page.locator('#enrich-current-inventory')).to_have_text('Letter K · 206 publicações lidas.')
    assert telegram(9) == [('forumpage', 9, None)], calls

    # No deadline given: no invented seconds, no loop, a contextual retry.
    fresh_state(waits={('forumpage', 9, None): 0})
    page.get_by_role('button', name='Revisar letra T').click()
    expect(page.locator('#enrich-current-inventory')).to_contain_text('sem informar o prazo')
    expect(page.locator('#enrich-rebuild-review')).to_have_text('Tentar leitura novamente')
    page.clock.run_for(60_000)
    assert telegram(9) == [('forumpage', 9, None)], calls
    page.locator('#enrich-rebuild-review').click()
    expect(page.locator('#enrich-current-inventory')).to_have_text('Letter T · 2 publicações lidas.')

    # Expired permission: an explanation and the same retry, never a loop.
    fresh_state(fail={('forumpage', 30, None): (401, 'access_required')})
    page.get_by_role('button', name='Revisar letra K').click()
    expect(page.locator('#enrich-current-inventory')).to_contain_text('Sua sessão expirou')
    expect(page.locator('#enrich-rebuild-review')).to_be_visible()
    page.clock.run_for(60_000)
    assert len(telegram(30)) == 1, calls

    # Leaving the tab during a wait cancels the resumption.
    fresh_state(waits={('forumpage', 9, None): 5})
    page.get_by_role('button', name='Revisar letra T').click()
    expect(countdown(page)).to_contain_text('00:05')
    page.evaluate("() => document.querySelector('[data-rhea-telegram-library]').dispatchEvent(new Event('rhea:telegram-hide'))")
    page.clock.run_for(10_000)
    assert telegram(9) == [('forumpage', 9, None)], calls
    assert copies() == [], calls
    assert not errors, errors
    browser.close()


def scenario_backup_closed(playwright):
    fresh_state(backup_closed=True)
    browser, page, errors = launch(playwright)
    open_requests(page)
    page.get_by_role('button', name='Revisar letra K').click()
    expect(page.locator('#enrich-backup-status')).to_contain_text('está fechado')
    expect(page.locator('#enrich-backup-include')).to_be_checked()
    expect(page.locator('#enrich-backup-retry')).to_be_visible()
    expect(page.locator('#enrich-rebuild-status')).to_contain_text('Backup')
    expect(page.locator('#enrich-publish')).to_be_hidden()
    state['backup_closed'] = False
    page.locator('#enrich-backup-retry').click()
    expect(page.locator('#enrich-backup-status')).to_contain_text('Backup encontrado')
    expect(page.locator('#enrich-publish-review')).to_be_visible()
    # Unchecking the backup is the operator's choice and changes the plan.
    page.locator('#enrich-backup-include').uncheck()
    expect(page.locator('#enrich-backup-status')).to_contain_text('foi desmarcada')
    expect(page.locator('#enrich-publish-review')).to_be_visible()
    assert copies() == [], calls
    snap(page, 'mobile-4-backup')
    no_overflow(page, 'backup')
    assert not errors, errors
    browser.close()


def scenario_metadata_queue(playwright):
    kanade = ('mal', 'Kanade Sky')
    kotone = ('mal', 'Kotone Field')
    fresh_state(lookup_hold={kanade}, lookup_waits={kotone: 7}, mal_binding=True)
    browser, page, errors = launch(playwright)
    open_requests(page)
    upload = page.locator('#forum-reference')
    reference = requests[0]['filename'].removesuffix('.mkv')
    upload.set_input_files({'name': 'corrections.md', 'mimeType': 'text/markdown',
                            'buffer': ('## Kanade Sky\n' + reference).encode()})
    expect(page.locator('#forum-reference-status')).to_contain_text('1 nome de referência carregado')
    upload.set_input_files({'name': 'invalid.md', 'mimeType': 'text/markdown', 'buffer': b'# Empty'})
    expect(page.locator('#forum-reference-status')).to_contain_text('A referência anterior continua em uso.')
    page.get_by_role('button', name='Revisar letra K').click()
    expect(page.locator('#enrich-rebuild-requests')).to_contain_text('Requests lido por completo')
    expect(page.locator('#enrich-backup-status')).to_contain_text('Backup encontrado')
    expect(page.locator('#enrich-rebuild-options')).to_contain_text('Consultando MyAnimeList')
    page.locator('#enrich-publish-review').click()
    dialog = page.locator('#enrich-publish-dialog')
    expect(dialog).to_be_visible()
    route, key = held.pop()
    assert key == kanade
    route.fulfill(json={'state': 'candidates', 'candidates': [mal_kanade]})
    expect(page.locator('#enrich-rebuild-options')).to_contain_text('Ficha do MyAnimeList')
    expect(page.locator('#enrich-rebuild-lookup')).to_contain_text('retomada automaticamente')
    assert [item['title'] for item in lookups] == ['Kanade Sky', 'Kotone Field'], lookups
    rpc_count = len(calls)
    page.clock.run_for(6_000)
    assert len(lookups) == 2 and len(calls) == rpc_count
    page.clock.run_for(1_000)
    expect(page.locator('#enrich-rebuild-options')).to_contain_text('Sem ficha encontrada')
    assert [item['title'] for item in lookups] == ['Kanade Sky', 'Kotone Field', 'Kotone Field'], lookups
    expect(dialog).to_be_visible()
    assert len(calls) == rpc_count
    assert not errors, errors
    browser.close()


def scenario_backup_unconfigured(playwright):
    fresh_state(fail={('forumtopics', 'backup', None): (503, 'forum_disabled')})
    browser, page, errors = launch(playwright)
    open_requests(page)
    page.get_by_role('button', name='Revisar letra K').click()
    expect(page.locator('#enrich-backup-status')).to_contain_text('precisa ser autorizado')
    expect(page.locator('#enrich-backup-include')).to_be_checked()
    expect(page.locator('#enrich-publish')).to_be_hidden()
    page.locator('#enrich-backup-include').uncheck()
    expect(page.locator('#enrich-publish-review')).to_be_visible()
    page.locator('#enrich-backup-include').check()
    expect(page.locator('#enrich-publish')).to_be_hidden()
    page.locator('#enrich-backup-retry').click()
    expect(page.locator('#enrich-backup-status')).to_contain_text('Backup encontrado')
    expect(page.locator('#enrich-publish-review')).to_be_visible()
    assert copies() == [], calls
    assert not errors, errors
    browser.close()


def scenario_baseline(playwright):
    # The old interface: the letter notice keeps the first number until the operator taps the preview button.
    fresh_state(waits={('forumpage', 30, None): 12})
    browser, page, errors = launch(playwright)
    open_requests(page)
    page.get_by_role('button', name='Revisar letra K').click()
    expect(page.locator('#enrich-current-inventory')).to_contain_text('12 s')
    snap(page, 'before-1-wait-12')
    snap_element(page, '#enrich-rebuild', 'before-rebuild-wait-section')
    page.clock.run_for(5_000)
    snap(page, 'before-2-after-5s')
    frozen = page.locator('#enrich-current-inventory').inner_text()
    page.clock.run_for(8_000)
    report['baseline'] = {'after_5s': frozen, 'after_13s': page.locator('#enrich-current-inventory').inner_text(),
                          'letter_reads': len(telegram(30))}
    browser.close()


with sync_playwright() as playwright:
    if baseline:
        scenario_baseline(playwright)
    else:
        scenario_letter_k(playwright, {'width': 390, 'height': 844}, True, 'mobile')
        scenario_letter_k(playwright, {'width': 1280, 'height': 900}, False, 'desktop')
        scenario_context(playwright)
        scenario_backup_closed(playwright)
        scenario_metadata_queue(playwright)
        scenario_backup_unconfigured(playwright)
print(json.dumps(report))
print('Letter rebuild smoke test passed.' if not baseline else 'Baseline captured.')
