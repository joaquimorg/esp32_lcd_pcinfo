#pragma once

/*
 * Transporte Wi-Fi (LCD_WIFI=1): fluxo de bytes fiável sobre UDP, o formato está em
 * protocol.h. O main.cpp só vê dois anéis: wl::read() devolve os bytes PC -> ESP32 que já
 * chegaram em ordem e wl::write() põe respostas na fila. Uma task no core 0 é dona de todo
 * o estado do protocolo (socket, sequências, SACK, retransmissões); o loop() não lhe toca.
 *
 * Só se liga o rádio com credenciais guardadas (PKT_WIFI_SET): quem não usa Wi-Fi não paga
 * nada, nem a RAM do anel (alocado ao arrancar a task).
 *
 * A receção usa AsyncUDP (fila de 64 datagramas): com o recvfrom do lwip (caixa de 6) as rajadas
 * que o Wi-Fi entrega de uma vez transbordavam e perdia-se metade.
 */

#include <WiFi.h>
#include <Preferences.h>
#include <AsyncUDP.h>
#include <esp_wifi.h>
#include "protocol.h"

#ifdef WL_DEBUG
extern volatile uint32_t dbgLoopMs, dbgPackets, dbgErrors;   // main.cpp
#endif

namespace wl {

static const uint32_t RING = WIFI_RING_SIZE;           // potência de 2
static const uint32_t TX_RING = 2048;                  // potência de 2
static const uint32_t REPLY_RTO_MS = 50;

static uint8_t* ring = nullptr;                        // PC -> ESP32
static volatile uint32_t contig = 0;                   // task: tudo antes disto chegou
static volatile uint32_t rd = 0;                       // loop: lido pelo parser
static volatile uint32_t abortTo = 0;
static volatile bool aborted = false;                  // sessão nova: o loop descarta o pacote a meio

static uint8_t txRing[TX_RING];                        // ESP32 -> PC
static volatile uint32_t txWr = 0;                     // loop: escrito até aqui
static volatile uint32_t txAcked = 0;                  // task: o PC confirmou até aqui

static volatile bool sessionActive = false;
static uint16_t sid = 0;
static IPAddress peerIp;
static uint16_t peerPort = 0;
static AsyncUDP udp;
static bool listening = false;
static SemaphoreHandle_t mtx = nullptr;   // o estado é tocado pela task de pacotes do AsyncUDP e pela nossa
static TaskHandle_t task = nullptr;
static Preferences prefs;
static bool credsSet = false;

static struct { uint32_t s, e; } seg[8];               // blocos fora de ordem já copiados para o anel
static int nseg = 0;
static uint32_t cDup = 0, cWin = 0, cOoo = 0;          // contadores enviados no 'A'
static uint32_t lastAckMs = 0, ackContig = 0, ackRd = 0;
static uint32_t lastTxMs = 0, lastSentWr = 0;
static uint8_t yBuf[15];             // resposta a 'X', enviada pela udpTask
static volatile bool yPending = false;

/* ------------------------------ Wi-Fi ------------------------------------ */

static void wifiConnect()
{
  prefs.begin("usblcd", true);
  String ssid = prefs.getString("wssid", ""), pass = prefs.getString("wpass", "");
  prefs.end();
  credsSet = ssid.length() > 0;
  if (!credsSet) return;
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);   // com poupança de energia a latência sobe 100 ms ou mais
  // Só 802.11 b/g (sem 11n). Com o 11n (A-MPDU) a transmissão do ESP32 parava durante 20-40 s de cada
  // vez, enquanto a receção continuava a funcionar: pings e respostas perdidos, a app a desligar-se e
  // a não conseguir voltar (medido com o router de teste: 6-14 quedas em 5 min contra 0 em 190 s, e
  // até mais débito: 0,7-0,8 MB/s). O b/g chega e sobra: dá ~2 MB/s úteis, e a CYD precisa de menos de 1.
  esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid.c_str(), pass.c_str());
