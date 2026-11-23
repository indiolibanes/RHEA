import json
import os
import functools
from pathlib import Path
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect

class QuietServer(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietServer, directory=str(Path(__file__).resolve().parents[1] / 'dist')))
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
account = 'mock-google-account'
connected = True
listing_error = False
status_pending = False
mcp_available = False
mcp_granted = True
requests = []
mtproto_calls = []
mirror_steps = 0
reservations = {}
files = []
seen = set()
root = {'id': 'rhea-root', 'name': 'RHEA', 'mimeType': 'application/vnd.google-apps.folder', 'size': None}

def mock(route):
    global files, status_pending, mcp_granted, mirror_steps
    request = route.request
    action = request.url.split('/api/rhea/', 1)[1].split('?', 1)[0]
    if action == 'telegram-mtproto':
        operation = request.url.split('?op=', 1)[1]
        mtproto_calls.append(operation)
        if operation.startswith('mirror'):
            if operation == 'mirrorpreview':
                route.fulfill(json={'state': 'mirror_preview', 'mirror': {
                    'total': 1, 'approval': 'a' * 43, 'expiresAt': 253402300799,
                    'source': 'Fixture origin / RHEA Mirror Test', 'destination': 'Fixture backup / RHEA Mirror Test',
                    'posts': [{'id': 11, 'kind': 'document', 'label': 'Synthetic clip.mkv'}],
                }})
            elif operation == 'mirrorapprove':
                assert request.post_data_json == {'confirm': True, 'approval': 'a' * 43}
                route.fulfill(json={'state': 'mirror_progress', 'mirror': {'total': 1, 'copies': []}})
            else:
                assert operation == 'mirrornext' and request.post_data is None
                mirror_steps += 1
                route.fulfill(json={'state': 'mirror_done', 'mirror': {'total': 1, 'copies': [
                    {'sourceId': 11, 'destinationId': 31},
                ]}})
            return
        states = {'status': 'disconnected', 'start': 'code', 'code': 'password', 'password': 'connected',
                  'inventory': 'inventory', 'disconnect': 'disconnected'}
        if operation == 'code':
            assert request.post_data_json == {'code': '12345'}
        elif operation == 'password':
            assert request.post_data_json == {'password': 'synthetic 2fa'}
        config_state = states[operation]
        if operation == 'status' and 'password' in mtproto_calls and 'disconnect' not in mtproto_calls:
            config_state = 'connected'
        payload = {'state': config_state}
        if operation == 'inventory':
            payload['inventory'] = {'channelId': '9876543210', 'revision': 'a' * 64, 'complete': True, 'messages': [
                {'id': 21, 'caption': 'Series: Solar Talon | S01E01'},
                {'id': 22, 'caption': 'Series: Kestrel Flight | S01E02'},
                {'id': 23, 'caption': 'Series: Kestrel Flight | S01E01'},
            ]}
        route.fulfill(status=200, json=payload)
        return
    requests.append(action)
    response = {}
    status = 200
    if action == 'telegram':
        assert request.method in ('GET', 'POST') and request.post_data is None
        response = {'state': 'ready' if request.method == 'GET' else 'verified'}
    elif action == 'anime-metadata':
        assert request.post_data_json == {'title': 'Synthetic title'}
        response = {'state': 'candidates', 'candidates': [{
            'titles': ['Synthetic title', 'Test alternate'], 'url': 'https://anilist.co/anime/27',
            'format': 'OVA', 'year': 2003, 'episodes': 2, 'genres': ['Drama'], 'studios': ['Test Studio'],
        }]}
    elif action == 'status':
        if status_pending:
            status_pending = False
            route.fulfill(status=503, json={'code': 'drive_refresh_pending'})
            return
        response = {'drive': True, 'queueOwner': 'synthetic-actor', 'accountId': account if connected else None,
                    'account': 'Mock Drive test account' if connected else None,
                    'persistentDrive': True, 'persistentSession': connected,
                    'sessionState': 'connected' if connected else 'absent'}
    elif action == 'files':
        if listing_error:
            status = 404
            response = {'error': 'O recurso não está disponível no Drive.'}
        else:
            response = {'files': files.copy(), 'folderId': root['id'], 'breadcrumbs': [root], 'page': ''}
    elif action == 'mcp-grants':
        if mcp_available:
            response = {'endpoint': 'https://mcp.example.test/mcp', 'grants': [
                {'id': 'synthetic-grant', 'client': 'ChatGPT', 'scope': 'rhea:read', 'provider': 'gpt',
                 'persistent': True, 'expires': 253402300799}] if mcp_granted else []}
        else:
            status = 503
    elif action == 'mcp-plans':
        response = {'plans': []}
    elif action == 'mcp-unlink':
        assert request.post_data_json == {'id': 'synthetic-grant'}
        mcp_granted = False
        response = {'revoked': True}
    elif action == 'bootstrap':
        response = {'folderId': root['id']}
    elif action == 'reserve':
        data = request.post_data_json
        ticket = 'res-' + data['name']
        reservations[ticket] = data
        response = {'reservation': ticket}
    elif action == 'start':
        ticket = request.headers['x-rhea-reservation']
        reservations['up-' + ticket] = reservations[ticket]
        response = {'ticket': 'up-' + ticket, 'chunkSize': 262144}
    elif action == 'chunk':
        data = reservations[request.headers['x-rhea-upload']]
        name = data['name']
        seen.add(name)
        if name == 'synthetic-4.txt':
            status = 403
            response = {'error': 'Simulated write refusal'}
        else:
            assert len(request.post_data_buffer) == data['size']
            file = {'id': 'fixture-' + name.replace('.', '-'), 'name': name, 'mimeType': data['mimeType'], 'size': data['size']}
            if file not in files:
                files.append(file)
            response = {'file': file}
    elif action == 'folder':
        new = {'id': 'new-folder', 'name': request.post_data_json['name'], 'mimeType': root['mimeType'], 'size': None}
        files.append(new)
        response = {'file': new}
    else:
        raise AssertionError(action)
    route.fulfill(status=status, json=response)

