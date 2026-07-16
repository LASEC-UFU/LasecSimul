#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>

#include "esp_eth.h"
#include "esp_eth_mac.h"
#include "esp_eth_netif_glue.h"
#include "esp_eth_phy.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "lwip/inet.h"
#include "lwip/netdb.h"

static const char *TAG = "lasecsimul-net";
static EventGroupHandle_t network_events;
static const EventBits_t GOT_IPV4 = BIT0;

static void on_got_ip(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    const ip_event_got_ip_t *event = data;
    ESP_LOGI(TAG, "DHCP: ip=" IPSTR " mask=" IPSTR " gateway=" IPSTR,
             IP2STR(&event->ip_info.ip), IP2STR(&event->ip_info.netmask),
             IP2STR(&event->ip_info.gw));
    xEventGroupSetBits(network_events, GOT_IPV4);
}

static void test_dns_and_http(void)
{
    const struct addrinfo hints = {
        .ai_family = AF_INET,
        .ai_socktype = SOCK_STREAM,
    };
    struct addrinfo *resolved = NULL;
    const int dns_result = getaddrinfo("example.com", "80", &hints, &resolved);
    if (dns_result != 0 || resolved == NULL) {
        ESP_LOGE(TAG, "DNS falhou: %d", dns_result);
        return;
    }

    char address[INET_ADDRSTRLEN] = {0};
    const struct sockaddr_in *remote = (const struct sockaddr_in *)resolved->ai_addr;
    inet_ntop(AF_INET, &remote->sin_addr, address, sizeof(address));
    ESP_LOGI(TAG, "DNS: example.com -> %s", address);

    const int fd = socket(resolved->ai_family, resolved->ai_socktype, resolved->ai_protocol);
    if (fd < 0 || connect(fd, resolved->ai_addr, resolved->ai_addrlen) != 0) {
        ESP_LOGE(TAG, "TCP connect falhou: errno=%d", errno);
        if (fd >= 0) close(fd);
        freeaddrinfo(resolved);
        return;
    }

    static const char request[] =
        "GET / HTTP/1.0\r\nHost: example.com\r\nConnection: close\r\n\r\n";
    if (send(fd, request, sizeof(request) - 1, 0) < 0) {
        ESP_LOGE(TAG, "HTTP send falhou: errno=%d", errno);
    } else {
        char response[128];
        const int received = recv(fd, response, sizeof(response) - 1, 0);
        if (received > 0) {
            response[received] = '\0';
            char *line_end = strstr(response, "\r\n");
            if (line_end) *line_end = '\0';
            ESP_LOGI(TAG, "HTTP: %s", response);
        } else {
            ESP_LOGE(TAG, "HTTP recv falhou: retorno=%d errno=%d", received, errno);
        }
    }

    close(fd);
    freeaddrinfo(resolved);
}

void app_main(void)
{
    network_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP,
                                                on_got_ip, NULL));

    esp_netif_config_t netif_config = ESP_NETIF_DEFAULT_ETH();
    esp_netif_t *netif = esp_netif_new(&netif_config);
    if (netif == NULL) abort();

    eth_mac_config_t mac_config = ETH_MAC_DEFAULT_CONFIG();
    eth_phy_config_t phy_config = ETH_PHY_DEFAULT_CONFIG();
    phy_config.phy_addr = 1;
    phy_config.reset_gpio_num = -1;
    phy_config.autonego_timeout_ms = 100;

    esp_eth_mac_t *mac = esp_eth_mac_new_openeth(&mac_config);
    esp_eth_phy_t *phy = esp_eth_phy_new_dp83848(&phy_config);
    if (mac == NULL || phy == NULL) abort();

    esp_eth_config_t eth_config = ETH_DEFAULT_CONFIG(mac, phy);
    esp_eth_handle_t eth_handle = NULL;
    ESP_ERROR_CHECK(esp_eth_driver_install(&eth_config, &eth_handle));

    const uint8_t mac_address[6] = {0x02, 0x4c, 0x53, 0x00, 0x00, 0x01};
    ESP_ERROR_CHECK(esp_eth_ioctl(eth_handle, ETH_CMD_S_MAC_ADDR,
                                  (void *)mac_address));
    ESP_ERROR_CHECK(esp_netif_attach(netif, esp_eth_new_netif_glue(eth_handle)));
    ESP_ERROR_CHECK(esp_eth_start(eth_handle));

    ESP_LOGI(TAG, "OpenETH iniciado; aguardando DHCP do QEMU/SLIRP");
    xEventGroupWaitBits(network_events, GOT_IPV4, pdFALSE, pdTRUE, portMAX_DELAY);
    test_dns_and_http();
}
