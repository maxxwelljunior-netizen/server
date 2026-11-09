'use strict';
/*
  AXIS — Radar de licitações: consulta a API pública do PNCP (Portal Nacional de Contratações Públicas).
  - pesquisar(): editais com recebimento de propostas aberto, filtrados por TODAS as palavras do objeto
    (a API do PNCP não tem busca por palavra; o filtro é feito aqui).
  - orgao(): contratos publicados pelo órgão nos últimos 12 meses (Raio-X do comprador).
  Não precisa de chave. Respeita o limite de chamadas do PNCP (uma chamada por vez, com pausa).
*/
const BASE = process.env.PNCP_BASE || 'https://pncp.gov.br/api/consulta/v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dig = s => String(s == null ? '' : s).replace(/\D/g, '');
const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const ymd = d => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
const addDias = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const iso = s => (s ? String(s).slice(0, 10) : '');
const hora = s => (s && String(s).length >= 16 ? String(s).slice(11, 16) : '');

/* Códigos de modalidade do PNCP */
const MODALIDADES = { 1: 'Leilão eletrônico', 2: 'Diálogo competitivo', 3: 'Concurso', 4: 'Concorrência eletrônica', 5: 'Concorrência presencial', 6: 'Pregão eletrônico', 7: 'Pregão presencial', 8: 'Dispensa', 9: 'Inexigibilidade', 12: 'Credenciamento' };
const GRUPOS = { principais: [6, 4, 5, 7], rapida: [8, 9], pregao: [6, 7], concorrencia: [4, 5], dispensa: [8], credenciamento: [12] };

let ultima = 0, fila = Promise.resolve();
const cache = new Map();

async function pncp(caminho, params) {
  const espera = 450 - (Date.now() - ultima); if (espera > 0) await sleep(espera);
  ultima = Date.now();
  const qs = new URLSearchParams(params).toString();
  let r;
  try { r = await fetch(BASE + caminho + '?' + qs, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(25000) }); }
  catch (e) { throw { falha: 'sem_resposta' }; }
  if (r.status === 204) return { data: [], totalPaginas: 0 };
  if (r.status === 429) throw { falha: 'limite_excedido' };
  const t = await r.text();
  if (!r.ok) throw { falha: 'http_' + r.status };
  try { return JSON.parse(t); } catch (e) { throw { falha: 'resposta_invalida' }; }
}

const RE_SERV = /\b(servico|servicos|prestacao|contratacao de empresa|manutencao|locacao|limpeza|conservacao|vigilancia|terceirizacao|mao de obra|obra|obras|reforma|consultoria|assessoria|execucao)\b/;
const RE_COMP = /\b(aquisicao|compra|fornecimento|material|materiais|equipamento|equipamentos|medicamento|medicamentos|insumos|produtos|genero|generos)\b/;
function tipoObjeto(obj) {
  const t = norm(obj), a = t.search(RE_SERV), b = t.search(RE_COMP);
  if (a < 0 && b < 0) return 'outro';
  if (a < 0) return 'compra';
  if (b < 0) return 'servico';
  return a <= b ? 'servico' : 'compra';
}

function normalizar(c) {
  const og = c.orgaoEntidade || {}, un = c.unidadeOrgao || {}, cnpj = dig(og.cnpj);
  const ano = c.anoCompra, seq = c.sequencialCompra, valor = Number(c.valorTotalEstimado);
  return {
    id: c.numeroControlePNCP || (cnpj + '-' + ano + '-' + seq),
    cnpj: cnpj, orgao: og.razaoSocial || un.nomeUnidade || '', unidade: un.nomeUnidade || '',
    uf: un.ufSigla || '', cidade: un.municipioNome || '',
    modalidade: c.modalidadeNome || MODALIDADES[c.modalidadeId] || '', modId: c.modalidadeId,
    disputa: c.modoDisputaNome || '', situacao: c.situacaoCompraNome || '',
    numero: (c.numeroCompra ? c.numeroCompra + (ano ? '/' + ano : '') : ''), processo: c.processo || '',
    objeto: String(c.objetoCompra || '').replace(/\s+/g, ' ').trim(),
    valor: valor > 0 ? valor : null,
    publicacao: iso(c.dataPublicacaoPncp), abertura: iso(c.dataAberturaProposta), horaAbertura: hora(c.dataAberturaProposta),
    encerramento: iso(c.dataEncerramentoProposta), horaEncerramento: hora(c.dataEncerramentoProposta),
    tipo: tipoObjeto(c.objetoCompra),
    link: cnpj && ano && seq ? 'https://pncp.gov.br/app/editais/' + cnpj + '/' + ano + '/' + seq : '',
    origem: c.linkSistemaOrigem || ''
  };
}

