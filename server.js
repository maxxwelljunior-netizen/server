'use strict';
/*
  AXIS — servidor de emissão de NFS-e pelo Emissor Nacional (SEFIN Nacional).
  Guarda o certificado A1, monta a DPS, assina (XMLDSig) e envia com TLS mútuo.
  O ambiente padrão é PRODUÇÃO RESTRITA (teste, sem validade fiscal).
  Só emite de verdade se NFSE_AMBIENTE=producao E NFSE_CONFIRMO_PRODUCAO=SIM.

  Também atende o eSocial (admissão de funcionários — rotas /esocial/admissao e /esocial/consulta); veja esocial.js.
  O ambiente do eSocial é separado: ESOCIAL_AMBIENTE=producao + ESOCIAL_CONFIRMO_PRODUCAO=SIM para valer de verdade.

  Variáveis de ambiente (nunca coloque isto no HTML):
    CERT_PFX_BASE64 + CERT_PASSWORD   certificado A1 (.pfx em base64) e senha
      (alternativa: CERT_KEY_PEM + CERT_CHAIN_PEM)
    EMITENTE_CNPJ                     CNPJ da empresa emitente (só números)
    EMITENTE_IM                       inscrição municipal (opcional)
    SUPABASE_URL, SUPABASE_ANON_KEY   para conferir quem está chamando
    ALLOWED_ORIGIN                    endereço onde o sistema está hospedado (opcional)
    NFSE_BASE_URL                     só se precisar trocar o endereço da API
*/
const http = require('http'), https = require('https'), zlib = require('zlib'), crypto = require('crypto');
const E = process.env;
const PRODUCAO = E.NFSE_AMBIENTE === 'producao' && E.NFSE_CONFIRMO_PRODUCAO === 'SIM';
const TP_AMB = PRODUCAO ? 1 : 2;
const BASE = (E.NFSE_BASE_URL || (PRODUCAO ? 'https://sefin.nfse.gov.br/SefinNacional' : 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional')).replace(/\/$/, '');
const PERFIS = ['financeiro', 'diretor', 'administrador', 'admin'];
const PERFIS_RH = ['rh', 'financeiro', 'diretor', 'administrador', 'admin'];
const NS = 'http://www.sped.fazenda.gov.br/nfse', DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dig = (s, n) => String(s == null ? '' : s).replace(/\D/g, '').padStart(n, '0');
const b64 = b => Buffer.from(b).toString('base64');

let CRED = null;
const SEM_CERT = 'Certificado digital não configurado no servidor (CERT_PFX_BASE64 + CERT_PASSWORD).';
function credencial() {
  if (CRED) return CRED;
  let key, chain;
  if (E.CERT_KEY_PEM && E.CERT_CHAIN_PEM) {
    key = E.CERT_KEY_PEM.replace(/\\n/g, '\n'); chain = E.CERT_CHAIN_PEM.replace(/\\n/g, '\n');
  } else {
    if (!String(E.CERT_PFX_BASE64 || '').trim()) throw { status: 500, erro: SEM_CERT };
    try {
      const forge = require('node-forge'), o = forge.pki.oids;
      const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(String(E.CERT_PFX_BASE64).replace(/\s+/g, ''))), E.CERT_PASSWORD || '');
      const bag = (t) => (p12.getBags({ bagType: t })[t] || []);
      const kb = bag(o.pkcs8ShroudedKeyBag)[0] || bag(o.keyBag)[0];
      const certs = bag(o.certBag).map(b => b.cert);
      const leaf = certs.find(c => c.publicKey.n.compareTo(kb.key.n) === 0) || certs[0];
      key = forge.pki.privateKeyToPem(kb.key);
      chain = [leaf].concat(certs.filter(c => c !== leaf)).map(c => forge.pki.certificateToPem(c)).join('');
    } catch (e) {
      console.error('Certificado:', e && e.message);
      throw { status: 500, erro: 'O certificado está configurado, mas não abriu: confira a senha (CERT_PASSWORD) e se o CERT_PFX_BASE64 foi colado inteiro, sem cortes. Detalhe: ' + (e && e.message || e) };
    }
  }
  let info = {};
  try { const x = new crypto.X509Certificate(chain.match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/)[0]); info = { titular: x.subject.replace(/\n/g, ', '), validoAte: new Date(x.validTo).toISOString().slice(0, 10), vencido: new Date(x.validTo) < new Date() }; } catch (e) {}
  if (info.vencido) throw { status: 500, erro: 'O certificado digital configurado no servidor está vencido (' + info.validoAte + '). Instale um A1 válido.' };
  CRED = { key: key, chain: chain, info: info };
  return CRED;
}
function certStatus() { try { return Object.assign({ ok: true }, credencial().info); } catch (e) { return { ok: false, erro: e && e.erro || String(e) }; } }

