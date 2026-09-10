# POC de áudio temporário por sessão

Escopo: arquivo local do GM → DataChannel → SHA-256 → Cache Storage → READY → player musical com o clock existente. Fonte `LOCAL_SESSION`; nenhuma promessa de persistência. Ausência de `MusicState.source` conserva as faixas incorporadas (`BUILTIN` implícito), com todos os contratos anteriores.

## Arquitetura e contratos

- `local-session-source.ts`: descritor sem paths, limite de **100.000.000 bytes (100 MB)**, `canPlayType` mais preparação decodificável, SHA-256 nativo e cache. OGG/MP3 são prioritários; MIME informado pelo sistema, com extensão apenas como dica quando ele não informa MIME. Não há transcoding.
- `local-session-transport.ts`: `LocalSessionTransport`, uma transferência por navegador. GM distribui sequencialmente. Canal confiável e ordenado; chunks de **até 16 KiB**, reduzidos quando `pc.sctp.maxMessageSize` exigir. O envio pausa antes de ultrapassar **256 KiB** de buffer e aguarda `bufferedamountlow` em **64 KiB**. Timeout de buffer: 30 s; negociação ICE: até 10 s; transferência: 120 s; espera de READY por cliente: 150 s. Retry manual, sem retomada parcial.
- `local-session.ts`: autorização via identidade real do `BroadcastEvent.connectionId` e lista pública de participantes/roles; registro, desafios de readiness por conexão e tentativa, distribuição, progresso e cancelamento. Eventos RTC só são aceitos para peer, faixa e transferência esperados. Mensagens com campos inesperados são recusadas.
- `local-session-ui.ts`: seção mínima criada somente após confirmar role GM. O arquivo do input é validado/cacheado no contexto local; somente o descritor cruza o Broadcast LOCAL até o background. O background valida novamente. Fechar o painel durante a distribuição não interrompe a transferência.
- `MusicPlayer`: recebe Blob resolvido, prepara uma voz simples e reutiliza agendamento/clock, correção de drift e volume local de Trilhas. Sem loop ou seam automático para importados; a faixa termina naturalmente. EMF/cinematic continuam exclusivos. O estado selecionado é pausado; `Usar faixa` e depois Play iniciam a POC. Play/Pause/seek não escrevem no cache.

Ao importar outra faixa enquanto uma temporária toca, o player mantém a voz atual até a seleção sincronizada da nova. Existem no máximo uma voz local ativa e uma candidata preparada; não há mixagem simultânea. A URL anterior é revogada na troca. Esse intervalo pode reter duas faixas em memória, além das alocações de preparação.

Signaling usa o canal público `demonrider.cinematic-sync/local-session-v1`. Offer e answer contêm ICE coletado (non-trickle); envelopes são limitados a menos de 15 KB, abaixo dos 16 KB documentados pelo SDK 3.1.0. Não há chunks, Blob, ArrayBuffer ou base64 de áudio em Broadcast ou Room Metadata. A metadata guarda apenas o descritor em `demonrider.cinematic-sync/local-session` e o estado musical existente.

O hash é calculado no GM com `crypto.subtle.digest("SHA-256", bytes)`; cada receptor verifica tamanho e hash antes de armazenar, relê a cópia íntegra e prepara a reprodução antes de READY. Entrada corrompida é removida. Chave: URL sintética `./local-session/<sha256>` no mesmo cache `demonrider.cinematic-sync/media/v2` usado pela cinemática; essa URL nunca é buscada na rede. Nome e sessionTrackId diferentes podem reutilizar a mesma entrada de conteúdo.

O GM exige READY recente de cada conexão atual, incluindo clock pronto; não depende só do botão desabilitado. Heartbeats de 5 s expiram após 15 s. O desafio CHECK permite cache hit sem RTC; cache miss provoca REQUEST. Após uma transferência válida, o cliente entra no estado musical atual usando a posição calculada a partir de `anchorAtGm` e do offset já medido. O início de novos comandos usa o atraso existente de 500 ms.

## Reload, entrada tardia e saída do GM

- Reload de jogador: lê descritor da sala quando a origem ainda está conectada; revalida o cache. Com a mesma cópia íntegra, não precisa receber bytes de novo. A nova conexão precisa de um novo desafio de READY; o GM usa **Distribuir / tentar novamente**.
- Sem cache: o jogador fica pendente. Na distribuição manual, solicita o asset e recebe do GM. Quando pronto, entra na posição atual da faixa, se ela estiver tocando.
- Novo jogador: aparece como pendente; o GM distribui novamente. Clientes já prontos são pulados; cache hits também evitam retransmissão.
- Reload do GM: seu identificador estável de jogador permite recuperar o descritor e o cache e atualizar a conexão de origem. Se perdeu o arquivo/cache, deve importar novamente. Não há promessa de recuperação futura.
- Cache removido durante a sessão: o GM pode continuar distribuindo a cópia íntegra já resolvida em memória. O retry revalida essa cópia sem exigir outra leitura/gravação do Cache Storage; o diagnóstico de cache hit inclui essa reutilização. Após reload, essa cópia em memória deixa de existir.
- GM sai: cópias já carregadas podem continuar até o fim da faixa, com o último offset conhecido. Não há origem alternativa; clientes sem cópia não têm garantia de recebimento. O registro na sala não é uma biblioteca permanente.

