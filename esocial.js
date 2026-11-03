'use strict';
/*
  AXIS — eSocial: admissão de trabalhador (evento S-2200).
  Monta o XML, assina (XMLDSig, certificado A1 do empregador), envia em lote com TLS mútuo
  e consulta o resultado do processamento.

  O ambiente padrão é PRODUÇÃO RESTRITA (testes, sem efeito legal). Só envia para a produção de verdade se
  ESOCIAL_AMBIENTE=producao E ESOCIAL_CONFIRMO_PRODUCAO=SIM.

  Variáveis opcionais (use só se o eSocial mudar o leiaute ou os endereços):
    ESOCIAL_VER_EVT        versão do leiaute do evento (padrão v_S_01_03_00)
    ESOCIAL_NS_LOTE        namespace do lote de envio
    ESOCIAL_NS_SOAP_ENVIO  namespace do serviço de envio
    ESOCIAL_NS_SOAP_CONSULTA  namespace do serviço de consulta
    ESOCIAL_URL_ENVIO / ESOCIAL_URL_CONSULTA   endereços dos web services
    ESOCIAL_ASSINATURA     sha256 (padrão) ou sha1
    ESOCIAL_CA_PEM         cadeia de certificados ICP-Brasil (PEM), se o Node não confiar nos servidores do eSocial
*/
const https = require('https'), crypto = require('crypto');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dig = (s, n) => { const t = String(s == null ? '' : s).replace(/\D/g, ''); return n ? t.padStart(n, '0') : t; };
const tag = (n, v) => (v === undefined || v === null || String(v).trim() === '') ? '' : '<' + n + '>' + esc(String(v).trim()) + '</' + n + '>';
const num2 = v => (Number(v) || 0).toFixed(2);

function cpfOk(c) {
  c = dig(c);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (let t = 9; t < 11; t++) { let s = 0; for (let i = 0; i < t; i++) s += Number(c[i]) * (t + 1 - i); if ((s * 10) % 11 % 10 !== Number(c[t])) return false; }
  return true;
}
function cnpjOk(c) {
  c = dig(c);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  for (let t = 12; t < 14; t++) { let s = 0, p = t - 7; for (let i = 0; i < t; i++) { s += Number(c[i]) * p--; if (p < 2) p = 9; } const d = s % 11 < 2 ? 0 : 11 - s % 11; if (d !== Number(c[t])) return false; }
  return true;
}

/* Confere os campos que o S-2200 exige. Devolve a lista de problemas (vazia = pode enviar). */
function validar(d) {
  const e = [], f = (c, m) => { if (!c) e.push(m); };
  f(String(d.nome || '').trim().length >= 3, 'Nome completo.');
  f(cpfOk(d.cpf), 'CPF válido.');
  f(/^\d{4}-\d{2}-\d{2}$/.test(d.dtNasc || ''), 'Data de nascimento.');
  f(['M', 'F'].indexOf(d.sexo) >= 0, 'Sexo.');
  f(/^[1-6]$/.test(String(d.raca || '')), 'Raça/cor.');
  f(/^[1-5]$/.test(String(d.estCiv || '')), 'Estado civil.');
  f(/^\d{2}$/.test(String(d.grauInstr || '')), 'Grau de instrução.');
  f(String(d.mae || '').trim().length >= 3, 'Nome da mãe.');
  f(dig(d.paisNasc || '105').length >= 3, 'País de nascimento.');
  f(dig(d.cep).length === 8, 'CEP (8 dígitos).');
  f(String(d.logradouro || '').trim(), 'Logradouro.');
  f(String(d.nr || '').trim(), 'Número do endereço (ou S/N).');
  f(String(d.bairro || '').trim(), 'Bairro.');
  f(dig(d.codMunic).length === 7, 'Município do endereço (código IBGE de 7 dígitos).');
  f(/^[A-Za-z]{2}$/.test(d.uf || ''), 'UF do endereço.');
  f(String(d.matricula || '').trim(), 'Matrícula.');
  f(/^\d{4}-\d{2}-\d{2}$/.test(d.dtAdm || ''), 'Data de admissão.');
  f(String(d.cargo || '').trim(), 'Cargo.');
  f(dig(d.cbo).length === 6, 'CBO do cargo (6 dígitos).');
  f(Number(d.salario) > 0, 'Salário base.');
  f(Number(d.hrSem) > 0 && Number(d.hrSem) <= 44, 'Horas semanais (até 44).');
  f(/^[2-9]$/.test(String(d.tpJornada || '')), 'Tipo de jornada.');
  f(String(d.dscJorn || '').trim(), 'Descrição da jornada (dias e horários).');
  if (String(d.tpJornada) === '9') f(String(d.dscTpJorn || '').trim(), 'Descrição do tipo de jornada (jornada "demais tipos").');
  f(cnpjOk(d.localCnpj), 'CNPJ do local de trabalho (válido).');
  f(cnpjOk(d.cnpjSind), 'CNPJ do sindicato da categoria profissional (válido).');
  return e;
}

