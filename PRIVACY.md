# Política de Privacidade

## Cinemática Sincronizada

Autor: DemonRider

A extensão não possui serviço de analytics, banco de dados ou backend próprio e não envia dados pessoais para um serviço controlado pelo autor.

Para sincronizar a reprodução, a extensão troca pela sala do Owlbear Rodeo informações técnicas temporárias, como identificadores de conexão, estados de carregamento e reprodução, estado ancorado do player musical, medições de tempo, erros de mídia e informações do navegador. O nome exibido pelo participante é obtido da própria sala. Essas informações são utilizadas durante a sessão para operação e diagnóstico pelo GM.

O arquivo de vídeo pode ser armazenado no Cache Storage do navegador para permitir a reprodução sem interrupções. Esse armazenamento permanece no dispositivo e pode ser removido pelos controles normais de dados do navegador.

Na POC LOCAL_SESSION, o GM pode compartilhar um áudio local temporário com os participantes conectados. Os bytes trafegam diretamente entre navegadores por WebRTC DataChannel com criptografia DTLS. A negociação usa o Broadcast público do Owlbear; apenas o nome amigável, tamanho, MIME, hash SHA-256, duração, identificadores e estados técnicos são compartilhados. O caminho original do arquivo não é enviado. O descritor e o estado musical podem permanecer na metadata da sala; isso não torna o áudio persistente.

Cada participante armazena sua própria cópia no Cache Storage, sem garantia de retenção. O navegador pode remover os dados. A POC usa o servidor público STUN `stun.l.google.com:19302` para descobrir conectividade; ele recebe informações de rede, mas não o arquivo de áudio. A negociação ICE compartilha informações de conectividade com os participantes da sala. Não há servidor TURN, storage externo, upload de áudio para o Owlbear nem eleição de outro participante como origem.

Os arquivos estáticos da extensão são disponibilizados pelo GitHub Pages. O acesso a esses arquivos está sujeito às práticas de privacidade do GitHub e do Owlbear Rodeo.