with sync_playwright() as playwright:
    args = ['--single-process', '--disable-dev-shm-usage', '--disable-gpu'] if os.environ.get('RHEA_BROWSER_SINGLE_PROCESS') else []
    browser = playwright.chromium.launch(executable_path=os.environ.get('RHEA_BROWSER_PATH'), args=args)
    context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
    context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=base)
    context.route('**/api/rhea/**', mock)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base + '/rhea/')
    expect(page).to_have_title('RHEA')
    expect(page.get_by_role('navigation', name='Navegação da RHEA')).to_be_visible()
    expect(page.get_by_role('heading', name='RHEA', exact=True)).to_be_visible()
    expect(page.locator('#drive-status')).to_contain_text('Conta conectada automaticamente')
    assert requests == ['status'], requests
    status_pending = True
    page.reload()
    expect(page.locator('#drive-status')).to_contain_text('Conta conectada automaticamente')
    assert 'connect' not in requests and requests.count('status') == 3, requests
    expect(page.locator('#h-arquivos')).to_have_count(0)
    listing_error = True
    page.locator('#drive-options summary').click()
    page.locator('#drive-check').click()
    expect(page.locator('#drive-check-status')).to_contain_text('A sessão Google está presente')
    expect(page.locator('#drive-status')).to_contain_text('Conta conectada')
    listing_error = False

    page.locator('.section-nav a[href="#assistente"]').click()
    expect(page.locator('#mcp-endpoint')).to_have_value('')
    expect(page.locator('#mcp-copy-prompt')).to_be_disabled()
    expect(page.locator('#assistant-mcp-state')).to_contain_text('indisponível')
    page.locator('#assistant-provider').select_option('gemini')
    expect(page.locator('#mcp-cli')).to_be_hidden()
    page.locator('#assistant-provider').select_option('gpt')
    mcp_available = True
    page.get_by_role('button', name='Atualizar conexões').click()
    expect(page.locator('#mcp-endpoint')).to_have_value('https://mcp.example.test/mcp')
    expect(page.locator('#mcp-copy-prompt')).to_be_enabled()
    expect(page.locator('#assistant-mcp-state')).to_contain_text('somente leitura')
    page.reload()
    expect(page.get_by_role('button', name='Revogar ChatGPT')).to_be_visible()
    page.get_by_role('button', name='Revogar ChatGPT').click()
    expect(page.locator('#mcp-notice')).to_contain_text('Nenhum assistente autorizado')
    expect(page.locator('#drive-status')).to_contain_text('Conta conectada automaticamente')
    for name, provider in [('ChatGPT', 'gpt'), ('Claude', 'claude'), ('Gemini CLI', 'gemini')]:
        page.locator('#assistant-provider').select_option(provider)
        page.locator('#mcp-copy-prompt').click()
        expect(page.locator('#mcp-copy-status')).to_contain_text('Mensagem copiada')
        assert name in page.evaluate('navigator.clipboard.readText()')
        assert 'RHEA' in page.evaluate('navigator.clipboard.readText()')
        assert 'rhea_list_folder' in page.evaluate('navigator.clipboard.readText()')
    expect(page.locator('#mcp-cli')).to_be_visible()
    expect(page.locator('#assistant-external')).to_have_attribute('href', 'https://geminicli.com/docs/tools/mcp-server/')
    expect(page.locator('#mcp-copy-url, #mcp-copy-setup, #mcp-copy-cli, #assistant-api')).to_have_count(0)
    assert 'rhea_organize_files' in page.evaluate('navigator.clipboard.readText()')
    page.locator('.section-nav a[href="#enviar"]').click()
    selection = [{'name': f'synthetic-{i}.txt', 'mimeType': 'text/plain', 'buffer': b'synthetic original bytes'} for i in range(10)]
    page.locator('#file-input').set_input_files(selection)
    expect(page.locator('#upload-summary')).to_contain_text('9 sincronizados · 0 pendentes · 1 falhas')
    assert len(seen) == 10
    assert page.locator('#upload-batches a').count() == 9
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')

    connected = False
    page.reload()
    expect(page.locator('#drive-status')).to_contain_text('Conecte')
    page.locator('#file-input').set_input_files({'name': 'persisted.txt', 'mimeType': 'text/plain', 'buffer': b'persisted bytes'})
    expect(page.locator('.rhea-upload-row').filter(has_text='persisted.txt')).to_contain_text('REQUER LOGIN')
    page.wait_for_function("""new Promise(resolve => {
      const open = indexedDB.open('rhea-uploads', 1);
      open.onsuccess = () => {
        const get = open.result.transaction('uploads').objectStore('uploads').getAll();
        get.onsuccess = () => resolve(get.result.some(item => item.name === 'persisted.txt' && item.data instanceof Blob && item.data.size === 15));
      };
    })""")

    connected = True
    page.reload()
    expect(page.locator('.rhea-upload-row').filter(has_text='persisted.txt')).to_contain_text('SINCRONIZADO')
    page.goto(base + '/rhea/arquivos/')
    expect(page.locator('#explorer-status')).to_contain_text('Sincronizado com o Drive')
    page.locator('#explorer-view').select_option('grid')
    expect(page.locator('#explorer-files')).to_have_attribute('data-view', 'grid')
    page.locator('#explorer-create').click()
    page.locator('#explorer-action-name input').fill('Synthetic folder')
    page.locator('#explorer-apply').click()
    expect(page.locator('#explorer-status')).to_contain_text('alteração(ões) confirmada(s)')
    expect(page.locator('#explorer-files')).to_contain_text('Synthetic folder')
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    drive_requests_before_library = requests.copy()
    page.locator('.section-nav a[href="/rhea/library"]').click()
    expect(page).to_have_title('Telegram · RHEA')
    expect(page.locator('#telegram-status')).to_contain_text('Ambiente de teste configurado')
    assert requests == drive_requests_before_library + ['telegram']
    page.get_by_role('button', name='Verificar conexão').click()
    expect(page.locator('#telegram-status')).to_contain_text('Bot e permissões verificados')
    expect(page.get_by_role('heading', name='Canal de demonstração')).to_be_visible()
    expect(page.get_by_role('link', name='Drive', exact=True)).to_have_attribute('href', '/rhea/arquivos')
    expect(page.locator('#message-count')).to_have_text('355')
    expect(page.locator('#plan-estimates')).to_contain_text('355 mensagens para copiar')
    page.get_by_role('button', name='K', exact=True).click()
    expect(page.locator('#catalog-result')).to_have_text('3 séries exibidas')
    kiro = page.locator('#catalog-items details').filter(has=page.locator('summary').filter(has_text='Kiro Lantern'))
    kiro.locator('summary').click()
    expect(kiro.get_by_role('heading', name='Temporada 1', exact=True)).to_be_visible()
    page.get_by_role('button', name='S', exact=True).click()
    expect(page.locator('#catalog-result')).to_have_text('3 séries exibidas')
    page.locator('#library-query').fill('霧の駅')
    expect(page.locator('#catalog-result')).to_have_text('2 séries exibidas')
    page.locator('#plan-strategy').select_option('suffix')
    expect(page.locator('#plan-estimates')).to_contain_text('347 mensagens para copiar')
    page.get_by_text('Ordem proposta', exact=True).click()
    expect(page.locator('#target-order > li')).to_have_count(355)
    page.locator('#plan-batch').fill('1')
    page.locator('#plan-batch').press('Tab')
    expect(page.locator('#plan-blockers')).to_contain_text('Um grupo é maior que o lote escolhido')
    page.locator('#plan-batch').fill('10')
    page.locator('#plan-batch').press('Tab')
    expect(page.locator('#plan-blockers')).to_be_hidden()
    page.locator('#plan-review').click()
    expect(page.get_by_role('dialog', name='Revisão da reordenação')).to_be_visible()
    page.keyboard.press('Escape')
    expect(page.locator('#plan-dialog')).to_be_hidden()
    page.locator('#correction-label').fill('Nome de demonstração')
    page.get_by_role('button', name='Aplicar à prévia').click()
    expect(page.locator('#correction-feedback')).to_contain_text('Prévia atualizada')
    page.get_by_role('button', name='Redefinir').click()
    expect(page.locator('#correction-feedback')).to_contain_text('Correção removida')
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.get_by_role('button', name='Enviar código').click()
    page.locator('#mtproto-code-input').fill('12345')
    page.get_by_role('button', name='Confirmar código').click()
    page.locator('#mtproto-password-input').fill('synthetic 2fa')
    page.get_by_role('button', name='Confirmar senha').click()
    page.get_by_role('button', name='Ler histórico').click()
    expect(page.get_by_role('heading', name='Canal de teste autorizado')).to_be_visible()
    expect(page.locator('#message-count')).to_have_text('3')
    page.locator('#library-query').fill('')
    page.get_by_role('button', name='K', exact=True).click()
    card = page.locator('#catalog-items summary').filter(has_text='Kestrel Flight')
    card.click()
    expect(page.get_by_role('link', name='Abrir no Telegram').first).to_have_attribute('href', 'https://t.me/c/9876543210/23')
    page.locator('#plan-letter').select_option('K')
    expect(page.locator('#target-order > li')).to_have_count(2)
    expect(page.locator('#target-order > li').first).to_contain_text('#23')
    expect(page.locator('#plan-blockers')).to_contain_text('A permissão de cópia precisa ser verificada')
    page.evaluate("""() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (url, options) => {
        if (typeof url !== 'string' || !url.endsWith('op=inventory')) return nativeFetch(url, options);
        return new Promise(resolve => {
          window.releaseTelegramFixture = () => resolve(new Response(JSON.stringify({
            state: 'inventory', inventory: { channelId: '9876543210', revision: 'a'.repeat(64), complete: true,
              messages: [{ id: 33, caption: 'Series: Stale result | S01E01' }] }
          }), { headers: { 'Content-Type': 'application/json' } }));
        });
      };
    }""")
    page.get_by_role('button', name='Ler histórico').click()
    widget = page.locator('[data-rhea-telegram-library]')
    widget.dispatch_event('rhea:telegram-hide')
    expect(page.get_by_role('heading', name='Canal de demonstração')).to_be_visible()
    expect(page.get_by_role('button', name='Ler histórico')).to_be_hidden()
    page.evaluate('window.releaseTelegramFixture()')
    widget.dispatch_event('rhea:telegram-show')
    expect(page.get_by_role('button', name='Ler histórico')).to_be_visible()
    expect(page.get_by_role('heading', name='Canal de demonstração')).to_be_visible()
    expect(page.locator('#message-count')).to_have_text('355')
    page.get_by_role('button', name='Desconectar Telegram').click()
    expect(page.get_by_role('button', name='Enviar código')).to_be_visible()
    assert mtproto_calls == ['status', 'start', 'code', 'password', 'inventory', 'status', 'disconnect']
    page.locator('#anime-metadata summary').click()
    page.locator('#anime-title').fill('Synthetic title')
    page.get_by_role('button', name='Buscar no AniList').click()
    expect(page.locator('#anime-lookup-results')).to_contain_text('Test Studio')
    page.locator('#mirror-panel > summary').click()
    page.locator('#mirror-preview').click()
    expect(page.locator('#mirror-dialog')).to_be_visible()
    expect(page.locator('#mirror-dialog')).to_contain_text('Synthetic clip.mkv')
    assert mirror_steps == 0
    page.locator('#mirror-approve').click()
    expect(page.locator('#mirror-continue')).to_be_visible()
    assert mirror_steps == 0
    page.locator('#mirror-continue').click()
    expect(page.locator('#mirror-status')).to_contain_text('Cópia de teste concluída')
    assert mirror_steps == 1
    page.locator('#mirror-receipts summary').click()
    expect(page.locator('#mirror-mapping')).to_contain_text('#11 → #31')
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    assert requests == drive_requests_before_library + ['telegram', 'telegram', 'anime-metadata']
    assert not errors, errors
    print(json.dumps({'viewport': '390x844 Chromium touch mobile', 'selected': 10, 'uploaded': 9,
                      'isolatedFailures': 1, 'indexedDBReload': 'passed', 'createFolder': 'passed',
                      'grid': 'passed', 'mcpCopyActions': 'passed', 'drive404Session': 'passed',
                      'persistentReload': 'passed', 'assistantRestorationAndRevocation': 'passed',
                      'rheaBranding': 'passed', 'telegramLibraryPreview': 'passed', 'telegramMtprotoEnrollment': 'passed', 'horizontalOverflow': False, 'jsErrors': errors}))
