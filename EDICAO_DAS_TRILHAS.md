# Edição das trilhas da nova mesa

Os quatro OGG usam Vorbis estéreo a 44.100 Hz, qualidade 7, em `public/assets/music/`. Cada arquivo começa no zero do MP3 decodificado. A introdução termina no ponto de retorno, que o player usa a partir da primeira repetição. O arquivo mantém as duas extremidades em áudio normal para que o player aplique um único crossfade. O início da sobreposição é a saída menos o crossfade e o período do ciclo é a saída menos o retorno e o crossfade.

| Faixa | Introdução até / retorno (s) | Saída e duração OGG (s) | Início do crossfade (s) | Crossfade (s) | Ciclo (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Vàli — Et Ensomt Minne | 195,800 | 235,460 | 235,000 | 0,460 | 39,200 |
| Nightfire Ritual | 68,920 | 187,600 | 187,320 | 0,280 | 118,400 |
| What Remains | 15,280 | 43,640 | 43,160 | 0,480 | 27,880 |
| Wildfire | 115,600 | 234,780 | 234,520 | 0,260 | 118,920 |

- **Vàli.** O primeiro percurso conserva a abertura suave e o crescimento instrumental. A repetição retorna à passagem madura, com a frase de 39,20 s alinhada pelo pulso, com Lá, Sol♯ e Dó♯ proeminentes em ambos os lados do corte. O retorno mantém a intensidade e a exportação termina antes da queda final. Apliquei −2,0 dB de ganho fixo para dar margem aos picos.
- **Nightfire Ritual.** O MP3 tem 215,504 s. Entre 189 e 191 s o corpo de combate se dissipa. A partir de aproximadamente 192 s, aparece uma seção centrada em Lá, com outro perfil melódico. O corte em 187,600 s exclui essa cauda e a seção seguinte. O retorno mantém o apoio em Dó e Sol, com diferença de 118,4 s entre pontos equivalentes do pulso de 0,4 s. Apliquei uma prateleira de graves de −2,5 dB em 110 Hz e ganho fixo de −0,8 dB.
- **What Remains.** O original tem 47,253 s. O recorte conserva o início íntimo e a subida de energia na faixa de 16–24 s. O retorno em 15,280 s foi escolhido pelos ataques curtos compatíveis com o violão e pelo mesmo grupo Fá♯, Lá e Dó♯ presente antes do corte. O ciclo usa o desenvolvimento disponível no original curto.
- **Wildfire.** A saída antecede a queda de energia próxima de 240 s. A comparação de transientes e harmonia encontrou a mesma defasagem de 118,92 s ao longo de várias frases. O retorno conserva a percussão e a tensão da seção de combate. Apliquei −1,3 dB de ganho fixo.

## Nightfire Ritual com Wildfire

Nightfire tem pulso predominante de aproximadamente **150 BPM** e Wildfire de **118 BPM**. Os acentos têm relações ocasionais e se afastam durante a sobreposição livre. O cromagrama dos ciclos mostra Dó e Mi♭ presentes nas duas faixas, enquanto Nightfire enfatiza Dó e Sol no baixo e Wildfire enfatiza Fá e Mi. A combinação pode funcionar como textura de combate, com risco de ataques concorrentes e atrito entre trechos melódicos.

Os arquivos mantêm os andamentos, a afinação e o arranjo originais. Antes da EQ, a faixa de 30–80 Hz de Nightfire era aproximadamente 3,7 dB mais forte que a mesma banda em Wildfire nos ciclos analisados. O ajuste de graves de Nightfire reduziu o loudness integrado em 0,6 LU e a faixa dinâmica medida em 0,1 LU antes do ganho fixo. Para comparar com Wildfire como base, use Wildfire a 80% e Nightfire a 30%. A audição da mistura deve verificar se a percussão e o baixo se acumulam nas entradas e ao longo dos ciclos.

## Verificações de áudio

O FFprobe e a contagem de amostras após decodificação confirmaram as quatro durações da tabela. A análise em PCM estéreo simulou quatro emendas sucessivas com o crossfade de potência constante. As emendas mantiveram a duração calculada e nenhuma amostra saturou. O SHA-256 dos quatro MP3 coincidiu antes e depois da edição.

| Faixa | Loudness do OGG (LUFS) | Pico do OGG (dBTP) | Pico nas emendas (dBTP) |
| --- | ---: | ---: | ---: |
| Vàli | −14,3 | −1,8 | −1,9 |
| Nightfire Ritual | −14,9 | −1,7 | −2,1 |
| What Remains | −15,9 | −3,5 | −3,6 |
| Wildfire | −14,4 | −1,7 | −1,7 |

Para a aprovação auditiva, escute a primeira entrada de cada faixa e pelo menos três passagens pelo ponto de retorno. Para repetir a comparação do combate, escute Nightfire sozinha e depois adicione-a a Wildfire em momentos diferentes. A emenda de What Remains merece atenção na passagem da cauda de cordas para os ataques de violão. A avaliação auditiva e a reprodução no Owlbear continuam pendentes.

## Segunda rodada

Os três recortes de tensão vêm de `Ben Lovett  To Hell With This.mp3` (190,008889 s) e a faixa de perseguição vem de `Demons of the Prairie.mp3` (175,658957 s). Os dois MP3 são estéreo a 44.100 Hz e foram decodificados integralmente sem erro. O SHA-256 de cada original coincidiu antes e depois da exportação.

Os OGGs em `public/assets/music/` mantêm o padrão Vorbis estéreo a 44.100 Hz, qualidade 7. Cada um começa no primeiro ponto do intervalo correspondente e tem uma rampa de 8 ms para suavizar a entrada do recorte. Os crossfades da tabela são feitos pelo player. Todos os pontos de reprodução e retorno são relativos ao OGG.

| Faixa e arquivo | Intervalo no MP3 (s) | Duração e saída (s) | Retorno (s) | Início do crossfade (s) | Crossfade (s) | Ciclo (s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Tensão — Presságio · `tensao-pressagio.ogg` | 0,000–68,820 | 68,820 | 45,530 | 68,680 | 0,140 | 23,150 |
| Tensão — Crescente · `tensao-crescente.ogg` | 70,000–140,720 | 70,720 | 47,350 | 70,480 | 0,240 | 23,130 |
| Tensão — Ruptura · `tensao-ruptura.ogg` | 142,000–182,570 | 40,570 | 22,980 | 40,330 | 0,240 | 17,350 |
| Perseguição — Frenética · `perseguicao-frenetica.ogg` | 0,000–52,000 | 52,000 | 40,540 | 51,860 | 0,140 | 11,320 |

- **Presságio.** O retorno cai numa passagem equivalente a cerca de quatro motivos de 5,78 s e preserva o intervalo entre acentos de percussão. A janela curta une as caudas antes da batida seguinte. A intensidade aumenta perto da batida após o retorno, que merece atenção na escuta.
- **Crescente.** O primeiro percurso conserva a subida do trecho. O retorno mantém a textura já mais encorpada, com quatro motivos de cerca de 5,78 s entre a entrada e a saída. A transição de 240 ms aproxima os trechos com espectro e intensidade semelhantes.
- **Ruptura.** O retorno cai depois do aumento sustentado de intensidade, cerca de três motivos antes da saída. A emenda preserva a percussão forte e evita a resolução e o fade final do original. O recorte termina 430 ms antes do limite solicitado para alinhar os acentos. O ganho fixo reserva margem para os ataques durante a sobreposição.
- **Frenética.** O retorno reaproveita três motivos de aproximadamente 3,78 s dentro dos primeiros 52 s. O trecho imediatamente anterior e o seguinte têm intensidade próxima. O ciclo é curto e pode ficar reconhecível em perseguições longas.

### Verificações da segunda rodada

O FFprobe e a contagem de amostras do PCM decodificado confirmaram as durações. A análise comparou transientes, energia, perfil espectral e cromas em torno das emendas. A reconstrução em PCM aplicou a curva de potência constante do player a quatro ciclos consecutivos de cada faixa, com continuidade na montagem das amostras e sem clipping. Os ganhos fixos da exportação preservam a dinâmica.

| Faixa | Ganho fixo (dB) | Loudness (LUFS) | Pico do OGG (dBTP) | Pico em quatro emendas (dBTP) |
| --- | ---: | ---: | ---: | ---: |
| Presságio | −3,3 | −18,6 | −2,3 | −2,4 |
| Crescente | −1,2 | −17,6 | −2,3 | −2,3 |
| Ruptura | −4,8 | −13,4 | −3,6 | −2,5 |
| Frenética | −3,6 | −14,7 | −3,0 | −3,0 |

A aprovação auditiva continua pendente. Ouça o primeiro percurso e pelo menos três retornos de cada faixa, com atenção à batida após a emenda de Presságio e à repetição do motivo em Frenética.

## Ajustes após a escuta do GM

Os tempos e os picos desta seção substituem os valores anteriores de Presságio, Nightfire Ritual e Frenética. Cada OGG foi reexportado do MP3 original em Vorbis estéreo a 44.100 Hz, qualidade 7. O retorno e a emenda na tabela usam o relógio do OGG.

| Faixa | Intervalo no MP3 (s) | Duração e saída (s) | Retorno (s) | Início do crossfade (s) | Crossfade (s) | Ciclo (s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Tensão — Presságio | 0,000–63,370 | 63,370 | 34,230 | 63,150 | 0,220 | 28,920 |
| Nightfire Ritual | 9,630–187,600 | 177,970 | 59,290 | 177,690 | 0,280 | 118,400 |
| Perseguição — Frenética | 0,000–18,640 | 18,640 | 10,900 | 18,500 | 0,140 | 7,600 |

- **Presságio.** A exportação termina antes do ataque que inicia a subida, detectado perto de 63,73 s. O retorno usa cinco motivos de aproximadamente 5,78 s. Os trechos sobrepostos diferiram cerca de 0,1 dB de RMS no PCM de origem. A janela de 220 ms atravessa a cauda do batuque e mantém o próximo acento no pulso.
- **Nightfire Ritual.** O corte remove 9,630 s da abertura e deixa cerca de 30 ms antes do primeiro ataque da passagem musical detectada. Uma rampa inicial de 8 ms suaviza a entrada. O retorno em 68,920 s e a saída em 187,600 s no MP3, a duração do ciclo e a exclusão dos créditos são os mesmos da primeira edição. Foram reaplicados o shelf de −2,5 dB em 110 Hz e o ganho de −0,8 dB. A diferença de RMS entre os trechos correspondentes do OGG anterior e do novo foi inferior a 0,001 dB, excluindo o primeiro e o último segundo da comparação.
- **Frenética.** A faixa começa no zero do MP3 e fecha antes do impacto forte de aproximadamente 18,79 s. O retorno liga duas passagens percussivas com energia próxima, a cerca de dois motivos de 3,78 s de distância. O crossfade de 140 ms mantém a pulsação e o ciclo de 7,6 s pode se tornar reconhecível em perseguições prolongadas.

O FFprobe e a contagem de amostras confirmaram as durações. A simulação em PCM repetiu quatro ciclos consecutivos com o crossfade de potência constante, sem clipping. Os três MP3 mantiveram seus hashes SHA-256.

| Faixa | Ganho fixo (dB) | Loudness (LUFS) | Pico do OGG (dBTP) | Pico em quatro emendas (dBTP) |
| --- | ---: | ---: | ---: | ---: |
| Presságio | −3,3 | −18,6 | −2,3 | −2,3 |
| Nightfire Ritual | −0,8 | −14,9 | −1,6 | −1,6 |
| Frenética | −3,6 | −16,4 | −4,8 | −5,3 |

A musicalidade dos novos cortes ainda depende da escuta do GM.

## Perseguição — Frenética na versão 1.2.1

O GM percebeu a emenda do ciclo de 7,600 s da versão 1.2.0 durante a escuta. A nova edição mantém a abertura do MP3 e repete um motivo completo de cerca de 3,776 s. O OGG Vorbis estéreo a 44.100 Hz usa as primeiras 545.341 amostras do original, com o mesmo ganho de −3,6 dB e a mesma rampa de entrada de 8 ms.

| Duração e saída (s) | Retorno (s) | Início do crossfade (s) | Crossfade (s) | Ciclo (s) |
| ---: | ---: | ---: | ---: | ---: |
| 12,366009 | 8,510 | 12,286009 | 0,080 | 3,776009 |

O pulso agudo recorrente fica perto de 0,472 s. Nos sinais reconstruídos em PCM, o intervalo entre os ataques agudos que cercam a emenda passou de cerca de 0,503 s na edição publicada para 0,468 s. A nova sobreposição atravessa a cauda de dois ataques equivalentes, em torno de 8,424 e 12,201 s, e termina antes do próximo acento forte. As alternativas de dois e três motivos avaliadas tinham maior contraste nas notas sustentadas em torno da emenda. A frase mais curta preserva melhor essa textura, embora a repetição possa ficar reconhecível durante uma perseguição longa.

O FFprobe confirmou a duração e o FFmpeg decodificou o OGG completo sem erro. Seis emendas foram simuladas em PCM com curva de potência constante e com os passos de ganho de 40 ms do player. Nenhuma amostra saturou e o pico verdadeiro ficou em −4,8 dBTP. Nos ciclos isolados, o loudness integrado passou de −15,5 para −15,7 LUFS. Na curva contínua, o maior salto entre amostras nas bordas da sobreposição passou de −20,62 para −22,49 dBFS. A simulação com atraso ou adiantamento de 20 ms entre as vozes mostrou sensibilidade ao alinhamento nos passos de ganho. A aprovação auditiva em sala fica com o GM.
