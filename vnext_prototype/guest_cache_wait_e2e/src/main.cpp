#include <Arduino.h>

// Espera da CPU1 pelo cache da flash: firmware de cache_wait_e2e_real_qemu
// (LASECSIMUL_TEST_CACHE_WAIT_FIRMWARE). Tudo é observado pelo próprio firmware, sem registrador de
// diagnóstico. Como o ESP-IDF faz antes de mexer no cache da outra CPU, a CPU0 primeiro pede que a CPU1
// estacione: interrupções desligadas, girando na IRAM. Sem isso a CPU1 pode parar na flash dentro do
// FreeRTOS (a troca de contexto compara a pilha com um padrão na flash) segurando o lock do kernel, e
// a CPU0 trava no tick esperando por ele -- no chip também. Depois a CPU0 desliga o cache da CPU1
// (DPORT_APP_CACHE_CTRL) e manda o comando; a CPU1, que só executa da IRAM e lê da DRAM, marca que
// chegou e faz um acesso à flash. A CPU0 confere que ela parou ali (contador congelado, comando sem
// terminar) e religa o cache. Seis cenários, em ordem:
//  - DROM: leitura de dado na flash termina com o valor certo depois de religar o cache;
//  - FETCH: busca de instrução na flash executa a função uma vez só;
//  - RUNSTALL / CLKGATE: com a CPU1 parada por RUNSTALL ou sem clock, religar o cache não a solta;
//    ela termina quando volta a rodar;
//  - SELF_ILLEGAL: a CPU1 desligando o próprio cache não espera; a leitura devolve 0xBAADBAAD;
//  - RESET_WAIT: um reset da CPU1 durante a espera cancela o acesso antigo; a CPU1 volta pela ROM
//    no endereço de boot que a CPU0 definiu (como o ESP-IDF faz no boot).
// Cada cenário imprime "E131 <nome> PASS" ou "E131 <nome> FAIL check=..."; no fim, "E131_DONE".

extern "C" {
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "soc/dport_reg.h"
#include "soc/soc.h"
#include "soc/timer_group_reg.h"
void ets_set_appcpu_boot_addr(uint32_t start);
}

enum : uint32_t {
    kIdle = 0,
    kDrom = 1,
    kFetch = 2,
    kRunstall = 3,
    kClkgate = 4,
    kSelfIllegal = 5,
    kResetWait = 6,
};

static constexpr uint32_t kDromValue = 0xE131D00D;
static constexpr uint32_t kSelfValue = 0xE131D5E1;
static constexpr uint32_t kResetValue = 0xE131D6E5;
static constexpr uint32_t kIllegalSentinel = 0xBAADBAAD;
static constexpr uint32_t kToken = 0xE1310003;

// Dados na flash (.flash.rodata).
extern "C" const uint32_t e131_drom_value __attribute__((used)) = kDromValue;
extern "C" const uint32_t e131_self_value __attribute__((used)) = kSelfValue;
extern "C" const uint32_t e131_reset_value __attribute__((used)) = kResetValue;

extern "C" {
volatile uint32_t e131_request __attribute__((used)) = kIdle;
volatile uint32_t e131_parked __attribute__((used)) = kIdle;
volatile uint32_t e131_cmd __attribute__((used)) = kIdle;
volatile uint32_t e131_started __attribute__((used)) = kIdle;
volatile uint32_t e131_done __attribute__((used)) = kIdle;
volatile uint32_t e131_value __attribute__((used)) = 0;
volatile uint32_t e131_alive __attribute__((used)) = 0;
volatile uint32_t e131_fetch_effects __attribute__((used)) = 0;
volatile uint32_t e131_runstall_effects __attribute__((used)) = 0;
volatile uint32_t e131_clkgate_effects __attribute__((used)) = 0;
volatile uint32_t e131_reset_old_path_effects __attribute__((used)) = 0;
volatile uint32_t e131_reset_entries __attribute__((used)) = 0;
}

// Código na flash (.flash.text), uma função por cenário: o QEMU nunca traduziu cada uma antes do
// acesso com o cache desligado, como num chip recém-ligado. Constantes diferentes evitam que o
// compilador junte as três.
extern "C" uint32_t __attribute__((noinline, used)) e131_fetch_target(uint32_t token)
{
    e131_fetch_effects = e131_fetch_effects + 1;
    return token ^ 0x0000F37F;
}

extern "C" uint32_t __attribute__((noinline, used)) e131_runstall_target(uint32_t token)
{
    e131_runstall_effects = e131_runstall_effects + 1;
    return token ^ 0x00005A11;
}