/* DPS do Simples Nacional (ME/EPP), prestador emitindo (tpEmit=1) */
function montarDPS(d) {
  const cnpj = dig(E.EMITENTE_CNPJ, 14), loc = dig(d.loc || '3550308', 7);
  const serie = String(parseInt(d.serie, 10) || 1), nDPS = String(parseInt(d.nDPS, 10));
  const id = 'DPS' + loc + '2' + cnpj + dig(serie, 5) + dig(nDPS, 15);
  const doc = String(d.tomadorDoc).replace(/\D/g, ''), tag = doc.length === 11 ? 'CPF' : 'CNPJ';
  const dh = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 19) + '-03:00';
  const inf = '<infDPS Id="' + id + '"><tpAmb>' + TP_AMB + '</tpAmb><dhEmi>' + dh + '</dhEmi><verAplic>AXIS-1.0</verAplic>' +
    '<serie>' + serie + '</serie><nDPS>' + nDPS + '</nDPS><dCompet>' + d.emissao + '</dCompet><tpEmit>1</tpEmit><cLocEmi>' + loc + '</cLocEmi>' +
    '<prest><CNPJ>' + cnpj + '</CNPJ>' + (E.EMITENTE_IM ? '<IM>' + esc(E.EMITENTE_IM) + '</IM>' : '') +
    '<regTrib><opSimpNac>3</opSimpNac><regApTribSN>' + (parseInt(d.reg, 10) || 1) + '</regApTribSN><regEspTrib>0</regEspTrib></regTrib></prest>' +
    '<toma><' + tag + '>' + doc + '</' + tag + '><xNome>' + esc(d.tomadorNome) + '</xNome></toma>' +
    '<serv><locPrest><cLocPrestacao>' + loc + '</cLocPrestacao></locPrest><cServ><cTribNac>' + dig(d.ctn, 6) + '</cTribNac><xDescServ>' + esc(d.descr) + '</xDescServ></cServ></serv>' +
    '<valores><vServPrest><vServ>' + Number(d.valor).toFixed(2) + '</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun>' +
    '<totTrib><pTotTribSN>' + Number(d.pt || 0).toFixed(2) + '</pTotTribSN></totTrib></trib></valores></infDPS>';
  return { id: id, inf: inf };
}

/* XMLDSig enveloped, C14N 1.0, RSA-SHA1/SHA1, só o certificado do emitente */
function assinar(inf, id, keyPem, chainPem) {
  const canon = inf.replace('<infDPS ', '<infDPS xmlns="' + NS + '" ');
  const digest = crypto.createHash('sha1').update(canon, 'utf8').digest('base64');
  const si = '<CanonicalizationMethod Algorithm="' + C14N + '"></CanonicalizationMethod><SignatureMethod Algorithm="' + DSIG + 'rsa-sha1"></SignatureMethod>' +
    '<Reference URI="#' + id + '"><Transforms><Transform Algorithm="' + DSIG + 'enveloped-signature"></Transform><Transform Algorithm="' + C14N + '"></Transform></Transforms>' +
    '<DigestMethod Algorithm="' + DSIG + 'sha1"></DigestMethod><DigestValue>' + digest + '</DigestValue></Reference>';
  const sig = crypto.createSign('RSA-SHA1').update('<SignedInfo xmlns="' + DSIG + '">' + si + '</SignedInfo>', 'utf8').sign(keyPem, 'base64');
  const cert = chainPem.match(/-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/)[1].replace(/\s+/g, '');
  return '<DPS xmlns="' + NS + '" versao="1.00">' + inf + '<Signature xmlns="' + DSIG + '"><SignedInfo>' + si + '</SignedInfo><SignatureValue>' + sig +
    '</SignatureValue><KeyInfo><X509Data><X509Certificate>' + cert + '</X509Certificate></X509Data></KeyInfo></Signature></DPS>';
}

function enviar(xml) {
  const c = credencial(), corpo = JSON.stringify({ dpsXmlGZipB64: b64(zlib.gzipSync(Buffer.from(xml, 'utf8'))) });
  return new Promise((ok, falha) => {
    const rq = https.request(BASE + '/nfse', { method: 'POST', key: c.key, cert: c.chain, minVersion: 'TLSv1.2', timeout: 60000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(corpo) } }, rs => {
      let t = ''; rs.on('data', x => t += x); rs.on('end', () => ok({ status: rs.statusCode, texto: t }));
    });
    rq.on('timeout', () => rq.destroy(new Error('Tempo esgotado ao falar com o Emissor Nacional')));
    rq.on('error', falha); rq.end(corpo);
  });
}

async function autorizar(req, perfis) {
  const tk = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tk) throw { status: 401, erro: 'Faça login no sistema.' };
  const h = { apikey: E.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + tk };
  const u = await fetch(E.SUPABASE_URL + '/auth/v1/user', { headers: h });
  if (!u.ok) throw { status: 401, erro: 'Sessão inválida. Entre novamente.' };
  const p = await fetch(E.SUPABASE_URL + '/rest/v1/rpc/axis_perfil', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h), body: '{}' });
  const perfil = String(await p.json().catch(() => '')).toLowerCase();
  if ((perfis || PERFIS).indexOf(perfil) < 0) throw { status: 403, erro: 'Seu perfil não tem permissão para esta operação.' };
}

