/* Authored procedural ambience. No recordings, scene IDs, filesystem access or
 * transport work on the mixer. Trigonometry/exponentials run at control rate;
 * sample-rate oscillators interpolate a 4 KiB sine table. */
#include "audio.h"
#include <math.h>
#include <stdint.h>
#include <string.h>
#ifndef ATLAS_AUDIO_TEST
#include <3ds.h>
#include <errno.h>
#include <stdatomic.h>
#endif

#define RATE 44100.0f
#define FRAMES 1024
#define CONTROL 256
#define TABLE 1024
#define PI 3.14159265358979323846f
static float clampf(float v,float lo,float hi){return fminf(fmaxf(v,lo),hi);}
static float phase(float v,float period){return v-floorf(v/period)*period;}
static uint32_t hash(uint32_t n){n^=n>>16;n*=0x7feb352d;n^=n>>15;n*=0x846ca68b;return n^(n>>16);}
static bool unit(float v){return v>=0 && v<=1;}
static bool in_loop(float v,const float *r){return v>=0 && v<=r[1];}
static bool valid(const float *r,size_t count){
    if(!r || count!=32)return false;
    for(unsigned i=0;i<32;i++)if(!isfinite(r[i]))return false;
    if(r[0]!=1 || r[1]<1 || r[1]>3600 || !unit(r[2]) || !unit(r[3]) || !in_loop(r[4],r)
       || r[6]<0 || r[6]>16777215 || floorf(r[6])!=r[6] || (r[3]>0 && r[5]<1)
       || (r[7]!=0 && r[7]!=1))return false;
    for(unsigned i=21;i<32;i++)if(r[i]!=0)return false;
    return r[7]==0 || (in_loop(r[8],r) && in_loop(r[9],r) && in_loop(r[10],r)
       && in_loop(r[13],r) && in_loop(r[14],r) && r[8]<r[9] && r[13]<r[14]
       && r[11]>0 && r[12]>0 && unit(r[19]) && unit(r[20]));
}
typedef struct {float train[2],bell[2],bird_gain,bird_hz;} Controls;
typedef struct {float sine[TABLE],oscillators[5],wind_low,wind_body,train_low,fade;uint32_t seed;} Synth;
static float spatial(const float d[3],const float right[3],float spread,float pan[2]){
    float distance=sqrtf(d[0]*d[0]+d[1]*d[1]+d[2]*d[2]);
    float p=distance>0.0001f?clampf((d[0]*right[0]+d[1]*right[1]+d[2]*right[2])/distance*spread,-1,1):0;
    pan[0]=sqrtf((1-p)*0.5f);pan[1]=sqrtf((1+p)*0.5f);return distance;
}
static Controls controls(const float r[32],float t,const float eye[3],const float right[3]){
    Controls out={0};t=phase(t,r[1]);
    if(r[7]!=0){
        float s=sinf(r[18]),c=sinf(r[18]+PI/2),front=(t-r[10])*r[11];
        float x=clampf((eye[0]-r[15])*c-(eye[2]-r[17])*s,front-r[12],front),pan[2];
        float d[3]={r[15]+x*c-eye[0],r[16]+0.7f-eye[1],r[17]-x*s-eye[2]};
        float distance=spatial(d,right,0.85f,pan),clatter=fmaxf(0,sinf(front*PI/10+PI/2));
        float clatter2=clatter*clatter,clatter4=clatter2*clatter2;
        float gain=t>=r[13] && t<r[14]?r[19]*(0.88f+0.12f*clatter4*clatter4)/powf(1+distance/13,1.6f):0;
        out.train[0]=gain*pan[0];out.train[1]=gain*pan[1];
        float bell[3]={r[15]-eye[0],r[16]-eye[1],r[17]-eye[2]};distance=spatial(bell,right,0.8f,pan);
        float pulse=expf(-phase(t*2.2f,1)*5);
        gain=t>=r[8] && t<r[9]?r[20]*pulse/(1+distance/22):0;
        out.bell[0]=gain*pan[0];out.bell[1]=gain*pan[1];
    }
    if(r[3]>0){
        int base=(int)floorf((t-r[4])/r[5]);
        for(int index=base-1;index<=base+1;index++){
            if(index<0)continue;
            uint32_t random=hash((uint32_t)index+(uint32_t)r[6]);
            float jitter=index?((random&65535)/65535.0f-0.5f)*fminf(r[5]*0.4f,4):0;
            float start=r[4]+index*r[5]+jitter,elapsed=t-start;
            if(elapsed<0 || elapsed>=0.58f)continue;
            float note=floorf(elapsed/0.2f),age=elapsed-note*0.2f;if(age>=0.16f)continue;
            float hz=2500+note*200;
            out.bird_hz=age<0.085f?hz*powf(4100/hz,age/0.085f):4100*powf(2700.0f/4100,(age-0.085f)/0.065f);
            float envelope=age<0.02f?age/0.02f:powf(0.004f,(age-0.02f)/0.14f);
            out.bird_gain=r[3]*envelope*clampf((r[1]-t)/0.02f,0,1);
        }
    }
    return out;
}
static void synth_init(Synth *s){memset(s,0,sizeof(*s));s->seed=1;for(unsigned i=0;i<TABLE;i++)s->sine[i]=sinf(i*2*PI/TABLE);}
static void synth_seek(Synth *s,float t,const float r[32]){
    static const float hz[5]={126,251,1046,1568,3000};t=phase(t,r[1]);
    s->seed=hash((uint32_t)(t*RATE)^(uint32_t)r[6]);if(!s->seed)s->seed=1;
    for(unsigned i=0;i<5;i++)s->oscillators[i]=phase(t*hz[i],1)*TABLE;
    s->wind_low=s->wind_body=s->train_low=s->fade=0;
}
static float oscillator(Synth *s,unsigned index,float hz){
    float p=s->oscillators[index];unsigned i=(unsigned)p;float f=p-i;
    float v=s->sine[i&(TABLE-1)]*(1-f)+s->sine[(i+1)&(TABLE-1)]*f;p+=hz*(TABLE/RATE);
    s->oscillators[index]=p>=TABLE?p-TABLE:p;return v;
}
static float blend(float a,float b,float f){return a+(b-a)*f;}
static void synth_render(Synth *s,const float r[32],float time,const float eye[3],const float right[3],int16_t out[FRAMES*2]){
    for(unsigned block=0;block<FRAMES/CONTROL;block++){
        float t=time+(block*CONTROL)/RATE;Controls a=controls(r,t,eye,right),b=controls(r,t+CONTROL/RATE,eye,right);
        for(unsigned j=0;j<CONTROL;j++){
            float f=(float)j/CONTROL;s->seed^=s->seed<<13;s->seed^=s->seed>>17;s->seed^=s->seed<<5;
            float white=(int32_t)s->seed/2147483648.0f;
            s->wind_low+=0.1266f*(white-s->wind_low);s->wind_body+=0.01835f*(white-s->wind_body);s->train_low+=0.1153f*(white-s->train_low);
            float wind=(s->wind_low*0.05f+s->wind_body*0.06f)*r[2];
            float train=s->train_low+oscillator(s,0,126)*0.08f+oscillator(s,1,251)*0.023f;
            float bell=oscillator(s,2,1046)*0.055f+oscillator(s,3,1568)*0.014f;
            float bird=oscillator(s,4,blend(a.bird_hz,b.bird_hz,f))*blend(a.bird_gain,b.bird_gain,f);
            s->fade=fminf(s->fade+1/(RATE*0.015f),1);
            for(unsigned ch=0;ch<2;ch++){float v=wind+bird+train*blend(a.train[ch],b.train[ch],f)+bell*blend(a.bell[ch],b.bell[ch],f);out[(block*CONTROL+j)*2+ch]=(int16_t)(clampf(v,-0.95f,0.95f)*s->fade*32767);}
        }
    }
}