extern "C" uint32_t __attribute__((noinline, used)) e131_clkgate_target(uint32_t token)
{
    e131_clkgate_effects = e131_clkgate_effects + 1;
    return token ^ 0x0000C1C6;
}

using E131FlashFn = uint32_t (*)(uint32_t);
extern "C" {
volatile E131FlashFn e131_fetch_fn __attribute__((used)) = e131_fetch_target;
volatile E131FlashFn e131_runstall_fn __attribute__((used)) = e131_runstall_target;
volatile E131FlashFn e131_clkgate_fn __attribute__((used)) = e131_clkgate_target;
}

extern "C" uint32_t IRAM_ATTR __attribute__((noinline, used)) e131_mmio_read(uint32_t addr)
{
    return *(volatile uint32_t *)addr;
}

extern "C" void IRAM_ATTR __attribute__((noinline, used)) e131_mmio_write(uint32_t addr, uint32_t value)
{
    *(volatile uint32_t *)addr = value;
    asm volatile("memw" ::: "memory");
}

extern "C" void IRAM_ATTR __attribute__((noinline, used)) e131_app_cache_enable(uint32_t enabled)
{
    uint32_t ctrl = e131_mmio_read(DPORT_APP_CACHE_CTRL_REG);
    if (enabled) {
        ctrl |= DPORT_APP_CACHE_ENABLE;
    } else {
        ctrl &= ~DPORT_APP_CACHE_ENABLE;
    }
    e131_mmio_write(DPORT_APP_CACHE_CTRL_REG, ctrl);
}

// CPU1 depois do reset: a ROM salta para cá (endereço de boot). Só IRAM e DRAM, sem interrupções.
extern "C" void IRAM_ATTR __attribute__((noinline, used)) e131_reset_entry(void)
{
    e131_reset_entries = e131_reset_entries + 1;
    for (;;) {
        e131_alive = e131_alive + 1;
        asm volatile("memw; nop" ::: "memory");
    }
}

// CPU1: tarefa comum do FreeRTOS até a CPU0 pedir um cenário; então estaciona (interrupções até o
// nível do kernel desligadas, sem segurar lock nenhum), espera o comando sem tocar na flash (if em vez
// de switch: a tabela de saltos de um switch fica na flash) e executa o acesso do cenário.
extern "C" void IRAM_ATTR __attribute__((noinline, used)) e131_app_worker(void *)
{
    for (;;) {
        uint32_t cmd;
        while ((cmd = e131_request) == e131_done) {
            e131_alive = e131_alive + 1;
            asm volatile("memw; nop" ::: "memory");
        }
        uint32_t ps;
        asm volatile("rsil %0, 3" : "=r"(ps)::"memory");
        e131_parked = cmd;
        asm volatile("memw" ::: "memory");
        while (e131_cmd != cmd) {
            e131_alive = e131_alive + 1;
            asm volatile("memw; nop" ::: "memory");
        }
        e131_started = cmd;
        asm volatile("memw" ::: "memory");
        if (cmd == kDrom) {
            e131_value = *(volatile const uint32_t *)&e131_drom_value;
        } else if (cmd == kFetch) {
            E131FlashFn fn = e131_fetch_fn;
            e131_value = fn(kToken);
        } else if (cmd == kRunstall) {
            E131FlashFn fn = e131_runstall_fn;
            e131_value = fn(kToken);
        } else if (cmd == kClkgate) {
            E131FlashFn fn = e131_clkgate_fn;
            e131_value = fn(kToken);
        } else if (cmd == kSelfIllegal) {
            e131_app_cache_enable(0);
            e131_value = *(volatile const uint32_t *)&e131_self_value;
            e131_app_cache_enable(1);
        } else if (cmd == kResetWait) {
            e131_value = *(volatile const uint32_t *)&e131_reset_value;
            e131_reset_old_path_effects = e131_reset_old_path_effects + 1;
        }
        asm volatile("memw" ::: "memory");
        e131_done = cmd;
        asm volatile("wsr %0, ps; rsync" ::"r"(ps) : "memory");
    }
}

static const char *scenario_name(uint32_t scenario)
{
    static const char *const names[] = {"IDLE", "DROM", "FETCH", "RUNSTALL", "CLKGATE", "SELF_ILLEGAL", "RESET_WAIT"};
    return scenario < sizeof(names) / sizeof(names[0]) ? names[scenario] : "UNKNOWN";
}

static uint32_t s_failures = 0;