#ifdef WL_DEBUG
  WiFi.onEvent([](arduino_event_id_t e, arduino_event_info_t i) {
    Serial.print("WLEV "); Serial.print((int)e);
    if (e == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) { Serial.print(" reason="); Serial.print((int)i.wifi_sta_disconnected.reason); }
    Serial.println();
  });
#endif
}

static uint8_t state()
{
  if (!credsSet) return WSTATE_OFF;
  if (WiFi.status() == WL_CONNECTED) return WSTATE_CONNECTED;
  wl_status_t s = WiFi.status();
  return (s == WL_NO_SSID_AVAIL || s == WL_CONNECT_FAILED) ? WSTATE_FAILED : WSTATE_CONNECTING;
}
static int8_t rssi() { return WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0; }
static void ip(uint8_t out[4])
{
  IPAddress a = WiFi.status() == WL_CONNECTED ? WiFi.localIP() : IPAddress(0, 0, 0, 0);
  for (int i = 0; i < 4; i++) out[i] = a[i];
}

/* ------------------------------ Protocolo -------------------------------- */

// Os offsets dão a volta aos 4 GB (~1 hora a 1 MB/s): compara-se sempre a diferença com sinal.
static inline int32_t sd(uint32_t a, uint32_t b) { return (int32_t)(a - b); }
static inline uint32_t umax(uint32_t a, uint32_t b) { return sd(a, b) >= 0 ? a : b; }
static inline uint32_t umin(uint32_t a, uint32_t b) { return sd(a, b) <= 0 ? a : b; }

static inline void put16(uint8_t* p, uint16_t v) { memcpy(p, &v, 2); }
static inline void put32(uint8_t* p, uint32_t v) { memcpy(p, &v, 4); }
static inline uint16_t get16(const uint8_t* p) { uint16_t v; memcpy(&v, p, 2); return v; }
static inline uint32_t get32(const uint8_t* p) { uint32_t v; memcpy(&v, p, 4); return v; }

#ifdef WL_DEBUG
static uint32_t dgN = 0, dgUs = 0, txN = 0, txUs = 0, ringMax = 0, txFail = 0, txMaxUs = 0;
#endif
static void sendPeer(const void* data, size_t n)
{
#ifdef WL_DEBUG
  uint32_t t0 = micros();
#endif
  size_t sent = udp.writeTo((const uint8_t*)data, n, peerIp, peerPort);
#ifdef WL_DEBUG
  uint32_t dt = micros() - t0;
  txN++; txUs += dt; if (dt > txMaxUs) txMaxUs = dt; if (!sent) txFail++;
#endif
}

// Monta o ACK (chamado com o mutex). Enviar custa ~1,8 ms (AsyncUDP -> tcpip_api_call): por isso
// os ACKs pedem-se e são enviados pela task dos temporizadores, juntando vários num só, e nunca
// dentro do tratamento de um datagrama (senão a fila de receção enche enquanto se envia).
static int buildAck(uint8_t* b)
{
  b[0] = 'A'; b[1] = 0; put16(b + 2, sid);
  uint32_t c = contig, r = rd;
  put32(b + 4, c); put32(b + 8, r);
  int n = min(nseg, 4);
  b[12] = n;
  uint8_t* p = b + 13;
  for (int i = 0; i < n; i++, p += 8) { put32(p, seg[i].s); put32(p + 4, seg[i].e); }
  put16(p, cDup); put16(p + 2, cWin); put16(p + 4, cOoo);
  lastAckMs = millis();
  ackContig = c;
  ackRd = r;
  return p + 6 - b;
}

static bool ackReq = false, ackUrgent = false;
static void requestAck(bool urgent)
{
  ackReq = true;
  ackUrgent = ackUrgent || urgent;
}

static void ringCopy(uint32_t off, const uint8_t* src, uint32_t len)
{
  uint32_t pos = off & (RING - 1), k = min(len, RING - pos);
  memcpy(ring + pos, src, k);
  if (k < len) memcpy(ring, src + k, len - k);
}

