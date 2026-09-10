# Cinemática Sincronizada

Extensão para Owlbear Rodeo que reproduz uma cinemática e músicas de forma sincronizada para todos os participantes da sala.

## Funcionalidades

- reprodução sincronizada controlada pelo GM;
- player musical independente com Play/Pause, seek e seleção entre duas faixas;
- loop contínuo preparado individualmente para cada música;
- troca de faixa com crossfade sincronizado;
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
2. Na seção **Música**, escolhe **O Porão** ou **O Ídolo** e usa Play/Pause ou a barra de progresso.
3. Para a cinemática, aguarda todos os clientes aparecerem como prontos e clica em **REPRODUZIR**.
4. A música manual é encerrada antes do vídeo. A trilha completa assume automaticamente quando a música embutida termina e continua após o fechamento da cinemática.

A ferramenta administrativa é exibida somente para o GM. O áudio vive no serviço em segundo plano de cada cliente, portanto fechar o painel não interrompe a reprodução. Jogadores não recebem controles.

## Compatibilidade

A extensão foi desenvolvida para o Owlbear Rodeo e navegadores modernos. A permissão de autoplay do manifest é necessária para a reprodução sincronizada sem interação individual de cada participante. Políticas locais do navegador ainda podem variar conforme a configuração do dispositivo.

## Vídeo

Esta versão possui uma única cinemática e duas músicas incorporadas à extensão.

## Privacidade

A extensão não possui analytics, backend próprio nem coleta centralizada de dados pessoais. Consulte a [Política de Privacidade](PRIVACY.md) para detalhes.

## Desenvolvimento local

O manifest `public/manifest.json` usa rotas da raiz e é destinado ao servidor local. O manifest `public/manifest.pages.json` usa as URLs HTTPS do GitHub Pages e é o arquivo indicado para instalação pública.

```sh
npm ci
npm run dev
```

Durante o desenvolvimento, cadastre `http://localhost:5173/manifest.json` no Owlbear Rodeo.

Para validar o projeto completo, execute `npm run check`.

Esta branch contém a POC `LOCAL_SESSION` de áudio local temporário. Consulte [arquitetura, limitações e roteiro de testes desktop/Android](LOCAL_SESSION_POC.md). O push da branch não publica a POC no GitHub Pages.

## Autor

DemonRider