static bool check(uint32_t scenario, const char *name, bool ok, uint32_t observed, uint32_t expected)
{
    if (!ok) {
        ++s_failures;
        Serial.printf("E131 %s FAIL check=%s observed=0x%08lx expected=0x%08lx\n", scenario_name(scenario), name,
                      (unsigned long)observed, (unsigned long)expected);
    }
    return ok;
}

// O chip e' um ESP32 ECO3 (revisao 3): o ESP-IDF encurta o primeiro estagio do watchdog de interrupcao para
// 20 ms (300 ms / 15) e o seu tratador (highint_hdl.S, handle_livelock_int) espera as duas CPUs entrarem nele.
// Com a CPU1 presa de proposito -- interrupcoes ate' o nivel 3 desligadas e parada no cache, sem atender
// interrupcao nenhuma -- num chip de verdade o reset do TG1 viria; enquanto isso a CPU0 alimenta o TG1.
static void IRAM_ATTR feed_int_wdt(void)
{
    WRITE_PERI_REG(TIMG_WDTWPROTECT_REG(1), TIMG_WDT_WKEY_VALUE);
    WRITE_PERI_REG(TIMG_WDTFEED_REG(1), 1);
    WRITE_PERI_REG(TIMG_WDTWPROTECT_REG(1), 0);
}

static void hold_ms(uint32_t ms)
{
    const uint32_t start = millis();
    while (millis() - start < ms) {
        feed_int_wdt();
        delay(1);
    }
}

static bool wait_for(volatile uint32_t &field, uint32_t value, uint32_t timeout_ms)
{
    const uint32_t start = millis();
    while (field != value && millis() - start < timeout_ms) {
        feed_int_wdt();
        delay(1);
    }
    return field == value;
}

// A CPU1 chegou ao acesso do cenário e parou nele: o contador não anda e o comando não termina.
static bool held_at_access(uint32_t scenario)
{
    if (!check(scenario, "reached_access", wait_for(e131_started, scenario, 1000), e131_started, scenario)) {
        return false;
    }
    const uint32_t alive = e131_alive;
    hold_ms(20);
    bool ok = check(scenario, "cpu1_stopped", e131_alive == alive, e131_alive, alive);
    ok = check(scenario, "not_finished", e131_done != scenario, e131_done, kIdle) && ok;
    ok = check(scenario, "no_value_yet", e131_value == 0, e131_value, 0) && ok;
    return ok;
}

// A CPU1 estacionou para o cenário: só então o cache dela pode sair.
static bool park(uint32_t scenario)
{
    e131_value = 0;
    e131_started = kIdle;
    e131_request = scenario;
    return check(scenario, "cpu1_parked", wait_for(e131_parked, scenario, 1000), e131_parked, scenario);
}

static void report(uint32_t scenario, uint32_t failures_before)
{
    if (s_failures == failures_before) {
        Serial.printf("E131 %s PASS value=0x%08lx\n", scenario_name(scenario), (unsigned long)e131_value);
    }
}

static void run_cache_wait(uint32_t scenario, uint32_t expected, volatile uint32_t *effects)
{
    const uint32_t failures = s_failures;
    if (!park(scenario)) {
        return;
    }
    e131_app_cache_enable(0);
    e131_cmd = scenario;
    const bool held = held_at_access(scenario);
    e131_app_cache_enable(1);
    if (held && check(scenario, "finished_after_release", wait_for(e131_done, scenario, 1000), e131_done, scenario)) {
        check(scenario, "value", e131_value == expected, e131_value, expected);
        if (effects) {
            check(scenario, "executed_once", *effects == 1, *effects, 1);
        }
    }
    report(scenario, failures);
}

static void run_hold_release(uint32_t scenario, uint32_t hold_reg, uint32_t hold_value, uint32_t run_value,
                             uint32_t expected, volatile uint32_t *effects)
{
    const uint32_t failures = s_failures;
    if (!park(scenario)) {
        return;
    }
    e131_app_cache_enable(0);
    e131_cmd = scenario;
    const bool held = held_at_access(scenario);
    e131_mmio_write(hold_reg, hold_value);
    e131_app_cache_enable(1);
    if (held) {
        const uint32_t alive = e131_alive;
        hold_ms(50);
        check(scenario, "held_after_release", e131_done != scenario && e131_alive == alive, e131_done, kIdle);
        check(scenario, "no_effect_while_held", *effects == 0, *effects, 0);
    }
    e131_mmio_write(hold_reg, run_value);
    if (held && check(scenario, "finished_after_run", wait_for(e131_done, scenario, 1000), e131_done, scenario)) {
        check(scenario, "value", e131_value == expected, e131_value, expected);
        check(scenario, "executed_once", *effects == 1, *effects, 1);
    }
    report(scenario, failures);
}