// Junta [s, e) aos blocos fora de ordem (ordenados, sem sobreposição).
static void addSeg(uint32_t s, uint32_t e)
{
  int i = 0;
  while (i < nseg && sd(seg[i].e, s) < 0) i++;
  int j = i;
  while (j < nseg && sd(seg[j].s, e) <= 0) { s = umin(s, seg[j].s); e = umax(e, seg[j].e); j++; }
  if (j == i && nseg == 8) return;                      // cheio: o PC retransmite
  if (j > i) {                                          // fundiu blocos
    seg[i] = { s, e };
    memmove(&seg[i + 1], &seg[j], (nseg - j) * sizeof(seg[0]));
    nseg -= (j - i - 1);
  } else {
    memmove(&seg[i + 1], &seg[i], (nseg - i) * sizeof(seg[0]));
    seg[i] = { s, e };
    nseg++;
  }
}

static void onData(uint32_t off, const uint8_t* data, uint32_t len)
{
  uint32_t c = contig;
  if (sd(off + len, c) <= 0) { cDup++; requestAck(true); return; }   // já tinha tudo: o ACK perdeu-se
  if (sd(off, c) < 0) { data += c - off; len -= c - off; off = c; }
  if (sd(off + len, rd + RING) > 0) { cWin++; return; }       // fora da janela: o PC espera pelo consumed
  ringCopy(off, data, len);
  if (off == c) {
    c = off + len;
    while (nseg && sd(seg[0].s, c) <= 0) {              // fecha buracos
      c = umax(c, seg[0].e);
      memmove(&seg[0], &seg[1], (nseg - 1) * sizeof(seg[0]));
      nseg--;
    }
    __atomic_store_n(&contig, c, __ATOMIC_RELEASE);
  } else {
    cOoo++;
    addSeg(off, off + len);
    requestAck(true);                                   // buraco: avisa já para retransmitir
    return;
  }
  requestAck(false);
}

#ifdef WL_DEBUG
static uint32_t dbgX = 0, dbgWrongPeer = 0, dbgWrongSid = 0;
#endif
static void onDatagram(const uint8_t* b, int n, IPAddress from, uint16_t fport)
{
  if (n >= 3 && b[0] == 'X') {
#ifdef WL_DEBUG
    dbgX++; Serial.print("XSESSION from "); Serial.print(from); Serial.print(':'); Serial.println(fport);
#endif
    sid = get16(b + 1);
    peerIp = from;
    peerPort = fport;
    // O que ficou por ler da sessão anterior perde-se; a nova começa onde o anel está.
    uint32_t c = contig;
    nseg = 0;
    abortTo = c;
    aborted = true;
    txAcked = txWr;
    lastSentWr = txWr;
    sessionActive = true;
    // Não se envia daqui: esta função corre na task do AsyncUDP (ver udpTask). O 'Y' sai pela udpTask.
    yBuf[0] = 'Y'; put16(yBuf + 1, sid); put32(yBuf + 3, c); put32(yBuf + 7, txWr); put32(yBuf + 11, RING);
    yPending = true;
    return;
  }
  if (!sessionActive || n < 12 || b[0] != 'D' || get16(b + 2) != sid) {
#ifdef WL_DEBUG
    dbgWrongSid++;
#endif
    return;
  }
  if (from != peerIp || fport != peerPort) {
#ifdef WL_DEBUG
    dbgWrongPeer++;
#endif
    return;
  }

  uint32_t rAck = get32(b + 8);
  uint32_t wr = txWr;
  if ((int32_t)(rAck - txAcked) > 0 && (int32_t)(wr - rAck) >= 0) txAcked = rAck;
  if (n > 12) onData(get32(b + 4), b + 12, n - 12);
  if (b[1] & 1) requestAck(true);                       // POLL
}