async function pesquisar(q) {
  q = q || {};
  const palavras = norm(q.q).split(/\s+/).filter(w => w.length > 1).map(w => (w.length > 4 ? w.replace(/(es|s)$/, '') : w));   /* "serviços" também acha "serviço" */
  const uf = /^[A-Za-z]{2}$/.test(q.uf || '') ? q.uf.toUpperCase() : '';
  const cidade = norm(q.cidade).trim();
  const dias = Math.min(Math.max(parseInt(q.dias, 10) || 30, 7), 90);
  const mods = (GRUPOS[q.grupo] || GRUPOS.principais).slice(0, 4);
  const chave = JSON.stringify([palavras, uf, cidade, dias, mods]);
  const c = cache.get(chave); if (c && Date.now() - c.t < 10 * 60e3) return Object.assign({ cache: true }, c.r);

  const fim = ymd(addDias(new Date(), dias)), status = [], vistos = new Map(); let chamadas = 0, analisados = 0, parcial = false;
  for (const mod of mods) {
    let paginas = 1;
    for (let pag = 1; pag <= Math.min(paginas, 5); pag++) {
      if (chamadas >= 14) { parcial = true; break; }
      chamadas++;
      try {
        const p = { dataFinal: fim, codigoModalidadeContratacao: mod, pagina: pag, tamanhoPagina: 50 }; if (uf) p.uf = uf;
        const j = await pncp('/contratacoes/proposta', p), lista = Array.isArray(j.data) ? j.data : [];
        paginas = j.totalPaginas || 1; if (paginas > 5) parcial = true;
        analisados += lista.length; lista.forEach(x => { const n = normalizar(x); vistos.set(n.id, n); });
        if (!lista.length) break;
      } catch (e) { status.push({ modalidade: MODALIDADES[mod], erro: e.falha || 'falha' }); parcial = true; break; }
    }
  }
  const hoje = new Date().toISOString().slice(0, 10);
  const itens = [...vistos.values()].filter(n => {
    if (uf && n.uf && n.uf.toUpperCase() !== uf) return false;
    if (cidade && norm(n.cidade).indexOf(cidade) < 0) return false;
    if (n.encerramento && n.encerramento < hoje) return false;
    const t = norm(n.objeto + ' ' + n.unidade);
    return palavras.every(w => t.indexOf(w) >= 0);
  }).sort((a, b) => (a.encerramento || '9999') < (b.encerramento || '9999') ? -1 : 1);
  const r = { ok: true, itens: itens, analisados: analisados, parcial: parcial, falhas: status, ate: fim, palavras: palavras };
  if (!status.length || itens.length) cache.set(chave, { t: Date.now(), r: r });
  return r;
}

/* Raio-X do comprador: contratos publicados pelo órgão (pessoas físicas ficam de fora, por LGPD) */
async function orgao(q) {
  const cnpj = dig(q && q.cnpj);
  if (cnpj.length !== 14) throw { status: 400, erro: 'Informe o CNPJ do órgão (14 dígitos).' };
  const chave = 'o' + cnpj, c = cache.get(chave); if (c && Date.now() - c.t < 30 * 60e3) return Object.assign({ cache: true }, c.r);
  const hoje = new Date(), ini = ymd(addDias(hoje, -365)), fim = ymd(hoje), todos = [], falhas = []; let paginas = 1;
  for (let pag = 1; pag <= Math.min(paginas, 3); pag++) {
    try { const j = await pncp('/contratos', { dataInicial: ini, dataFinal: fim, cnpjOrgao: cnpj, pagina: pag, tamanhoPagina: 100 }); paginas = j.totalPaginas || 1; (j.data || []).forEach(x => todos.push(x)); if (!(j.data || []).length) break; }
    catch (e) { falhas.push(e.falha || 'falha'); break; }
  }
  const hj = new Date().toISOString().slice(0, 10), lim = addDias(new Date(), 120).toISOString().slice(0, 10);
  let omitidosPF = 0; const pj = [];
  todos.forEach(x => {
    const ni = dig(x.niFornecedor), pf = x.tipoPessoa === 'PF' || (ni.length === 11);
    if (pf) { omitidosPF++; return; }
    pj.push({ fornecedor: x.nomeRazaoSocialFornecedor || '', cnpjFornecedor: ni, objeto: String(x.objetoContrato || '').replace(/\s+/g, ' ').trim().slice(0, 240), valor: Number(x.valorGlobal || x.valorInicial) || 0,
      inicio: iso(x.dataVigenciaInicio), fim: iso(x.dataVigenciaFim), numero: x.numeroContratoEmpenho || '', link: x.numeroControlePNCP || '' });
  });
  const vigentes = pj.filter(x => !x.fim || x.fim >= hj), venc = vigentes.filter(x => x.fim && x.fim <= lim).sort((a, b) => a.fim < b.fim ? -1 : 1), porForn = {};
  vigentes.forEach(x => { const k = x.fornecedor || x.cnpjFornecedor; if (k) porForn[k] = (porForn[k] || 0) + x.valor; });
  const nome = todos[0] && todos[0].orgaoEntidade ? todos[0].orgaoEntidade.razaoSocial : '';
  const r = { ok: true, cnpj: cnpj, nome: nome, publicados: todos.length, vigentes: vigentes.length, valorVigente: vigentes.reduce((s, x) => s + x.valor, 0), omitidosPF: omitidosPF,
    vencendo: venc.slice(0, 15), fornecedores: Object.keys(porForn).map(k => ({ nome: k, valor: porForn[k] })).sort((a, b) => b.valor - a.valor).slice(0, 8), parcial: paginas > 3, falhas: falhas };
  if (!falhas.length) cache.set(chave, { t: Date.now(), r: r });
  return r;
}

/* uma consulta por vez, para não estourar o limite do PNCP */
const serial = fn => { const p = fila.then(fn, fn); fila = p.catch(() => {}); return p; };

module.exports = { pesquisar: q => serial(() => pesquisar(q)), orgao: q => serial(() => orgao(q)), tipoObjeto, normalizar, norm, MODALIDADES };
