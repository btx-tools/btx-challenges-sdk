/**
 * WGSL kernel source for the BTX matmul service-challenge solver.
 *
 * Clean-room port of `@btx-tools/challenges-sdk`'s `core/src/matmul/*.ts`
 * (field / matrix / noise / transcript / header / pow). Every helper here was
 * byte-validated on real GPU hardware against that reference before packaging
 * (see README → Testing). **No native u64 in WGSL** → 32×32 multiply is done via
 * a 16-bit split (`mulFull`) and a double-Mersenne fold (`reduceProd`).
 *
 * The byte-order map (the load-bearing detail):
 *  - `sigma`            = reverse(SHA256d(header))            — `deriveSigma`
 *  - noise/compress seed= SHA256(tag18 ‖ sigmaBE) **raw**     — `shaTagSigma`
 *  - `fromOracle` cand  = byteswap(word0) & M31
 *  - transcript word    = byteswap(LE32(compressed)) streamed → SHA256d
 *  - accept             = uintLE(digest) ≤ uintBE(target)
 *  - reported digest    = reverse(rawSHA256d) (same convention as sigma)
 */

/** SHA-256 + M31 field helpers shared by both kernel entry points. */
const HELPERS = /* wgsl */ `
const M: u32 = 0x7FFFFFFFu;
const K = array<u32,64>(
  0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
  0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
  0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
  0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
  0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
  0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
  0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
  0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u);
fn rotr(x:u32,n:u32)->u32{return (x>>n)|(x<<(32u-n));}
fn bswap(x:u32)->u32{return ((x&0xFFu)<<24u)|((x&0xFF00u)<<8u)|((x>>8u)&0xFF00u)|((x>>24u)&0xFFu);}
fn mulFull(a:u32,b:u32)->vec2<u32>{
  let a0=a&0xFFFFu;let a1=a>>16u;let b0=b&0xFFFFu;let b1=b>>16u;
  let p00=a0*b0;let p01=a0*b1;let p10=a1*b0;let p11=a1*b1;
  let mid=p01+p10;let mc=select(0u,1u,mid<p01);
  let lo=p00+(mid<<16u);let lc=select(0u,1u,lo<p00);
  return vec2<u32>(lo,p11+(mid>>16u)+(mc<<16u)+lc);
}
fn reduceProd(lo:u32,hi:u32)->u32{let c0=lo&M;let c1=((hi<<1u)|(lo>>31u))&M;var s=c0+c1;s=(s&M)+(s>>31u);if(s>=M){s=s-M;}return s;}
fn fMul(a:u32,b:u32)->u32{let p=mulFull(a,b);return reduceProd(p.x,p.y);}
fn fAdd(a:u32,b:u32)->u32{let s=a+b;if(s>=M){return s-M;}return s;}
fn shaBlock(w_in:ptr<function,array<u32,16>>,h:ptr<function,array<u32,8>>){
  var w:array<u32,64>;for(var t=0u;t<16u;t=t+1u){w[t]=(*w_in)[t];}
  for(var t=16u;t<64u;t=t+1u){let s0=rotr(w[t-15u],7u)^rotr(w[t-15u],18u)^(w[t-15u]>>3u);let s1=rotr(w[t-2u],17u)^rotr(w[t-2u],19u)^(w[t-2u]>>10u);w[t]=w[t-16u]+s0+w[t-7u]+s1;}
  var a=(*h)[0];var b=(*h)[1];var c=(*h)[2];var d=(*h)[3];var e=(*h)[4];var f=(*h)[5];var g=(*h)[6];var hh=(*h)[7];
  for(var t=0u;t<64u;t=t+1u){let S1=rotr(e,6u)^rotr(e,11u)^rotr(e,25u);let ch=(e&f)^((~e)&g);let t1=hh+S1+ch+K[t]+w[t];let S0=rotr(a,2u)^rotr(a,13u)^rotr(a,22u);let maj=(a&b)^(a&c)^(b&c);hh=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+S0+maj;}
  (*h)[0]=(*h)[0]+a;(*h)[1]=(*h)[1]+b;(*h)[2]=(*h)[2]+c;(*h)[3]=(*h)[3]+d;(*h)[4]=(*h)[4]+e;(*h)[5]=(*h)[5]+f;(*h)[6]=(*h)[6]+g;(*h)[7]=(*h)[7]+hh;
}
fn initH()->array<u32,8>{return array<u32,8>(0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u);}
// fromOracle(seed,index) = SHA256(seed32 ‖ LE32(index) [‖ LE32(retry)]) ; cand = LE32(digest)&M
fn fromOracle(seed:ptr<function,array<u32,8>>,index:u32)->u32{
  for(var retry=0u;retry<256u;retry=retry+1u){
    var w:array<u32,16>;for(var i=0u;i<8u;i=i+1u){w[i]=(*seed)[i];}
    w[8]=bswap(index);var lenBits=288u;
    if(retry>0u){w[9]=bswap(retry);w[10]=0x80000000u;for(var i=11u;i<15u;i=i+1u){w[i]=0u;}lenBits=320u;}
    else{w[9]=0x80000000u;for(var i=10u;i<15u;i=i+1u){w[i]=0u;}}
    w[14]=0u;w[15]=lenBits;
    var h=initH();shaBlock(&w,&h);let cand=bswap(h[0])&M;if(cand<M){return cand;}
  }
  return 0u;
}
// SHA256(tag18 ‖ sigma32) → RAW digest words (no reverse). tag = [w0..w3, hi16].
fn shaTagSigma(tag:ptr<function,array<u32,5>>,sig:ptr<function,array<u32,8>>,out:ptr<function,array<u32,8>>){
  var w:array<u32,16>;
  w[0]=(*tag)[0];w[1]=(*tag)[1];w[2]=(*tag)[2];w[3]=(*tag)[3];
  w[4]=((*tag)[4]<<16u)|((*sig)[0]>>16u);
  for(var k=0u;k<7u;k=k+1u){w[5u+k]=(((*sig)[k]&0xFFFFu)<<16u)|((*sig)[k+1u]>>16u);}
  w[12]=(((*sig)[7]&0xFFFFu)<<16u)|0x8000u;
  w[13]=0u;w[14]=0u;w[15]=400u;
  var h=initH();shaBlock(&w,&h);for(var i=0u;i<8u;i=i+1u){(*out)[i]=h[i];}
}
// sigma = reverse(SHA256d(header)). hdr = 48 words (3 SHA blocks, nonce64=0 placeholder).
fn deriveSigma(hdr:ptr<function,array<u32,48>>,nonce:u32,out:ptr<function,array<u32,8>>){
  var blk:array<u32,16>;var h=initH();
  for(var b=0u;b<3u;b=b+1u){
    for(var t=0u;t<16u;t=t+1u){blk[t]=(*hdr)[b*16u+t];}
    if(b==1u){blk[3]=bswap(nonce);blk[4]=0u;} // nonce64 LE @ byte76 = block1 words 3,4 (hi32=0)
    shaBlock(&blk,&h);
  }
  var w2:array<u32,16>;for(var i=0u;i<8u;i=i+1u){w2[i]=h[i];}w2[8]=0x80000000u;for(var i=9u;i<15u;i=i+1u){w2[i]=0u;}w2[14]=0u;w2[15]=256u;
  var h2=initH();shaBlock(&w2,&h2);
  for(var i=0u;i<8u;i=i+1u){(*out)[i]=bswap(h2[7u-i]);}
}`;