// Monta a resposta a (re)enviar e devolve o tamanho (0 = nenhuma). Chamado com o mutex; quem envia é a udpTask, sem ele.
static int tickTx(uint32_t now, uint8_t* b)
{
  uint32_t acked = txAcked, wr = txWr;
  if (acked == wr) return 0;
  if (wr == lastSentWr && now - lastTxMs < REPLY_RTO_MS) return 0;
  uint32_t len = min<uint32_t>(wr - acked, WIFI_PAYLOAD);
  b[0] = 'R'; b[1] = 0; put16(b + 2, sid); put32(b + 4, acked);
  for (uint32_t i = 0; i < len; i++) b[8 + i] = txRing[(acked + i) & (TX_RING - 1)];
  lastSentWr = wr;
  lastTxMs = now;
  return 8 + len;
}

// Devolve o tamanho do ACK a enviar (0 = nenhum). Chamado com o mutex.
static int pollAck(uint32_t now, uint8_t* b)
{
  // O parser libertou espaço (janela) ou chegou algo sem se ter confirmado: avisa o PC.
  if (!ackReq && (contig != ackContig || rd != ackRd) && now - lastAckMs >= 10) ackReq = true;
  if (!ackReq || now - lastAckMs < (ackUrgent ? 2u : 6u)) return 0;
  ackReq = ackUrgent = false;
  return buildAck(b);
}

static void startListening()
{
  if (!udp.listen(WIFI_UDP_PORT)) return;
  udp.onPacket([](AsyncUDPPacket& p) {
    // Esta função corre na task "async_udp" do AsyncUDP, que a biblioteca cria no core 0 com
    // prioridade 3: abaixo da pilha lwip (18), do Wi-Fi (23) e da nossa udpTask (19). Com tráfego
    // intenso fica sem CPU, a fila de 32 datagramas enche e a thread do lwip bloqueia no
    // xQueueSend (sem limite de tempo): deixa de responder a tudo (pings, ACKs) durante segundos.
    // Acima do lwip, esvazia a fila sempre que há datagramas.
    static bool boosted = false;
    if (!boosted) {
      vTaskPrioritySet(nullptr, 21);
      boosted = true;
    }
    xSemaphoreTake(mtx, portMAX_DELAY);
#ifdef WL_DEBUG
    uint32_t t0 = micros();
#endif
    onDatagram(p.data(), p.length(), p.remoteIP(), p.remotePort());
#ifdef WL_DEBUG
    dgN++; dgUs += micros() - t0;
    ringMax = max<uint32_t>(ringMax, contig - rd);
#endif
    xSemaphoreGive(mtx);
  });
  listening = true;
}