function criar(ctx) {
  const E = ctx.E;
  const PRODUCAO = E.ESOCIAL_AMBIENTE === 'producao' && E.ESOCIAL_CONFIRMO_PRODUCAO === 'SIM';
  const TP_AMB = PRODUCAO ? 1 : 2;
  const URL_ENVIO = E.ESOCIAL_URL_ENVIO || (PRODUCAO
    ? 'https://webservices.envio.esocial.gov.br/servicos/empregador/enviarloteeventos/WsEnviarLoteEventos.svc'
    : 'https://webservices.producaorestrita.esocial.gov.br/servicos/empregador/enviarloteeventos/WsEnviarLoteEventos.svc');
  const URL_CONSULTA = E.ESOCIAL_URL_CONSULTA || (PRODUCAO
    ? 'https://webservices.consulta.esocial.gov.br/servicos/empregador/consultarloteeventos/WsConsultarLoteEventos.svc'
    : 'https://webservices.producaorestrita.esocial.gov.br/servicos/empregador/consultarloteeventos/WsConsultarLoteEventos.svc');
  const NS_EVT = 'http://www.esocial.gov.br/schema/evt/evtAdmissao/' + (E.ESOCIAL_VER_EVT || 'v_S_01_03_00');
  const NS_LOTE = E.ESOCIAL_NS_LOTE || 'http://www.esocial.gov.br/schema/lote/eventos/envio/v1_1_1';
  const NS_SOAP_ENVIO = E.ESOCIAL_NS_SOAP_ENVIO || 'http://www.esocial.gov.br/servicos/empregador/lote/eventos/envio/v1_1_0';
  const NS_CONS = 'http://www.esocial.gov.br/schema/lote/eventos/envio/consulta/retornoProcessamento/v1_0_0';
  const NS_SOAP_CONS = E.ESOCIAL_NS_SOAP_CONSULTA || 'http://www.esocial.gov.br/servicos/empregador/lote/eventos/envio/consulta/retornoProcessamento/v1_1_0';
  const DSIG = 'http://www.w3.org/2000/09/xmldsig#', C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
  const SHA1 = (E.ESOCIAL_ASSINATURA || 'sha256').toLowerCase() === 'sha1';
  const ALG = SHA1
    ? { sig: DSIG + 'rsa-sha1', dig: DSIG + 'sha1', node: 'RSA-SHA1', h: 'sha1' }
    : { sig: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', dig: 'http://www.w3.org/2001/04/xmlenc#sha256', node: 'RSA-SHA256', h: 'sha256' };
  const ambiente = () => (PRODUCAO ? 'produção' : 'teste (produção restrita)');

  /* Só na exportação para o SAR2G/HK: documentos no lugar oficial do S-2200 */
  function docsHK(d, hk) {
    if (!hk) return '';
    const x = (d.ctps && d.ctpsSerie && d.ctpsUf ? '<CTPS>' + tag('nrCtps', d.ctps) + tag('serieCtps', d.ctpsSerie) + tag('ufCtps', String(d.ctpsUf).toUpperCase()) + '</CTPS>' : '') +
      (d.rg && d.rgOrg ? '<RG>' + tag('nrDoc', d.rg) + tag('orgaoEmissor', d.rgOrg) + tag('dtExped', d.rgEmi) + '</RG>' : '');
    return x ? '<documentos>' + x + '</documentos>' : '';
  }
  /* Dados que o S-2200 não tem (a planilha do HK pede): vão num bloco ao lado do evento, dentro de <eSocial> */
  function extrasHK(d) {
    const g = (n, c) => { const s = c.join(''); return s ? '<' + n + '>' + s + '</' + n + '>' : ''; };
    return '<infoComplementarSAR2G>' + tag('apelido', d.apelido) + tag('empresa', d.empSar || d.emp) + tag('convencao', d.convencao) +
      tag('motivoAdmissao', 'ADMISSÃO') + tag('inicioCargo', d.dtAdm) + tag('primeiraExperiencia', d.exp1 || d.dtAdm) + tag('segundaExperiencia', d.exp2 || d.dtAdm) +
      tag('cidadeNascimento', d.cidNasc) + tag('conjuge', d.conjuge) + tag('primeiroEmprego', Number(d.primeiroEmprego) ? 1 : 0) + tag('estrangeiro', Number(d.estrangeiro) ? 1 : 0) +
      g('pis', [tag('numero', dig(d.nis)), tag('serie', d.pisSerie), tag('dtEmissao', d.pisEmi)]) +
      g('rg', [tag('uf', d.rgUf)]) +
      g('tituloEleitor', [tag('numero', d.titulo), tag('zona', d.tituloZona), tag('secao', d.tituloSecao), tag('dtEmissao', d.tituloEmi)]) +
      g('reservista', [tag('numero', d.reservista), tag('tipo', d.reservistaTipo)]) +
      g('habilitacao', [tag('numero', d.cnh), tag('tipo', d.cnhTipo), tag('vencimento', d.cnhVenc)]) +
      g('rne', [tag('numero', d.rne), tag('chegada', d.rneChegada), tag('validade', d.rneValidade), tag('visto', d.rneVisto)]) +
      g('moradia', [tag('referencia', d.referencia), tag('zona', d.zonaMoradia)]) +
      g('contaBancaria', [tag('tipo', d.tipoConta), tag('banco', d.banco), tag('agencia', d.agencia), tag('digitoAgencia', d.agenciaDig), tag('conta', d.conta), tag('digitoConta', d.contaDig)]) +
      '</infoComplementarSAR2G>';
  }

  /* S-2200 sem assinatura */
  function montarS2200(d, seq, hk) {
    const cnpj = dig(E.EMITENTE_CNPJ, 14);
    const ts = new Date(Date.now() - 3 * 3600e3).toISOString().replace(/\D/g, '').slice(0, 14);
    const id = 'ID1' + cnpj + ts + dig(seq || 1, 5).slice(-5);
    const brasil = '<brasil>' + tag('tpLograd', d.tpLograd || 'R') + tag('dscLograd', d.logradouro) + tag('nrLograd', d.nr || 'S/N') + tag('complemento', d.compl) +
      tag('bairro', d.bairro) + tag('cep', dig(d.cep, 8)) + tag('codMunic', dig(d.codMunic, 7)) + tag('uf', String(d.uf || '').toUpperCase()) + '</brasil>';
    const contato = (dig(d.tel) || d.email) ? '<contato>' + tag('fonePrinc', dig(d.tel)) + tag('emailPrinc', d.email) + '</contato>' : '';
    const br = String(d.paisNasc || '105') === '105';
    const trab = '<trabalhador>' + tag('cpfTrab', dig(d.cpf, 11)) + tag('nmTrab', d.nome) + tag('sexo', d.sexo) + tag('racaCor', d.raca) + tag('estCiv', d.estCiv) + tag('grauInstr', d.grauInstr) +
      '<nascimento>' + tag('dtNascto', d.dtNasc) + /* S-1.3: sem município/UF de nascimento (o XSD rejeita) */
      tag('paisNascto', dig(d.paisNasc || '105')) + tag('paisNac', dig(d.paisNac || d.paisNasc || '105')) + tag('nmMae', d.mae) + (hk ? tag('nmPai', d.pai) : '') + '</nascimento>' + docsHK(d, hk) +
      '<endereco>' + brasil + '</endereco>' + contato + '</trabalhador>';
    const celetista = '<infoCeletista>' + tag('dtAdm', d.dtAdm) + tag('tpAdmissao', '1') + tag('indAdmissao', '1') + tag('tpRegJor', '1') + tag('natAtividade', '1') +
      tag('dtBase', d.dtBase ? String(parseInt(d.dtBase, 10)) : '') + tag('cnpjSindCategProf', dig(d.cnpjSind, 14)) + '</infoCeletista>';
    const hor = '<horContratual>' + tag('qtdHrsSem', num2(d.hrSem)) + tag('tpJornada', d.tpJornada) + (String(d.tpJornada) === '9' ? tag('dscTpJorn', d.dscTpJorn) : '') +
      tag('tmpParc', '0') + tag('dscJorn', d.dscJorn) + '</horContratual>';
    const contrato = '<infoContrato>' + tag('nmCargo', d.cargo) + tag('CBOCargo', dig(d.cbo, 6)) + tag('nmFuncao', d.funcao || d.cargo) + tag('CBOFuncao', dig(d.cbof || d.cbo, 6)) +
      tag('codCateg', d.codCateg || '101') + '<remuneracao>' + tag('vrSalFx', num2(d.salario)) + tag('undSalFixo', '5') + '</remuneracao>' +
      '<duracao>' + tag('tpContr', '1') + '</duracao>' +
      '<localTrabalho><localTrabGeral>' + tag('tpInsc', '1') + tag('nrInsc', dig(d.localCnpj, 14)) + '</localTrabGeral></localTrabalho>' + hor + '</infoContrato>';
    const vinculo = '<vinculo>' + tag('matricula', d.matricula) + tag('tpRegTrab', '1') + tag('tpRegPrev', '1') + tag('cadIni', 'N') +
      '<infoRegimeTrab>' + celetista + '</infoRegimeTrab>' + contrato + '</vinculo>';
    const evt = '<evtAdmissao Id="' + id + '"><ideEvento>' + tag('indRetif', '1') + tag('tpAmb', TP_AMB) + tag('procEmi', '1') + tag('verProc', 'AXIS-1.0') + '</ideEvento>' +
      '<ideEmpregador>' + tag('tpInsc', '1') + tag('nrInsc', cnpj) + '</ideEmpregador>' + trab + vinculo + '</evtAdmissao>';
    return { id: id, evt: evt, extra: hk ? extrasHK(d) : '' };
  }

  /* XMLDSig enveloped, C14N 1.0 — a assinatura fica ao lado do evtAdmissao, dentro de <eSocial> */
  function assinar(evt, id, keyPem, chainPem) {
    const canon = evt.replace('<evtAdmissao ', '<evtAdmissao xmlns="' + NS_EVT + '" ');
    const digest = crypto.createHash(ALG.h).update(canon, 'utf8').digest('base64');
    const si = '<CanonicalizationMethod Algorithm="' + C14N + '"></CanonicalizationMethod><SignatureMethod Algorithm="' + ALG.sig + '"></SignatureMethod>' +
      '<Reference URI="#' + id + '"><Transforms><Transform Algorithm="' + DSIG + 'enveloped-signature"></Transform><Transform Algorithm="' + C14N + '"></Transform></Transforms>' +
      '<DigestMethod Algorithm="' + ALG.dig + '"></DigestMethod><DigestValue>' + digest + '</DigestValue></Reference>';
    const sig = crypto.createSign(ALG.node).update('<SignedInfo xmlns="' + DSIG + '">' + si + '</SignedInfo>', 'utf8').sign(keyPem, 'base64');
    const cert = chainPem.match(/-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/)[1].replace(/\s+/g, '');
    return '<eSocial xmlns="' + NS_EVT + '">' + evt + '<Signature xmlns="' + DSIG + '"><SignedInfo>' + si + '</SignedInfo><SignatureValue>' + sig +
      '</SignatureValue><KeyInfo><X509Data><X509Certificate>' + cert + '</X509Certificate></X509Data></KeyInfo></Signature></eSocial>';
  }

  function montarLote(eventos) {
    const cnpj = dig(E.EMITENTE_CNPJ, 14);
    return '<eSocial xmlns="' + NS_LOTE + '"><envioLoteEventos grupo="2"><ideEmpregador><tpInsc>1</tpInsc><nrInsc>' + cnpj + '</nrInsc></ideEmpregador>' +
      '<ideTransmissor><tpInsc>1</tpInsc><nrInsc>' + cnpj + '</nrInsc></ideTransmissor><eventos>' +
      eventos.map(e => '<evento Id="' + e.id + '">' + e.xml + '</evento>').join('') + '</eventos></envioLoteEventos></eSocial>';
  }

  function soap(ns, operacao, corpo) {
    return '<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v1="' + ns + '"><soapenv:Header/><soapenv:Body>' +
      '<v1:' + operacao + '>' + corpo + '</v1:' + operacao + '></soapenv:Body></soapenv:Envelope>';
  }

  function chamar(url, action, envelope) {
    const c = ctx.credencial();
    return new Promise((ok, falha) => {
      const rq = https.request(url, {
        method: 'POST', key: c.key, cert: c.chain, ca: E.ESOCIAL_CA_PEM ? E.ESOCIAL_CA_PEM.replace(/\\n/g, '\n') : undefined, minVersion: 'TLSv1.2', timeout: 60000,
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: action, 'Content-Length': Buffer.byteLength(envelope) }
      }, rs => { let t = ''; rs.on('data', x => t += x); rs.on('end', () => ok({ status: rs.statusCode, texto: t })); });
      rq.on('timeout', () => rq.destroy(new Error('Tempo esgotado ao falar com o eSocial')));
      rq.on('error', falha); rq.end(envelope);
    });
  }

  const tv = (x, t) => { const m = new RegExp('<(?:\\w+:)?' + t + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + t + '>').exec(x || ''); return m ? m[1].trim() : ''; };
  function ocorrencias(x) {
    const out = [], re = /<ocorrencia>([\s\S]*?)<\/ocorrencia>/g; let m;
    while ((m = re.exec(x || ''))) out.push({ tipo: tv(m[1], 'tipo'), codigo: tv(m[1], 'codigo'), descricao: tv(m[1], 'descricao'), localizacao: tv(m[1], 'localizacao') });
    return out;
  }
  const msgs = (cd, desc, oc) => [].concat(cd || desc ? [(cd ? cd + ' - ' : '') + (desc || '')] : [], oc.map(o => [o.codigo, o.descricao, o.localizacao && '(' + o.localizacao + ')'].filter(Boolean).join(' - ')));

  function lerEnvio(r) {
    const x = r.texto, falha = tv(x, 'faultstring');
    if (falha) return { estado: 'erro', msgs: [falha] };
    const st = tv(x, 'status'), cd = tv(st, 'cdResposta'), desc = tv(st, 'descResposta'), oc = ocorrencias(x), prot = tv(x, 'protocoloEnvio');
    if (cd === '201' && prot) return { estado: 'enviado', cd: cd, protocolo: prot, msgs: [] };
    return { estado: 'erro', cd: cd, msgs: msgs(cd, desc || ('HTTP ' + r.status + (cd ? '' : ': ' + x.slice(0, 300))), oc) };
  }
  function lerConsulta(r) {
    const x = r.texto, falha = tv(x, 'faultstring');
    if (falha) return { estado: 'erro', msgs: [falha] };
    const st = tv(x.split('<retornoEventos')[0], 'status'), cd = tv(st, 'cdResposta'), desc = tv(st, 'descResposta');
    const ev = /<evento(?:\s[^>]*)?>([\s\S]*?)<\/evento>/.exec(x);
    if (ev) {
      const proc = tv(ev[1], 'processamento'), cde = tv(proc, 'cdResposta'), dse = tv(proc, 'descResposta'), oc = ocorrencias(proc), rec = tv(tv(ev[1], 'recibo'), 'nrRecibo');
      if (/^2/.test(cde)) return { estado: 'processado', cd: cde, recibo: rec, msgs: msgs('', dse, oc) };
      return { estado: 'rejeitado', cd: cde, msgs: msgs(cde, dse, oc) };
    }
    if (/^1/.test(cd)) return { estado: 'enviado', cd: cd, msgs: [(cd + ' - ' + desc).trim()] };
    return { estado: 'erro', cd: cd, msgs: msgs(cd, desc || ('HTTP ' + r.status + ': ' + x.slice(0, 300)), ocorrencias(x)) };
  }

  /* Gera (e, se houver certificado, assina) o S-2200 de um funcionário */
  function gerar(d, seq, hk) {
    const dps = montarS2200(d, seq, hk);
    let xml = '<eSocial xmlns="' + NS_EVT + '">' + dps.evt + dps.extra + '</eSocial>', assinado = false, erroCert = '';
    if (hk) return { id: dps.id, xml: xml, assinado: false, erroCert: '' };
    try { const c = ctx.credencial(); xml = assinar(dps.evt, dps.id, c.key, c.chain); assinado = true; } catch (e) { erroCert = (e && e.erro) || (e && e.message) || ''; /* sem certificado: devolve sem assinatura */ }
    return { id: dps.id, xml: xml, assinado: assinado, erroCert: erroCert };
  }

  async function admissao(corpo) {
    const d = corpo.func || {}, probs = validar(d);
    if (corpo.hk) { const h = gerar(d, corpo.seq, true); return { ok: true, ambiente: ambiente(), evtId: h.id, xml: h.xml, assinado: false, faltam: probs }; } /* exportação para o HK: sem assinatura e sem exigir tudo */
    if (probs.length) return { ok: false, ambiente: ambiente(), estado: 'incompleto', erros: probs.map(p => 'Falta/inválido: ' + p) };
    const g = gerar(d, corpo.seq);
    if (corpo.apenasXml) return { ok: true, ambiente: ambiente(), evtId: g.id, xml: g.xml, assinado: g.assinado, avisoCert: g.erroCert };
    if (!g.assinado) throw { status: 500, erro: g.erroCert || 'Certificado digital não configurado no servidor (CERT_PFX_BASE64 + CERT_PASSWORD).' };
    const env = soap(NS_SOAP_ENVIO, 'EnviarLoteEventos', '<v1:loteEventos>' + montarLote([{ id: g.id, xml: g.xml }]) + '</v1:loteEventos>');
    const r = lerEnvio(await chamar(URL_ENVIO, NS_SOAP_ENVIO + '/ServicoEnviarLoteEventos/EnviarLoteEventos', env));
    return { ok: r.estado === 'enviado', ambiente: ambiente(), evtId: g.id, estado: r.estado, protocolo: r.protocolo, erros: r.msgs };
  }

  async function consulta(corpo) {
    const prot = String(corpo.protocolo || '').trim();
    if (!prot) throw { status: 400, erro: 'Informe o protocolo do envio.' };
    const env = soap(NS_SOAP_CONS, 'ConsultarLoteEventos', '<v1:consulta><eSocial xmlns="' + NS_CONS + '"><consultaLoteEventos><protocoloEnvio>' + esc(prot) + '</protocoloEnvio></consultaLoteEventos></eSocial></v1:consulta>');
    const r = lerConsulta(await chamar(URL_CONSULTA, NS_SOAP_CONS + '/ServicoConsultarLoteEventos/ConsultarLoteEventos', env));
    return { ok: r.estado !== 'erro', ambiente: ambiente(), estado: r.estado, recibo: r.recibo, erros: r.msgs };
  }

  return { admissao, consulta, gerar, montarS2200, assinar, montarLote, lerEnvio, lerConsulta, validar, ambiente, constantes: { NS_EVT, NS_LOTE, URL_ENVIO, URL_CONSULTA } };
}

module.exports = criar;
module.exports.validar = validar;
module.exports.cpfOk = cpfOk;
module.exports.cnpjOk = cnpjOk;