/**
 * Build the parameterized solve shader for a given `(n, b, r)` and workgroup
 * size. Two entry points sharing one bind group:
 *  - `fill`  — one workgroup per nonce; lane 0 derives sigma + the 4 noise seeds
 *    into workgroup memory, all lanes stride over `idx∈[0,n²)` writing
 *    `A'[idx]=A+E`, `B'[idx]=B+F` into per-nonce storage slabs.
 *  - `solve` — lane 0 per nonce; canonicalMatMul over the slab, streaming
 *    `LE32(compressBlock)` into SHA256d, then `uintLE(digest) ≤ uintBE(target)`.
 *
 * Sizes (`cacc`/`cv` = b²) are injected as compile-time constants; the spike's
 * hardcoded `array<u32,16>` only held for b=4 (b²=16).
 *
 * `params` layout (one read-only buffer, keeps storage-buffer count ≤ 8):
 * `hdr[48] ‖ seedA[8] ‖ seedB[8] ‖ tags[25] ‖ targetBE[8]` = 97 u32.
 */
export function buildSolveShader(n: number, b: number, r: number, workgroupSize: number): string {
  const cv = b * b;
  return `${HELPERS}
const NN:u32=${n}u; const BB:u32=${b}u; const RR:u32=${r}u; const NB:u32=${n / b}u; const CV:u32=${cv}u; const WG:u32=${workgroupSize}u;
const HDR_OFS:u32=0u; const SA_OFS:u32=48u; const SB_OFS:u32=56u; const TAG_OFS:u32=64u; const TGT_OFS:u32=89u;
@group(0) @binding(0) var<storage,read> params: array<u32>;
@group(0) @binding(1) var<storage,read_write> Ap: array<u32>;
@group(0) @binding(2) var<storage,read_write> Bp: array<u32>;
@group(0) @binding(3) var<storage,read_write> outAccept: array<u32>;
@group(0) @binding(4) var<storage,read_write> outDigest: array<u32>;
@group(0) @binding(5) var<uniform> ctl: vec2<u32>; // (count, nonceBase)
fn loadHdr(out:ptr<function,array<u32,48>>){for(var i=0u;i<48u;i=i+1u){(*out)[i]=params[HDR_OFS+i];}}
fn loadTag(i:u32,out:ptr<function,array<u32,5>>){let o=TAG_OFS+i*5u;for(var k=0u;k<5u;k=k+1u){(*out)[k]=params[o+k];}}

var<workgroup> wgSigma: array<u32,8>;
var<workgroup> wgSeeds: array<u32,32>; // EL,ER,FL,FR ×8

@compute @workgroup_size(${workgroupSize})
fn fill(@builtin(workgroup_id) wid:vec3<u32>,@builtin(local_invocation_id) lid:vec3<u32>){
  let slot=wid.x; if(slot>=ctl.x){return;}
  let nonce=ctl.y+slot;
  if(lid.x==0u){
    var hdrL:array<u32,48>;loadHdr(&hdrL);
    var sig:array<u32,8>;deriveSigma(&hdrL,nonce,&sig);
    for(var i=0u;i<8u;i=i+1u){wgSigma[i]=sig[i];}
    var tg:array<u32,5>;var s:array<u32,8>;
    for(var t=0u;t<4u;t=t+1u){loadTag(t,&tg);shaTagSigma(&tg,&sig,&s);for(var i=0u;i<8u;i=i+1u){wgSeeds[t*8u+i]=s[i];}}
  }
  workgroupBarrier();
  var sEL:array<u32,8>;var sER:array<u32,8>;var sFL:array<u32,8>;var sFR:array<u32,8>;
  for(var i=0u;i<8u;i=i+1u){sEL[i]=wgSeeds[i];sER[i]=wgSeeds[8u+i];sFL[i]=wgSeeds[16u+i];sFR[i]=wgSeeds[24u+i];}
  var sA:array<u32,8>;var sB:array<u32,8>;for(var i=0u;i<8u;i=i+1u){sA[i]=params[SA_OFS+i];sB[i]=params[SB_OFS+i];}
  let base=slot*NN*NN;
  for(var idx=lid.x; idx<NN*NN; idx=idx+WG){
    let i=idx/NN; let j=idx%NN;
    var e=0u;var f=0u;
    for(var k=0u;k<RR;k=k+1u){
      e=fAdd(e,fMul(fromOracle(&sEL,i*RR+k),fromOracle(&sER,k*NN+j)));
      f=fAdd(f,fMul(fromOracle(&sFL,i*RR+k),fromOracle(&sFR,k*NN+j)));
    }
    Ap[base+idx]=fAdd(fromOracle(&sA,idx),e);
    Bp[base+idx]=fAdd(fromOracle(&sB,idx),f);
  }
}

@compute @workgroup_size(1)
fn solve(@builtin(workgroup_id) wid:vec3<u32>){
  let slot=wid.x; if(slot>=ctl.x){return;}
  let nonce=ctl.y+slot;
  let base=slot*NN*NN;
  var hdrL:array<u32,48>;loadHdr(&hdrL);
  var sigma:array<u32,8>;deriveSigma(&hdrL,nonce,&sigma);
  var ct:array<u32,5>;loadTag(4u,&ct);
  var cseed:array<u32,8>;shaTagSigma(&ct,&sigma,&cseed);
  var cv:array<u32,${cv}>;for(var k=0u;k<CV;k=k+1u){cv[k]=fromOracle(&cseed,k);}
  var th=initH();var tw:array<u32,16>;var twi=0u;var tbytes=0u;
  for(var bi=0u;bi<NB;bi=bi+1u){for(var bj=0u;bj<NB;bj=bj+1u){
    var cacc:array<u32,${cv}>;for(var x=0u;x<CV;x=x+1u){cacc[x]=0u;}
    for(var be=0u;be<NB;be=be+1u){
      for(var rr=0u;rr<BB;rr=rr+1u){for(var cc=0u;cc<BB;cc=cc+1u){
        var acc=cacc[rr*BB+cc];
        for(var k=0u;k<BB;k=k+1u){
          let a=Ap[base+(bi*BB+rr)*NN+(be*BB+k)];let b=Bp[base+(be*BB+k)*NN+(bj*BB+cc)];
          acc=fAdd(acc,fMul(a,b));
        }
        cacc[rr*BB+cc]=acc;
      }}
      var cb=0u;for(var k=0u;k<CV;k=k+1u){cb=fAdd(cb,fMul(cacc[k],cv[k]));}
      tw[twi]=bswap(cb);twi=twi+1u;tbytes=tbytes+4u;
      if(twi==16u){shaBlock(&tw,&th);twi=0u;}
    }
  }}
  tw[twi]=0x80000000u;twi=twi+1u;
  if(twi>14u){for(var z=twi;z<16u;z=z+1u){tw[z]=0u;}shaBlock(&tw,&th);twi=0u;for(var z=0u;z<16u;z=z+1u){tw[z]=0u;}}
  for(var z=twi;z<14u;z=z+1u){tw[z]=0u;}
  // 64-bit SHA bit-length = tbytes*8 = tbytes<<3. The top 3 bits of tbytes spill
  // into the high length word (audit M-1: a hardcoded hi=0 was wrong once
  // tbytes*8 ≥ 2³²). tbytes itself stays < 2³² — host buildParams rejects configs
  // where 4·(n/b)³ would overflow it.
  tw[14]=tbytes>>29u;tw[15]=tbytes<<3u;shaBlock(&tw,&th);
  var fw:array<u32,16>;for(var i=0u;i<8u;i=i+1u){fw[i]=th[i];}fw[8]=0x80000000u;for(var i=9u;i<15u;i=i+1u){fw[i]=0u;}fw[14]=0u;fw[15]=256u;
  var fh=initH();shaBlock(&fw,&fh);
  let dofs=slot*8u;for(var i=0u;i<8u;i=i+1u){outDigest[dofs+i]=bswap(fh[7u-i]);}
  var accept=1u;
  for(var i=0u;i<8u;i=i+1u){let dW=bswap(fh[7u-i]);let tW=params[TGT_OFS+i];if(dW<tW){accept=1u;break;}if(dW>tW){accept=0u;break;}}
  outAccept[slot]=accept;
}`;
}