// Temporizadores (retransmissão das respostas, ACKs de janela) e vigia da ligação Wi-Fi.
static void udpTask(void*)
{
  for (;;) {
    bool up = WiFi.status() == WL_CONNECTED;
    if (!up && listening) { udp.close(); listening = false; }
    if (up && !listening) startListening();
    if (listening && sessionActive) {
      uint32_t now = millis();
      static uint8_t ab[16 + 4 * 8 + 6], rb[8 + WIFI_PAYLOAD], yb[15];
      int rl, al, yl = 0;
      xSemaphoreTake(mtx, portMAX_DELAY);
      rl = tickTx(now, rb);
      al = pollAck(now, ab);
      if (yPending) { memcpy(yb, yBuf, sizeof(yb)); yl = sizeof(yb); yPending = false; }
      xSemaphoreGive(mtx);
      // Só aqui se envia, sem o mutex: writeTo espera pela thread do lwip, e essa fica bloqueada
      // (xQueueSend sem limite) se a fila do AsyncUDP encher enquanto a sua task espera pelo mutex.
      if (yl) sendPeer(yb, yl);
      if (al) sendPeer(ab, al);
      if (rl) sendPeer(rb, rl);
    }
#ifdef WL_DEBUG
    static uint32_t last = 0;
    if (millis() - last >= 2000) {
      last = millis();
      Serial.printf("WL dg=%u avg=%uus tx=%u avg=%uus ringMax=%u contig-rd=%u cDup=%u cOoo=%u\n", dgN, dgN ? dgUs / dgN : 0, txN, txN ? txUs / txN : 0, ringMax, (unsigned)(contig - rd), cDup, cOoo);
      dgN = dgUs = txN = txUs = ringMax = 0;
    }
#endif
#ifdef WL_DEBUG
    static uint32_t last2 = 0;
    if (millis() - last2 >= 1000) {
      last2 = millis();
      Serial.print("HEAP free="); Serial.print(ESP.getFreeHeap()); Serial.print(" min="); Serial.print(ESP.getMinFreeHeap());
      wifi_ps_type_t ps = WIFI_PS_NONE; esp_wifi_get_ps(&ps);
      Serial.print(" ps="); Serial.print((int)ps); Serial.print(" rssi="); Serial.print(WiFi.RSSI());
      Serial.print(" largest="); Serial.print(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
      Serial.print(" loopAge="); Serial.print(millis() - dbgLoopMs); Serial.print(" pk="); Serial.print(dbgPackets); Serial.print(" err="); Serial.print(dbgErrors);
      Serial.print(" X="); Serial.print(dbgX); Serial.print(" wrongSid="); Serial.print(dbgWrongSid); Serial.print(" wrongPeer="); Serial.print(dbgWrongPeer);
      Serial.print(" txN="); Serial.print(txN); Serial.print(" txFail="); Serial.print(txFail); Serial.print(" txMaxUs="); Serial.print(txMaxUs); txN = txFail = txMaxUs = 0;
      Serial.print(" sess="); Serial.print((int)sessionActive); Serial.print(" contig-rd="); Serial.println((unsigned)(contig - rd));
    }
#endif
    vTaskDelay(2);
  }
}

/* ------------------------------ API -------------------------------------- */

static void start()
{
  if (task) return;
  mtx = xSemaphoreCreateMutex();
  ring = (uint8_t*)heap_caps_malloc(RING, MALLOC_CAP_8BIT);
  if (!ring) return;
  xTaskCreatePinnedToCore(udpTask, "wifi_udp", 6144, nullptr, 19, &task, 0);
}

static void begin()
{
  wifiConnect();
  if (credsSet) start();
}

// Guarda as credenciais e (re)liga. ssid vazio desliga o Wi-Fi.
static void configure(const String& ssid, const String& pass)
{
  prefs.begin("usblcd", false);
  prefs.putString("wssid", ssid);
  prefs.putString("wpass", pass);
  prefs.end();
  WiFi.disconnect(true, false);
  sessionActive = false;
  if (!ssid.length()) {
    credsSet = false;
    WiFi.mode(WIFI_OFF);
    return;
  }
  wifiConnect();
  start();
}

// Bytes PC -> ESP32 já em ordem. Chamado só pelo loop().
static size_t read(void* dst, size_t n)
{
  uint32_t r = rd, avail = __atomic_load_n(&contig, __ATOMIC_ACQUIRE) - r;
  if (!avail) return 0;
  uint32_t k = min<uint32_t>(n, avail), pos = r & (RING - 1), first = min(k, RING - pos);
  memcpy(dst, ring + pos, first);
  if (first < k) memcpy((uint8_t*)dst + first, ring, k - first);
  __atomic_store_n(&rd, r + k, __ATOMIC_RELEASE);
  return k;
}

// Sessão nova desde a última chamada? Descarta o que sobrou da anterior (só o loop() lê rd).
static bool takeAbort()
{
  if (!aborted) return false;
  aborted = false;
  rd = abortTo;
  return true;
}

// Resposta para o PC. Se o PC não estiver a ler, desiste ao fim de 100 ms.
static void write(const void* data, size_t n)
{
  if (!sessionActive) return;
  const uint8_t* p = (const uint8_t*)data;
  uint32_t start = millis();
  while (n) {
    uint32_t used = txWr - txAcked;
    if (used >= TX_RING) {
      if (millis() - start >= 100) return;
      vTaskDelay(1);
      continue;
    }
    uint32_t k = min<uint32_t>(n, TX_RING - used);
    uint32_t wr = txWr;
    for (uint32_t i = 0; i < k; i++) txRing[(wr + i) & (TX_RING - 1)] = p[i];
    __atomic_store_n(&txWr, wr + k, __ATOMIC_RELEASE);
    p += k; n -= k;
  }
}

}  // namespace wl