static void run_self_illegal(void)
{
    const uint32_t failures = s_failures;
    // Sem a interrupção de acesso ilegal ao cache: com ela o ESP-IDF entra em pânico de propósito.
    const uint32_t saved = e131_mmio_read(DPORT_CACHE_IA_INT_EN_REG);
    e131_mmio_write(DPORT_CACHE_IA_INT_EN_REG, 0);
    if (park(kSelfIllegal)) {
        e131_cmd = kSelfIllegal;
    }
    if (e131_parked == kSelfIllegal && check(kSelfIllegal, "finished", wait_for(e131_done, kSelfIllegal, 1000), e131_done, kSelfIllegal)) {
        check(kSelfIllegal, "illegal_value", e131_value == kIllegalSentinel, e131_value, kIllegalSentinel);
    }
    e131_mmio_write(DPORT_CACHE_IA_INT_EN_REG, saved);
    check(kSelfIllegal, "int_en_restored", e131_mmio_read(DPORT_CACHE_IA_INT_EN_REG) == saved,
          e131_mmio_read(DPORT_CACHE_IA_INT_EN_REG), saved);
    report(kSelfIllegal, failures);
}

static void run_reset_wait(void)
{
    const uint32_t failures = s_failures;
    if (!park(kResetWait)) {
        return;
    }
    e131_app_cache_enable(0);
    e131_cmd = kResetWait;
    const bool held = held_at_access(kResetWait);
    ets_set_appcpu_boot_addr((uint32_t)&e131_reset_entry);
    e131_mmio_write(DPORT_APPCPU_CTRL_A_REG, DPORT_APPCPU_RESETTING);
    hold_ms(2);
    e131_mmio_write(DPORT_APPCPU_CTRL_A_REG, 0);
    e131_app_cache_enable(1);
    if (held && check(kResetWait, "cpu1_rebooted", wait_for(e131_reset_entries, 1, 1000), e131_reset_entries, 1)) {
        const uint32_t alive = e131_alive;
        hold_ms(60);
        check(kResetWait, "cpu1_running", e131_alive != alive, e131_alive, alive);
        check(kResetWait, "rebooted_once", e131_reset_entries == 1, e131_reset_entries, 1);
        check(kResetWait, "old_access_cancelled", e131_reset_old_path_effects == 0 && e131_value == 0,
              e131_reset_old_path_effects, 0);
    }
    report(kResetWait, failures);
}

static void controller_task(void *)
{
    delay(100);
    Serial.printf("E131_BEGIN drom=0x%08lx fetch=0x%08lx worker=0x%08lx\n", (unsigned long)(uintptr_t)&e131_drom_value,
                  (unsigned long)(uintptr_t)&e131_fetch_target, (unsigned long)(uintptr_t)&e131_app_worker);
    // A CPU1 está no laço de espera.
    const uint32_t alive = e131_alive;
    delay(10);
    if (check(kIdle, "worker_running", e131_alive != alive, e131_alive, alive)) {
        run_cache_wait(kDrom, kDromValue, nullptr);
        run_cache_wait(kFetch, kToken ^ 0x0000F37F, &e131_fetch_effects);
        run_hold_release(kRunstall, DPORT_APPCPU_CTRL_C_REG, DPORT_APPCPU_RUNSTALL, 0, kToken ^ 0x00005A11,
                         &e131_runstall_effects);
        run_hold_release(kClkgate, DPORT_APPCPU_CTRL_B_REG, 0, DPORT_APPCPU_CLKGATE_EN, kToken ^ 0x0000C1C6,
                         &e131_clkgate_effects);
        run_self_illegal();
        run_reset_wait();  // por último: depois dele a CPU1 fica fora do FreeRTOS
    }
    Serial.printf("E131_DONE %s failures=%lu\n", s_failures == 0 ? "PASS" : "FAIL", (unsigned long)s_failures);
    for (;;) hold_ms(1000); // a CPU1 nao volta ao FreeRTOS: o TG1 so' e' alimentado daqui
}

void setup()
{
    Serial.begin(115200);
    delay(200);
    xTaskCreatePinnedToCore(controller_task, "e131_ctl", 4096, nullptr, 4, nullptr, 0);
    xTaskCreatePinnedToCore(e131_app_worker, "e131_app", 4096, nullptr, 5, nullptr, 1);
    vTaskDelete(nullptr);
}

void loop()
{
    delay(1000);
}
