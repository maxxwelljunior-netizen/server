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
const GRUPOS = { principais: [6, 4, 5, 7], rapida: [8, 9], pregao: [6, 7], concorrencia: [4, 5], dispensa: [8], credenciamento: [12], todas: [6, 4, 5, 7, 8, 12] };

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

const stem = w => (w.length > 4 ? w.replace(/(es|s)$/, '') : w);
const bases = new Map();   /* leitura do PNCP guardada por estado + prazo + modalidades */
const ORCAMENTO = () => (parseInt(process.env.PNCP_ORCAMENTO_S, 10) || 40) * 1000;

async function carregarBase(uf, mods, dias, fim) {
  const chave = [uf, dias, mods.join(',')].join('|');
  let b = bases.get(chave);
  if (!b || Date.now() - b.t > 15 * 60e3) {
    b = { t: Date.now(), itens: new Map(), prog: {}, falhas: [] };
    mods.forEach(m => { b.prog[m] = { prox: 1, total: null, fim: false }; });
    bases.set(chave, b);
    if (bases.size > 20) bases.delete(bases.keys().next().value);
  }
  b.falhas = [];
  const t0 = Date.now();
  for (const mod of mods) {
    const pg = b.prog[mod];
    while (!pg.fim) {
      if (Date.now() - t0 > ORCAMENTO()) return b;           /* continua na próxima chamada */
      try {
        const p = { dataFinal: fim, codigoModalidadeContratacao: mod, pagina: pg.prox, tamanhoPagina: 50 }; if (uf) p.uf = uf;
        const j = await pncp('/contratacoes/proposta', p), lista = Array.isArray(j.data) ? j.data : [];
        pg.total = j.totalPaginas || pg.total || 1;
        lista.forEach(x => { const n = normalizar(x); b.itens.set(n.id, n); });
        pg.prox++;
        if (!lista.length || pg.prox > pg.total || pg.prox > 300) pg.fim = true;
      } catch (e) {
        b.falhas.push({ modalidade: MODALIDADES[mod], erro: e.falha || 'falha' });
        if (e.falha === 'limite_excedido') return b;          /* PNCP pediu pausa */
        break;
      }
    }
  }
  return b;
}

async function pesquisar(q) {
  q = q || {};
  /* vírgula, ponto e vírgula ou " ou " = alternativas (OU); dentro de cada uma, todas as palavras (E) */
  const grupos = String(q.q || '').split(/[,;]|\s+ou\s+/i).map(g => norm(g).split(/\s+/).filter(w => w.length > 1).map(stem)).filter(g => g.length);
  const uf = /^[A-Za-z]{2}$/.test(q.uf || '') ? q.uf.toUpperCase() : '';
  const cidade = norm(q.cidade).trim();
  const dias = Math.min(Math.max(parseInt(q.dias, 10) || 30, 7), 180);
  const mods = GRUPOS[q.grupo] || GRUPOS.principais;
  const fim = ymd(addDias(new Date(), dias));

  const b = await carregarBase(uf, mods, dias, fim);
  const hoje = new Date().toISOString().slice(0, 10);
  const itens = [...b.itens.values()].filter(n => {
    if (uf && n.uf && n.uf.toUpperCase() !== uf) return false;
    if (cidade && norm(n.cidade).indexOf(cidade) < 0) return false;
    if (n.encerramento && n.encerramento < hoje) return false;
    const t = norm(n.objeto + ' ' + n.unidade);
    return !grupos.length || grupos.some(g => g.every(w => t.indexOf(w) >= 0));
  }).sort((a, c) => (a.encerramento || '9999') < (c.encerramento || '9999') ? -1 : 1);

  const progs = mods.map(m => b.prog[m]), completo = progs.every(p => p.fim);
  return { ok: true, itens: itens, analisados: b.itens.size, completo: completo, parcial: !completo,
    paginasLidas: progs.reduce((s, p) => s + p.prox - 1, 0), paginasTotal: progs.reduce((s, p) => s + (p.total || 0), 0),
    falhas: b.falhas, ate: fim, palavras: grupos.reduce((a, g) => a.concat(g), []) };
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

/* IA nativa: gera minutas (impugnação, recurso, contrarrazões) pela API da Anthropic. A chave fica só no servidor. */
const SISTEMA = 'Você é advogado especialista em licitações e contratos administrativos (Lei 14.133/2021, LC 123/2006). Redige peças formais, objetivas e bem fundamentadas, em português do Brasil. Nunca invente acórdãos, súmulas, artigos ou números de processo: se não tiver certeza de uma citação, escreva "[conferir citação]". Use só os fatos informados; o que faltar, deixe entre colchetes.';
async function ia(d) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw { status: 500, erro: 'ANTHROPIC_API_KEY não está configurada no servidor.' };
  const pedido = String((d && d.pedido) || '').trim();
  if (pedido.length < 20) throw { status: 400, erro: 'Descreva o que contestar.' };
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(150000),
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 6000, system: SISTEMA, messages: [{ role: 'user', content: pedido.slice(0, 150000) }] }) });
  } catch (e) { throw { status: 502, erro: 'A IA não respondeu a tempo. Tente de novo.' }; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw { status: 502, erro: 'Erro da IA: ' + ((j.error && j.error.message) || r.status) };
  return { ok: true, texto: (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim() };
}

/* uma consulta por vez, para não estourar o limite do PNCP */
const serial = fn => { const p = fila.then(fn, fn); fila = p.catch(() => {}); return p; };

module.exports = { pesquisar: q => serial(() => pesquisar(q)), orgao: q => serial(() => orgao(q)), ia, tipoObjeto, normalizar, norm, MODALIDADES };
