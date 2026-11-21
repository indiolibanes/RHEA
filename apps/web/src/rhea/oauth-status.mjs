const messages = {
  connected: 'O Google retornou, mas esta aba ainda não reconheceu a sessão. Atualize a conexão e use o mesmo navegador nas duas etapas.',
  google_client_id: 'Configure RHEA_GOOGLE_CLIENT_ID com o ID do cliente OAuth do Google nas Functions.',
  google_client_secret: 'Configure RHEA_GOOGLE_CLIENT_SECRET como segredo nas Functions.',
  cookie_key: 'Configure RHEA_COOKIE_KEY como segredo de sessão nas Functions.',
  drive_persistence_config: 'A conexão persistente do Drive está indisponível. Confira a configuração da RHEA.',
  oauth_state: 'A tentativa de conexão perdeu a sessão. Inicie novamente pelo botão Conectar conta Google.',
  oauth_consent: 'A permissão não foi concedida. Conecte a conta novamente para autorizar o Drive.',
  oauth_client: 'O Google não aceitou as credenciais do cliente OAuth. Confira Client ID e Client secret no mesmo projeto.',
  oauth_redirect: 'O Google não aceitou a URL de retorno. Confira o callback cadastrado no cliente OAuth.',
  oauth_code: 'O retorno do Google não trouxe um código de autorização válido. Inicie uma conexão nova pela RHEA.',
  oauth_grant: 'O Google recusou o código de autorização (expirado, reutilizado ou incompatível com cliente, callback ou PKCE). Inicie uma nova tentativa; se persistir, verifique o cliente OAuth e a URL exata do callback.',
  oauth_request: 'O Google rejeitou os parâmetros da troca de token. Confira o cliente OAuth Web e o retorno cadastrado.',
  oauth_token_redirect: 'O endpoint OAuth do Google redirecionou a requisição de token; a RHEA interrompeu a operação para proteger as credenciais. Consulte os logs privados.',
  oauth_token_timeout: 'A troca de token com o Google excedeu o tempo limite. Verifique os logs do Pages e inicie uma nova conexão.',
  oauth_token_network: 'O servidor da RHEA não conseguiu contatar o endpoint de tokens do Google. Verifique os logs das Pages Functions.',
  oauth_token_rejected: 'O servidor do Google recusou a troca de token por um motivo não classificado. Confira a categoria e o status HTTP nos logs privados das Pages Functions.',
  oauth_token_response: 'O Google respondeu ao pedido de token, mas os dados recebidos não são utilizáveis. Consulte os logs sem expor tokens.',
  oauth_exchange: 'A troca de token falhou por uma causa ainda não classificada. Consulte os logs privados das Pages Functions e inicie uma nova conexão.',
  oauth_offline: 'O Google não entregou a credencial de renovação. Volte a conectar o Drive e confirme o consentimento.',
  oauth_link_changed: 'A conexão do Drive mudou durante a autorização. Atualize a conexão antes de tentar novamente.',
  oauth_scope: 'O Google não concedeu o acesso drive.file. Confira o escopo e autorize novamente.',
  oauth_drive: 'O Google autorizou a conta, mas a Drive API recusou a consulta. Confira se a API está ativada no projeto do cliente OAuth.',
  erro: 'A autorização não foi concluída. Conecte-se novamente.',
};

export function driveStatusMessage(code) {
  return Object.hasOwn(messages, code) ? messages[code] : null;
}
