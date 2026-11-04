#include <Arduino.h>
#include "driver/adc.h"
#include "driver/dac.h"

static constexpr int kSamples=96;
void setup() {
    Serial.begin(115200); delay(50);
    dac_output_enable(DAC_CHANNEL_1); dac_output_enable(DAC_CHANNEL_2);
    dac_cw_config_t a{}; a.en_ch=DAC_CHANNEL_1; a.scale=DAC_CW_SCALE_4; a.phase=DAC_CW_PHASE_0; a.freq=1000; a.offset=0;
    dac_cw_config_t b{}; b.en_ch=DAC_CHANNEL_2; b.scale=DAC_CW_SCALE_4; b.phase=DAC_CW_PHASE_180; b.freq=1000; b.offset=0;
    dac_cw_generator_config(&a); dac_cw_generator_config(&b); dac_cw_generator_enable();
    adc1_config_width(ADC_WIDTH_BIT_12);
    adc1_config_channel_atten(ADC1_CHANNEL_6, ADC_ATTEN_DB_11);
    adc1_config_channel_atten(ADC1_CHANNEL_7, ADC_ATTEN_DB_11);
    delay(2);
    int lo1=4095,hi1=0,lo2=4095,hi2=0; long long cross=0; long long sum1=0,sum2=0,sum11=0,sum22=0,sum12=0;
    for(int i=0;i<kSamples;i++) {
        int x=adc1_get_raw(ADC1_CHANNEL_6), y=adc1_get_raw(ADC1_CHANNEL_7);
        if(x<lo1)lo1=x; if(x>hi1)hi1=x; if(y<lo2)lo2=y; if(y>hi2)hi2=y;
        sum1+=x; sum2+=y; sum11+=(long long)x*x; sum22+=(long long)y*y; sum12+=(long long)x*y;
        delayMicroseconds(100);
    }
    cross=kSamples*sum12-sum1*sum2;
    Serial.printf("DACCW n=%d ch1=%d:%d ch2=%d:%d cross=%lld\n",kSamples,lo1,hi1,lo2,hi2,cross);
    Serial.println("DACCW fim");
}
void loop(){delay(1000);}