## Limitações da prova

Não foi executado Computer Use, Chrome real nem Android nesta tarefa. Testes automatizados usam doubles de browser/RTC, SHA-256 real e blobs reais; não provam conectividade ICE, autoplay, consumo real de memória ou sincronismo entre dispositivos. A POC só pode ser considerada promissora no critério de produto depois dos smoke tests abaixo.

Sem TURN, NAT simétrico, CGNAT, firewall, VPN ou bloqueio de UDP podem impedir a conexão direta. Há STUN público Google, sem credenciais ou backend de storage. Celular com tela apagada, aba suspensa ou economia de energia pode interromper timers/RTC. Manter Owlbear visível durante o teste. O Web Crypto não tem digest em streaming: há alocação integral temporária para hash, além de chunks/Blob/cache/decoder; 100 MB não significa pico de RAM limitado a 100 MB. A distribuição sequencial limita multiplicação por jogador, mas o pico no Android precisa ser medido.

O cache é best-effort e pode falhar por quota, particionamento em iframe, modo privado ou eviction. Não há quota manager. Arquivo inválido ou incompleto não vira READY. `canPlayType` e preparação inicial não garantem que um arquivo danificado no meio tocará até o fim. Não há teste de autoplay silencioso: bloqueio de Play aparece como erro ao GM. Não há fila persistente, seed alternativo, upload, persistência externa ou eleição de origem. A POC assume um GM distribuidor e um background por conexão.

## Preparação do smoke test

1. Usar a branch `poc/local-session-audio`, executar `npm ci` e `npm run check`.
2. Desktop local: executar `npm run dev`; em uma sala de teste, cadastrar `http://localhost:5173/manifest.json`. Isso serve para dois perfis Chrome na mesma máquina; computadores diferentes não compartilham localhost.
3. Para Android ou desktops diferentes, disponibilizar o conteúdo de `dist/` na **raiz de um host HTTPS de teste com certificado confiável**, acessível por todos, e cadastrar `https://HOST-DE-TESTE/manifest.json`. O manifest relativo desse build aponta para `/background.html`. **Não usar `manifest.pages.json`**, pois ele aponta para a versão aprovada em produção. Não testar por HTTP no IP da LAN: Web Crypto/Cache Storage exigem contexto seguro. O push desta branch não publica preview; o workflow existente só faz deploy por push em `main`. Nenhum host de teste foi publicado nesta tarefa.
4. Usar uma sala descartável, com apenas esta versão da extensão, e contas/perfis distintos para GM e PLAYER. Confirmar roles. Preparar um OGG e um MP3 reproduzíveis de 20–50 MB, com batidas identificáveis, e opcionalmente um próximo de 100 MB.
5. Abrir a extensão em cada cliente, ajustar **Trilhas 50%** e **Efeitos 0%**. PLAYER deve ver somente seus volumes, sem importação. Manter o áudio do sistema audível e permissões de reprodução do Owlbear habilitadas.
6. No GM, abrir **Faixa temporária → Diagnóstico da POC**. Usar cronômetro externo do clique de seleção até READY de todos. Registrar arquivo/tamanho, Chrome/Android, rede, tempo, cache hit/miss, erros, retry e diferença audível entre clientes. Para memória, no desktop usar o Gerenciador de tarefas do Chrome antes/durante/depois; Android exige inspeção remota para números, ou registrar reload/encerramento como falha observada.

### Caso A — GM Chrome desktop + PLAYER Chrome desktop

1. GM: **Importar áudio**, escolher OGG; confirmar nome sem caminho e aviso de temporária.
2. Acompanhar bytes e estados. Esperar todos READY; **Usar faixa** deve ficar disponível apenas então.
3. Clicar **Usar faixa**, depois Play no controle musical existente. Ouvir a mesma batida nos dois clientes.
4. Pausar, buscar para 30 s, tocar; buscar durante Play para 60 s. Confirmar entrada conjunta na posição correta.
5. Alterar Efeitos entre 0% e 100%: a faixa não muda. Alterar Trilhas de um cliente: só ele muda.
6. Repetir com MP3; selecionar o mesmo arquivo novamente e confirmar cache hit, sem duplicação da chave e sem nova transferência de bytes.
7. Voltar a O Porão/O Ídolo e verificar Play, troca com crossfade e loops aprovados. Disparar EMF e cinematic para conferir exclusividade e handoff.

