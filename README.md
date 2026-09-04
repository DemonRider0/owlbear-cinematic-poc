# Cinemática Sincronizada

Extensão para Owlbear Rodeo que reproduz uma cinemática com áudio de forma sincronizada para todos os participantes da sala.

## Funcionalidades

- reprodução sincronizada controlada pelo GM;
- carregamento antecipado e invisível do vídeo;
- apresentação em tela cheia sobre a interface do Owlbear Rodeo;
- suporte a navegadores modernos em desktop e dispositivos móveis;
- áudio integrado ao vídeo;
- transições visuais de entrada e saída;
- fechamento automático ao final da reprodução.

## Instalação

Adicione ao Owlbear Rodeo o seguinte manifest:

```text
https://demonrider0.github.io/owlbear-cinematic-poc/manifest.pages.json
```

## Uso

1. O GM abre a ferramenta **Cinemática**.
2. Aguarda todos os clientes aparecerem como prontos.
3. Clica em **REPRODUZIR**.
4. A cinemática é apresentada para todos os participantes e fecha automaticamente ao terminar.

A ferramenta administrativa é exibida somente para o GM. O carregamento antecipado não apresenta interface aos jogadores.

## Compatibilidade

A extensão foi desenvolvida para o Owlbear Rodeo e navegadores modernos. Políticas de reprodução automática podem variar conforme o navegador e as configurações do dispositivo.

## Vídeo

Esta versão possui uma única cinemática incorporada à extensão.

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

## Autor

DemonRider