#ifndef ATLAS_AUDIO_TEST
#define SLOTS 2
static float recipe[32];
static atomic_uint sequence,clock_data[9];
static atomic_bool running,ready;
static Thread worker;
static bool dsp_live;
static const char *init_stage="none";
static uint32_t init_result;
static int init_errno;
static ndspWaveBuf waves[SLOTS];
static Synth synth;
static void release_audio(void);
static uint32_t bits(float f){uint32_t u;memcpy(&u,&f,4);return u;}
static float number(uint32_t u){float f;memcpy(&f,&u,4);return f;}
static bool snapshot(uint32_t out[9]){
    /* Bounded retry: spinning on an interrupted lower-priority writer could
     * starve it indefinitely on a single CPU. A missed block is silent. */
    unsigned seq=atomic_load(&sequence);if(seq&1)return false;
    for(unsigned i=0;i<9;i++)out[i]=atomic_load(&clock_data[i]);
    return seq==atomic_load(&sequence);
}
static void clear_queue(void){ndspChnWaveBufClear(0);for(unsigned i=0;i<SLOTS;i++)waves[i].status=NDSP_WBUF_FREE;}
static void mix(void *unused){
    (void)unused;float previous=NAN;bool silent=true;synth_init(&synth);
    while(atomic_load(&running)){
        uint32_t state[9];if(!snapshot(state)){svcSleepThread(1000000);continue;}
        uint32_t age=(uint32_t)osGetTime()-state[7];
        if(state[8] || age>250){if(!silent)clear_queue();silent=true;previous=NAN;svcSleepThread(2000000);continue;}
        float time=number(state[0])+age/1000.0f;
        float eye[3]={number(state[1]),number(state[2]),number(state[3])},right[3]={number(state[4]),number(state[5]),number(state[6])};
        unsigned queued=0;for(unsigned i=0;i<SLOTS;i++)if(waves[i].status==NDSP_WBUF_QUEUED)queued+=FRAMES;else if(waves[i].status==NDSP_WBUF_PLAYING){unsigned pos=ndspChnGetSamplePos(0);queued+=pos<FRAMES?FRAMES-pos:0;}
        time+=queued/RATE;
        if(!isfinite(previous) || fabsf(time-previous)>0.08f){clear_queue();queued=0;time=number(state[0])+age/1000.0f;synth_seek(&synth,time,recipe);previous=time;}
        for(unsigned i=0;i<SLOTS;i++)if(waves[i].status==NDSP_WBUF_FREE || waves[i].status==NDSP_WBUF_DONE){
            /* Follow wall/scene time at buffer boundaries; waveform state stays
             * continuous, while seek/mute explicitly restarts a 15 ms fade. */
            synth_render(&synth,recipe,time,eye,right,waves[i].data_pcm16);
            DSP_FlushDataCache(waves[i].data_vaddr,FRAMES*4);waves[i].nsamples=FRAMES;waves[i].looping=false;
            ndspChnWaveBufAdd(0,&waves[i]);time+=FRAMES/RATE;previous=time;silent=false;
        }
        svcSleepThread(1000000);
    }
    clear_queue();
}
bool atlas_audio_load(const float *r,size_t count){
    release_audio();init_stage="none";init_result=0;init_errno=0;
    if(!r && count==0)return true;
    init_stage="recipe";if(!valid(r,count))return false;memcpy(recipe,r,sizeof(recipe));
    /* libctru searches SD:/3ds/dspfirm.cdc, then the hb:ndsp loader handle.
     * Keep its actual Result: not-found can mean missing/unreadable component
     * or a component allocation failure, so ready=false alone is insufficient. */
    init_stage="ndsp-init";Result result=ndspInit();init_result=(uint32_t)result;
    if(R_FAILED(result))return true;
    init_result=0;
    dsp_live=true;
    ndspSetOutputMode(NDSP_OUTPUT_STEREO);ndspChnReset(0);ndspChnSetInterp(0,NDSP_INTERP_LINEAR);ndspChnSetRate(0,RATE);ndspChnSetFormat(0,NDSP_FORMAT_STEREO_PCM16);
    float volume[12]={0};volume[0]=volume[1]=0.75f;ndspChnSetMix(0,volume);
    init_stage="pcm-alloc";
    for(unsigned i=0;i<SLOTS;i++){
        errno=0;waves[i].data_vaddr=linearMemAlign(FRAMES*4,0x80);
        if(!waves[i].data_vaddr){init_errno=errno;release_audio();return true;}
        waves[i].status=NDSP_WBUF_FREE;
    }
    atomic_store(&sequence,0);atomic_store(&clock_data[8],3);atomic_store(&running,true);
    init_stage="worker-create";errno=0;worker=threadCreate(mix,NULL,16*1024,0x3e,-2,false);
    if(!worker){init_errno=errno;release_audio();return true;}
    init_stage="ready";
    atomic_store(&ready,true);return true;
}
void atlas_audio_update(float time,const float eye[3],const float right[3],bool muted,bool paused){
    bool sane=isfinite(time);for(unsigned i=0;i<3;i++)sane=sane && isfinite(eye[i]) && isfinite(right[i]);
    atomic_fetch_add(&sequence,1);atomic_store(&clock_data[0],bits(time));
    for(unsigned i=0;i<3;i++){atomic_store(&clock_data[1+i],bits(eye[i]));atomic_store(&clock_data[4+i],bits(right[i]));}
    atomic_store(&clock_data[7],(uint32_t)osGetTime());atomic_store(&clock_data[8],(muted || !sane) | (paused<<1));atomic_fetch_add(&sequence,1);
}
static void release_audio(void){
    atomic_store(&ready,false);atomic_store(&running,false);if(worker){threadJoin(worker,U64_MAX);threadFree(worker);worker=NULL;}
    if(dsp_live){ndspChnWaveBufClear(0);ndspChnReset(0);ndspExit();dsp_live=false;}
    for(unsigned i=0;i<SLOTS;i++){if(waves[i].data_vaddr)linearFree((void *)waves[i].data_vaddr);memset(&waves[i],0,sizeof(waves[i]));}
}
void atlas_audio_stop(void){release_audio();init_stage="stopped";init_result=0;init_errno=0;}
bool atlas_audio_ready(void){return atomic_load(&ready);}
const char *atlas_audio_stage(void){return init_stage;}
uint32_t atlas_audio_result(void){return init_result;}
int atlas_audio_errno(void){return init_errno;}
#else
#include <assert.h>
#include <stdio.h>
int main(void){
    float r[32]={1,64,0.55f,0.01375f,3,11,500,1,3,39,18,10.5f,160.4f,3,48,0,0.102f,1.82f,-0.1f,0.28f,1};
    float eye[3]={0,1.7f,3},right[3]={1,0,0};assert(valid(r,32));assert(!valid(r,31));r[31]=1;assert(!valid(r,32));r[31]=0;
    assert(controls(r,2.99f,eye,right).bell[0]==0);assert(controls(r,3.01f,eye,right).bell[0]>0);assert(controls(r,39.01f,eye,right).bell[0]==0);
    Controls a=controls(r,19.75f,eye,right),b=controls(r,83.75f,eye,right);assert(a.train[0]==b.train[0] && a.bell[0]==b.bell[0]);assert(a.train[0]>10*controls(r,4,eye,right).train[0]);
    Synth x,y;synth_init(&x);synth_init(&y);int16_t p[FRAMES*2],q[FRAMES*2];synth_seek(&x,19.73f,r);synth_seek(&y,19.73f,r);
    synth_render(&x,r,19.73f,eye,right,p);synth_render(&y,r,19.73f,eye,right,q);assert(memcmp(p,q,sizeof(p))==0);
    int peak=0;for(unsigned i=0;i<FRAMES*2;i++){int v=p[i]<0?-p[i]:p[i];if(v>peak)peak=v;}assert(peak>300 && peak<16000);
    puts("audio: descriptor, warning windows, loop seek, deterministic PCM and headroom passed");return 0;
}
#endif