### Caso B — GM desktop + PLAYER Android Chrome

1. Usar o mesmo manifest HTTPS de teste; manter a tela Android ativa e Owlbear em primeiro plano.
2. Repetir A com OGG e MP3 de dezenas de MB; registrar tempo, progresso e possível pressão de memória.
3. Testar primeiro ambos no mesmo Wi-Fi; depois Android em dados móveis. Se RTC falhar, registrar rede, timeout e resultado do retry; não interpretar como erro de hash ou sucesso parcial.
4. Bloquear/desbloquear a tela durante uma transferência em execução como teste de falha; retornar ao Owlbear e usar retry manual.

### Caso C — GM + PLAYER A + PLAYER B

1. Entrar com ambos antes da importação e importar arquivo ainda não cacheado.
2. Confirmar distribuição sequencial e contagem de três clientes. Tentar Play antes de todos prontos: deve permanecer bloqueado.
3. Ao terminar, usar a faixa e tocar nos três. Desconectar um cliente durante outra transferência e confirmar erro explícito ou remoção da lista; reconectar e usar retry.

### Caso D — jogador entra com a faixa tocando

1. GM e A ficam READY e começam Play. Após 30 s, B entra.
2. GM verifica B pendente e clica **Distribuir / tentar novamente**. A não deve baixar de novo nem reiniciar.
3. B termina hash/cache/preparação e começa próximo da posição atual de GM/A, não em zero. Confirmar batida e estabilidade após 30 s.

### Caso E — reload com cache

1. Com a faixa tocando, recarregar A sem limpar os dados do site.
2. Confirmar cache hit; se a conexão mudou, GM clica **Distribuir / tentar novamente** para renovar READY. Não deve haver chunks novos para A.
3. Em outro perfil sem cache, repetir a entrada: deve ficar pendente e solicitar o arquivo na distribuição.
4. Recarregar GM sem limpar dados; confirmar recuperação possível. Depois testar GM saindo: clientes já carregados continuam, cliente novo não recebe de outro jogador.

### Caso F — falha de transferência/integridade

1. Durante o envio de arquivo grande, clicar **Cancelar distribuição** no GM ou interromper a rede do receptor.
2. Confirmar que o receptor não vira READY e que o GM mostra falha. Restaurar a rede e clicar retry; somente o arquivo completo e íntegro pode ser usado.
3. A falha de SHA-256 é injetada apenas pelo teste automatizado `rejects a wrong hash before READY or writing the cache`; não há botão de corrupção na UI. Executar `npm test -- tests/local-session.test.ts` para essa verificação. Não é necessário alterar metadata ou assets para simulá-la.

## Validação executada

Em 10/09/2026, `npm run check` passou: typecheck, lint, **71 testes em oito arquivos** e build. `git diff --check` passou. A cobertura inclui round-trip de 32 MB com SHA-256 real, backpressure, cache, readiness, cancelamento, retry e regressões do player.

O `/review` foi executado duas vezes por CLI com Astra/High/Standard, em modo somente leitura. Foram corrigidos cinco achados iniciais (preservar a faixa ativa durante outra importação, descartar preparação de áudio com falha, recuperar READY do GM no retry, executar EMF sem asset local e respeitar ABORT durante CHECK). A rechecagem confirmou essas correções e identificou mais um caso: preservar a cópia resolvida em memória após eviction do cache do GM. Esse sexto achado também foi corrigido e recebeu teste de regressão; a suíte completa acima passou após a correção. A revisão final do agente principal conferiu essa alteração, o escopo e os artefatos antes do commit.

**Não executados:** testes reais A–F em Owlbear/Chrome/Android, conectividade entre redes, medição de sincronismo e pico de memória nos dispositivos. O build de teste não foi publicado. Esses resultados ainda são necessários para avaliar a POC como promissora em uso real.

## Fontes oficiais consultadas

- [Owlbear Broadcast — 16 KB, connectionId, destino e unsubscribe](https://docs.owlbear.rodeo/extensions/apis/broadcast/)
- [WebRTC DataChannel — mensagens, SCTP e DTLS](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels)
- [bufferedAmountLowThreshold](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmountLowThreshold)
- [WebRTC — necessidade de TURN em redes sem conexão direta](https://webrtc.org/getting-started/turn-server)
- [Web Crypto digest — contexto seguro e ausência de streaming](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest)
- [HTMLMediaElement.canPlayType](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/canPlayType)