function interpretar(r) {
  let j = {}; try { j = JSON.parse(r.texto); } catch (e) { return { ok: false, erros: ['Resposta inesperada (HTTP ' + r.status + '): ' + r.texto.slice(0, 300)] }; }
  const pega = (o, re) => { for (const k in o) if (re.test(k)) return o[k]; };
  const zip = pega(j, /^nfsexmlgzipb64$/i);
  if (zip) {
    const xml = zlib.gunzipSync(Buffer.from(zip, 'base64')).toString('utf8');
    const chave = pega(j, /^chaveacesso$/i) || ((/infNFSe[^>]*Id="NFS(\d+)"/.exec(xml) || [])[1]);
    return { ok: true, numero: (/<nNFSe>(\d+)<\/nNFSe>/.exec(xml) || [])[1], chave: chave, xml: xml };
  }
  const er = pega(j, /^(erros?|erro|mensagens?)$/i);
  const lista = (Array.isArray(er) ? er : er ? [er] : []).map(x => typeof x === 'string' ? x :
    [pega(x, /^codigo$/i), pega(x, /^descricao$/i), pega(x, /^complemento/i)].filter(Boolean).join(' - '));
  return { ok: false, erros: lista.length ? lista : ['HTTP ' + r.status + ': ' + r.texto.slice(0, 300)] };
}

async function emitir(req, corpo) {
  await autorizar(req);
  const d = JSON.parse(corpo || '{}');
  if (!E.EMITENTE_CNPJ) throw { status: 500, erro: 'EMITENTE_CNPJ não configurado no servidor.' };
  if (!d.valor || !d.emissao || !d.tomadorNome || !d.tomadorDoc || !d.ctn || !d.descr || !d.nDPS) throw { status: 400, erro: 'Dados da nota incompletos.' };
  const dps = montarDPS(d), c = credencial(), xml = assinar(dps.inf, dps.id, c.key, c.chain);
  const r = interpretar(await enviar(xml));
  const ambiente = PRODUCAO ? 'produção' : 'teste';
  if (!r.ok) return { ok: false, ambiente: ambiente, erros: r.erros, dps: dps.id };
  return { ok: true, ambiente: ambiente, numero: r.numero, chave: r.chave, dps: dps.id };
}

/* Benefícios (VR): robô do Super Portal — ver robo.js */
const RB = require('./robo')({ E: E, VRL: require('./vrlayout') });
async function beneficiosRota(req, url, corpo) {
  await autorizar(req, PERFIS_RH);
  if (url === '/beneficios/robo') return RB.rota(JSON.parse(corpo || '{}'));
  throw { status: 404, erro: 'Rota não encontrada.' };
}

/* eSocial (admissão de funcionários) — ver esocial.js */
const ES = require('./esocial')({ E: E, credencial: credencial });
async function esocialRota(req, url, corpo) {
  await autorizar(req, PERFIS_RH);
  if (!E.EMITENTE_CNPJ) throw { status: 500, erro: 'EMITENTE_CNPJ não configurado no servidor.' };
  const d = JSON.parse(corpo || '{}');
  if (url === '/esocial/admissao') return ES.admissao(d);
  if (url === '/esocial/consulta') return ES.consulta(d);
  throw { status: 404, erro: 'Rota não encontrada.' };
}

function servidor() {
  return http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': E.ALLOWED_ORIGIN || '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
    const fim = (s, o) => { res.writeHead(s, Object.assign({ 'Content-Type': 'application/json' }, cors)); res.end(JSON.stringify(o)); };
    if (req.method === 'OPTIONS') return fim(204, {});
    if (req.method === 'GET') return fim(200, { ok: true, ambiente: PRODUCAO ? 'produção' : 'teste', esocial: ES.ambiente(), certificado: certStatus(), robo: RB.config() });
    if (req.method !== 'POST') return fim(405, { ok: false, erro: 'Método não permitido.' });
    let t = ''; req.on('data', x => { t += x; if (t.length > 1e5) req.destroy(); });
    const rota = (req.url || '').split('?')[0];
    req.on('end', () => (rota.indexOf('/beneficios/') === 0 ? beneficiosRota(req, rota, t) : rota.indexOf('/esocial/') === 0 ? esocialRota(req, rota, t) : emitir(req, t)).then(o => fim(200, o)).catch(e => { console.error(e && e.erro || e); fim(e && e.status || 500, { ok: false, ambiente: PRODUCAO ? 'produção' : 'teste', erro: e && e.erro || 'Falha interna ao emitir a nota.' }); }));
  });
}

module.exports = { montarDPS, assinar, interpretar, ES };
if (require.main === module) servidor().listen(E.PORT || 3000, () => { console.log('AXIS NFS-e: ambiente ' + (PRODUCAO ? 'PRODUÇÃO' : 'teste (produção restrita)')); RB.iniciar(); });
