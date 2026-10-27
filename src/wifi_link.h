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
#include "protocol.h"

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
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid.c_str(), pass.c_str());
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
static uint32_t dgN = 0, dgUs = 0, txN = 0, txUs = 0, ringMax = 0;
#endif
static void sendPeer(const void* data, size_t n)
{
#ifdef WL_DEBUG
  uint32_t t0 = micros();
#endif
  udp.writeTo((const uint8_t*)data, n, peerIp, peerPort);
#ifdef WL_DEBUG
  txN++; txUs += micros() - t0;
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

static void onDatagram(const uint8_t* b, int n, IPAddress from, uint16_t fport)
{
  if (n >= 3 && b[0] == 'X') {
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
    uint8_t y[15];
    y[0] = 'Y'; put16(y + 1, sid); put32(y + 3, c); put32(y + 7, txWr); put32(y + 11, RING);
    sendPeer(y, sizeof(y));
    return;
  }
  if (!sessionActive || n < 12 || b[0] != 'D' || get16(b + 2) != sid) return;
  if (from != peerIp || fport != peerPort) return;

  uint32_t rAck = get32(b + 8);
  uint32_t wr = txWr;
  if ((int32_t)(rAck - txAcked) > 0 && (int32_t)(wr - rAck) >= 0) txAcked = rAck;
  if (n > 12) onData(get32(b + 4), b + 12, n - 12);
  if (b[1] & 1) requestAck(true);                       // POLL
}

static void tickTx(uint32_t now)
{
  uint32_t acked = txAcked, wr = txWr;
  if (acked == wr) return;
  if (wr == lastSentWr && now - lastTxMs < REPLY_RTO_MS) return;
  uint8_t b[8 + WIFI_PAYLOAD];
  uint32_t len = min<uint32_t>(wr - acked, WIFI_PAYLOAD);
  b[0] = 'R'; b[1] = 0; put16(b + 2, sid); put32(b + 4, acked);
  for (uint32_t i = 0; i < len; i++) b[8 + i] = txRing[(acked + i) & (TX_RING - 1)];
  sendPeer(b, 8 + len);
  lastSentWr = wr;
  lastTxMs = now;
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
      uint8_t ab[16 + 4 * 8 + 6];
      xSemaphoreTake(mtx, portMAX_DELAY);
      tickTx(now);
      int al = pollAck(now, ab);
      xSemaphoreGive(mtx);
      if (al) sendPeer(ab, al);
    }
#ifdef WL_DEBUG
    static uint32_t last = 0;
    if (millis() - last >= 2000) {
      last = millis();
      Serial.printf("WL dg=%u avg=%uus tx=%u avg=%uus ringMax=%u contig-rd=%u cDup=%u cOoo=%u\n", dgN, dgN ? dgUs / dgN : 0, txN, txN ? txUs / txN : 0, ringMax, (unsigned)(contig - rd), cDup, cOoo);
      dgN = dgUs = txN = txUs = ringMax = 0;
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
