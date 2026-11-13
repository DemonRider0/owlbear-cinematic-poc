# Cinemática Sincronizada

Extensão para Owlbear Rodeo que reproduz uma cinemática, trilhas em camadas e efeitos de forma sincronizada para os participantes da sala.

## Funcionalidades

- reprodução sincronizada controlada pelo GM;
- dez trilhas incorporadas, com reprodução, pausa com fade, parada, busca e volume de mixagem por faixa;
- adição de camadas e substituição da mixagem com crossfade sincronizado;
- loops com pontos de retorno por faixa e introdução preservada na primeira passagem;
- volumes locais de Trilhas e Efeitos para GM e jogadores;
- carregamento antecipado e invisível do vídeo;
- apresentação em tela cheia sobre a interface do Owlbear Rodeo;
- suporte a navegadores modernos em desktop e dispositivos móveis;
- áudio integrado ao vídeo;
- transições visuais de entrada e saída;
- fechamento automático ao final da reprodução;
- continuidade automática da trilha quando o áudio musical da cinemática termina.

## Instalação

Adicione ao Owlbear Rodeo o seguinte manifest:

```text
https://demonrider0.github.io/owlbear-cinematic-poc/manifest.pages.json
```

## Uso

1. O GM abre a ferramenta **Cinemática**.
2. Na seção **Música**, use **Adicionar** para tocar uma faixa junto com as demais ou **Substituir** para encerrar as outras camadas em cerca de quatro segundos. Substituir por uma faixa que já está tocando mantém sua posição. **Pausar** baixa o ganho durante quatro segundos e congela a posição ao final. **Reproduzir** retoma com fade-in. Cada cartão tem também parada, busca e volume de mixagem.
3. Para a cinemática, aguarda todos os clientes aparecerem como prontos e clica em **REPRODUZIR**.
4. As camadas manuais são encerradas antes do vídeo. O Porão entra na transição calibrada do final e continua após o fechamento da cinemática. Os EMFs pausam as trilhas em andamento e tocam sozinhos. Ao final de um EMF, o GM retoma a trilha desejada manualmente.

Os comandos de reprodução e mixagem são exclusivos do GM. Cada participante tem seus próprios volumes de **Trilhas** e **Efeitos**. O áudio vive no background de cada cliente e continua ao fechar o painel. O estado da sala guarda a posição ancorada no relógio do GM e o volume de cada camada, permitindo que quem chega depois entre nas posições em andamento.

O ganho de segurança da mixagem usa os picos estimados das vozes. Quando a soma pode saturar, o player aplica o mesmo fator a todas as trilhas, mantendo as proporções definidas pelo GM. Em um cliente que ainda está carregando a faixa de uma substituição, a anterior pode permanecer audível por alguns segundos enquanto a nova começa na posição sincronizada.

## Compatibilidade

O background solicita o estado da sala e sincroniza o relógio ao entrar ou reconectar. Ele repete a solicitação enquanto aguarda o primeiro estado ou uma resposta do relógio. O áudio começa sem abrir o painel quando o navegador permite. Os manifests delegam a permissão `autoplay` aos iframes da extensão. O navegador ainda pode exigir uma interação. [Manifest do Owlbear Rodeo](https://docs.owlbear.rodeo/extensions/reference/manifest/) · [Política de autoplay do Chrome](https://developer.chrome.com/blog/autoplay/)

Se o navegador rejeitar o início, a extensão exibe o popover **Ativar áudio**. Se ele for dispensado, use o ícone **Cinemática** para reabri-lo. Ao confirmar o início, o popover fecha e as trilhas seguem na posição atual da sala. **Abrir controles** mantém o painel acessível mesmo se o áudio continuar bloqueado. Nesse caso, verifique as permissões de reprodução disponíveis no navegador e recarregue a sala.

## Vídeo

Esta versão possui uma cinemática e dez músicas incorporadas. **O Porão** e **O Ídolo** ficam em **Trilhas anteriores**. Consulte as [edições e medições das trilhas da nova mesa](EDICAO_DAS_TRILHAS.md).

## Privacidade

A extensão não possui analytics, backend próprio nem coleta centralizada de dados pessoais. Consulte a [Política de Privacidade](PRIVACY.md) para detalhes.

## Desenvolvimento local

O manifest `public/manifest.json` usa rotas da raiz e é destinado ao servidor local. O manifest `public/manifest.pages.json` usa as URLs HTTPS do GitHub Pages e é o arquivo indicado para instalação pública.

```sh
npm ci
npm run dev
```

Durante o desenvolvimento, cadastre `http://localhost:5173/manifest.json` no Owlbear Rodeo.

Para validar o projeto completo, execute `npm run check`. No PowerShell, use `npm.cmd` se a política local bloquear `npm.ps1`.

### Prévia em sala de teste

1. Execute `npm run dev` e instale `http://localhost:5173/manifest.json` numa sala de teste. Para testar com dois perfis Chrome na mesma máquina, abra a mesma sala nos dois perfis, um GM e um jogador. Aguarde os indicadores de áudio e relógio no painel do GM.
2. Para Android ou outra máquina, sirva a saída de `npm run build` na raiz de um host HTTPS de teste com certificado confiável, alcançável pelos dois dispositivos. Instale o `/manifest.json` desse host na sala. O manifest `manifest.pages.json` aponta para o GitHub Pages.
3. No GM, inicie Vàli e adicione Wildfire em outro instante. Compare a mesma passagem nos dois dispositivos. Ajuste Vàli para 30% e Wildfire para 80%, e reduza Trilhas só no jogador. Verifique que a proporção é compartilhada e a redução local afeta só aquele navegador.
4. Pause, retome, busque e pare uma camada mantendo as outras em reprodução. Feche e reabra o painel. Recarregue o jogador com duas camadas em andamento e confira se ele volta à posição atual de cada uma. Repita com uma entrada tardia.
5. Use **Substituir** em What Remains. Repita escolhendo uma faixa já em reprodução e fazendo dois comandos de substituição em sequência. Ao final do fade, confira se apenas a última faixa escolhida permanece e se ela manteve sua posição quando já estava tocando.
6. Teste o EMF com várias trilhas e confira o silêncio após o efeito. Retome uma camada manualmente e, em seguida, dispare a cinemática. Confira a saída das trilhas, a reprodução do vídeo e a continuidade de O Porão.
7. Ouça a primeira entrada e pelo menos três retornos por faixa. Use a barra de posição para antecipar o primeiro crossfade de cada uma.

### Homologação de entrada e pausa

1. Em Chrome desktop e Android, entre como jogador com o painel fechado. Teste a entrada antes de o GM iniciar e com três trilhas já tocando. O áudio automático começa sem popover. Se aparecer **Ativar áudio**, confira **áudio bloqueado** no painel do GM e clique no popover. O diagnóstico do cliente deve sair de `BLOCKED` e indicar `PLAYING` quando a reprodução for confirmada. As trilhas devem entrar nos pontos atuais e manter o volume local.
2. Recarregue o jogador, depois teste perda e retorno da conexão com duas trilhas tocando. Confira a recuperação das duas posições e o comportamento ao fechar ou abrir o painel de volumes.
3. Pause uma camada. Ouça a descida por quatro segundos enquanto as demais continuam. Retome e confira a posição congelada e o fade-in. Repita com Play antes do fim do fade, seek durante a pausa em andamento e Substituir por outra trilha.
4. Para as quatro novas faixas, teste um retorno isolado, dois ciclos seguidos e uma passagem com outra camada tocando. Confira os pontos no [registro das edições](EDICAO_DAS_TRILHAS.md).

## Autor

DemonRider
