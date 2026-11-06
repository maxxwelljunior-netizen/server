'use strict';
/*
  AXIS — robô do Super Portal VR (roda no servidor, em segundo plano).
  1) enviar:  gera o arquivo do pedido aprovado, abre o portal, sobe o arquivo e confirma (conforme o roteiro).
  2) boleto:  de tempos em tempos, busca o boleto do pedido enviado, baixa o PDF e lança em Contas a pagar.
  3) descobrir: faz login e fotografa/mapeia as telas do portal, para montar o roteiro.

  Segurança:
   - usuário e senha do portal só em variáveis de ambiente do servidor (VR_USUARIO, VR_SENHA); nunca vão para o navegador nem para o banco.
   - o passo marcado "final": true (o clique que realmente confirma o pedido) só roda com ROBO_CONFIRMA_FINAL=SIM; sem isso o robô para antes (modo teste).
   - o robô só envia pedido APROVADO no Axis, uma única vez.

  Variáveis: VR_PORTAL_URL, VR_USUARIO, VR_SENHA, SUPABASE_URL, SUPABASE_SERVICE_KEY (chave de serviço: SÓ no servidor),
             ROBO_CONFIRMA_FINAL, ROBO_ROTEIRO (caminho do JSON), ROBO_INTERVALO_MIN (padrão 60), ROBO_MAX_TENTATIVAS (padrão 96), ROBO_HEADED.
  Dependência: playwright (npm i playwright && npx playwright install --with-deps chromium).
*/
const fs = require('fs'), os = require('os'), path = require('path');

/* ---------- boleto: linha digitável (47 dígitos) ---------- */
function mod10(s) { let t = 0, p = 2; for (let i = s.length - 1; i >= 0; i--) { let n = +s[i] * p; if (n > 9) n = Math.floor(n / 10) + n % 10; t += n; p = p == 2 ? 1 : 2; } return (10 - t % 10) % 10; }
function mod11(s) { let t = 0, p = 2; for (let i = s.length - 1; i >= 0; i--) { t += +s[i] * p; p = p == 9 ? 2 : p + 1; } const r = 11 - t % 11; return (r === 0 || r === 10 || r === 11) ? 1 : r; }
const iso = d => d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
/* o fator de vencimento conta dias desde 07/10/1997 e reinicia em 1000 a cada 9000 dias; escolhe a data mais próxima de "ref" */
function fatorParaData(f, ref) {
  if (!+f) return '';
  const base = new Date(1997, 9, 7, 12), r = ref || new Date(); let melhor = null;
  for (let k = 0; k < 4; k++) { const d = new Date(base); d.setDate(d.getDate() + (+f) + 9000 * k); if (!melhor || Math.abs(d - r) < Math.abs(melhor - r)) melhor = d; }
  return iso(melhor);
}
function decodificarLinha(linha, ref) {
  const d = String(linha || '').replace(/\D/g, '');
  if (d.length !== 47) return { ok: false, erro: 'A linha digitável precisa ter 47 dígitos (boleto bancário).' };
  const c1 = d.slice(0, 9), c2 = d.slice(10, 20), c3 = d.slice(21, 31);
  if (mod10(c1) != d[9] || mod10(c2) != d[20] || mod10(c3) != d[31]) return { ok: false, erro: 'Dígito verificador de um dos campos não confere.' };
  const livre = c1.slice(4) + c2 + c3, barra = d.slice(0, 4) + d[32] + d.slice(33, 47) + livre;
  if (mod11(barra.slice(0, 4) + barra.slice(5)) != d[32]) return { ok: false, erro: 'Dígito verificador geral não confere.' };
  return { ok: true, banco: d.slice(0, 3), valor: parseInt(d.slice(37, 47), 10) / 100, venc: fatorParaData(d.slice(33, 37), ref), linha: d };
}
const reLinha = /(\d{5}[.\s]?\d{5}\s+\d{5}[.\s]?\d{6}\s+\d{5}[.\s]?\d{6}\s+\d\s+\d{14})/;
const aaaammdd = s => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || ''); return m ? m[3] + '-' + m[2] + '-' + m[1] : ''; };
const reais = s => { const t = String(s || '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'); const n = parseFloat(t); return isNaN(n) ? 0 : n; };

module.exports = function (o) {
  const E = o.E, VRL = o.VRL, dir = E.ROBO_DEBUG_DIR || path.join(os.tmpdir(), 'axis-robo');
  fs.mkdirSync(dir, { recursive: true });
  const roteiroPath = () => E.ROBO_ROTEIRO || path.join(__dirname, 'robo-vr-roteiro.json');
  const lerRoteiro = () => JSON.parse(fs.readFileSync(roteiroPath(), 'utf8'));
  const temTodo = p => !p || !p.length || JSON.stringify(p).indexOf('TODO') >= 0;
  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dmy = d => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '';

  /* ---------- Supabase (chave de serviço, só aqui no servidor) ---------- */
  async function rest(p, opt) {
    const r = await fetch(E.SUPABASE_URL + p, Object.assign({}, opt, { headers: Object.assign({ apikey: E.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + E.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' }, opt && opt.headers) }));
    const t = await r.text(); if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + t.slice(0, 200));
    try { return JSON.parse(t); } catch (e) { return t; }
  }
  const um = async (col, id) => (await rest('/rest/v1/registros?colecao=eq.' + col + '&id=eq.' + encodeURIComponent(id) + '&select=id,dados'))[0] || null;
  async function patch(col, id, p) {
    const x = await um(col, id); if (!x) throw new Error('Registro não encontrado: ' + col + '/' + id);
    const dados = Object.assign({}, x.dados, p);
    await rest('/rest/v1/registros?colecao=eq.' + col + '&id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ dados: dados, atualizado_em: new Date().toISOString() }) });
    return dados;
  }
  async function subir(buf, nome, tipo) {
    const r = await fetch(E.SUPABASE_URL + '/storage/v1/object/documentos/' + nome, { method: 'POST', headers: { apikey: E.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + E.SUPABASE_SERVICE_KEY, 'Content-Type': tipo, 'x-upsert': 'true' }, body: buf });
    if (!r.ok) throw new Error('Storage ' + r.status);
    return nome;
  }
  async function marca(id, estado, msg, extra) {
    const x = await um('benped', id), rb = Object.assign({}, x && x.dados.robo), log = (rb.log || []).slice(-39);
    log.push(new Date().toISOString().slice(0, 19).replace('T', ' ') + ' · ' + msg);
    return patch('benped', id, { robo: Object.assign(rb, extra || {}, { estado: estado, msg: msg, em: new Date().toISOString(), log: log }) });
  }

  /* ---------- navegador: executa o roteiro ---------- */
  async function rodar(passos, vars, tag, aviso, aoConfirmar) {
    let chromium; try { chromium = require('playwright').chromium; } catch (e) { throw new Error('Playwright não está instalado no servidor (npm i playwright && npx playwright install --with-deps chromium).'); }
    const b = await chromium.launch({ headless: !E.ROBO_HEADED }), ctx = await b.newContext({ acceptDownloads: true, locale: 'pt-BR' }), page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    const vs = Object.assign({}, vars), caps = [], sub = s => String(s == null ? '' : s).replace(/\{\{(\w+)\}\}/g, (m, k) => vs[k] != null ? vs[k] : '');
    const foto = async nome => { try { const f = path.join(dir, tag + '-' + Date.now() + '-' + nome.replace(/[^\w-]/g, '_') + '.png'); await page.screenshot({ path: f, fullPage: true }); caps.push(f); } catch (e) {} };
    let i = 0, parado = false;
    try {
      for (; i < passos.length; i++) {
        const s = passos[i]; if (aviso) aviso('Passo ' + (i + 1) + '/' + passos.length + ': ' + s.a + (s.texto ? ' “' + s.texto + '”' : ''));
        if (s.final && E.ROBO_CONFIRMA_FINAL !== 'SIM') { parado = true; await foto('parou-antes-de-confirmar'); break; }
        const alvo = () => s.seletor ? page.locator(sub(s.seletor)).first() : page.locator('button,a,[role=button],[role=menuitem],[role=tab],input[type=submit],input[type=button]').filter({ hasText: new RegExp(esc(sub(s.texto)), 'i') }).first();
        switch (s.a) {
          case 'ir': await page.goto(sub(s.url) || E.VR_PORTAL_URL, { waitUntil: 'domcontentloaded' }); break;
          case 'login': {
            if (!E.VR_USUARIO || !E.VR_SENHA) throw new Error('VR_USUARIO e VR_SENHA não estão configurados no servidor.');
            await (s.usuario ? page.locator(s.usuario).first() : page.locator('input[type=email],input[name*=user i],input[name*=login i],input[id*=user i],input[id*=login i],input[type=text]').first()).fill(E.VR_USUARIO);
            await (s.senha ? page.locator(s.senha).first() : page.locator('input[type=password]').first()).fill(E.VR_SENHA);
            await (s.botao ? page.locator(s.botao).first() : page.getByRole('button', { name: /entrar|acessar|login|continuar/i }).first()).click();
            await page.waitForLoadState('networkidle').catch(() => {});
            const t = (await page.locator('body').innerText()).toLowerCase();
            if (/captcha|c[oó]digo de verifica[cç][aã]o|autentica[cç][aã]o em (dois|2) fatores|enviamos um c[oó]digo/.test(t)) throw new Error('O portal pediu verificação adicional (captcha ou código). O robô não consegue continuar sozinho.');
            if (await page.locator('input[type=password]').first().isVisible().catch(() => false)) throw new Error('O login não foi concluído (confira VR_USUARIO e VR_SENHA).');
            break; }
          case 'clicar': await alvo().click(); await page.waitForLoadState('domcontentloaded').catch(() => {}); break;
          case 'preencher': await (s.rotulo ? page.getByLabel(new RegExp(esc(s.rotulo), 'i')).first() : page.locator(sub(s.seletor)).first()).fill(sub(s.valor)); break;
          case 'arquivo': await page.locator(sub(s.seletor) || 'input[type=file]').first().setInputFiles(sub(s.arquivo)); break;
          case 'esperar': if (s.texto) await page.getByText(new RegExp(esc(sub(s.texto)), 'i')).first().waitFor({ timeout: s.timeout || 60000 }); else await page.waitForTimeout(s.ms || 1000); break;
          case 'ler': {
            const t = s.seletor ? await page.locator(sub(s.seletor)).first().innerText() : await page.locator('body').innerText(), m = new RegExp(s.regex || '.+').exec(t);
            if (!m && s.obrigatorio) throw new Error('Não encontrei na tela: ' + (s.como || s.regex)); vs[s.como || 'lido'] = m ? (m[1] || m[0]) : ''; break; }
          case 'baixar': {
            const [d] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), alvo().click()]);
            const f = path.join(dir, tag + '-' + Date.now() + '-' + d.suggestedFilename().replace(/[^\w.-]/g, '_')); await d.saveAs(f); vs[s.como || 'baixado'] = f; break; }
          case 'foto': await foto(s.nome || 'passo' + (i + 1)); break;
          default: throw new Error('Ação desconhecida no roteiro: ' + s.a);
        }
        if (s.final && aoConfirmar) await aoConfirmar();   /* a confirmação já aconteceu: registra na hora, para ninguém reenviar */
      }
    } catch (e) { await foto('erro'); e.message = 'Passo ' + (i + 1) + ' (' + ((passos[i] || {}).a) + '): ' + e.message; throw e; }
    finally { await b.close(); }
    return { vars: vs, capturas: caps, parado: parado };
  }
  async function subirCapturas(arqs, pasta) {
    const out = []; for (const f of arqs) { try { const n = 'robo/' + pasta + '/' + path.basename(f); await subir(fs.readFileSync(f), n, 'image/png'); out.push(n); } catch (e) { console.error('captura:', e.message); } } return out;
  }

  /* ---------- tarefas ---------- */
  async function enviar(id) {
    const x = await um('benped', id); if (!x) throw new Error('Pedido não encontrado.'); const p = x.dados;
    if (p.status !== 'aprovado') throw new Error('Só pedido APROVADO pode ser enviado pelo robô.');
    if (p.robo && p.robo.enviado) throw new Error('Este pedido já foi enviado pelo robô.');
    if (!p.itens || !p.itens.length) throw new Error('Pedido sem funcionários.');
    const cf = await um('bencfg', 'cfg'); if (!cf) throw new Error('Dados da empresa para o arquivo não configurados.');
    const rot = lerRoteiro(); if (temTodo(rot.envio)) throw new Error('O roteiro de envio ainda tem passos “TODO”. Rode “Descobrir telas” e complete o roteiro.');
    const txt = VRL.gerar(cf.dados, p.itens, p.cred), arq = path.join(dir, 'VR_pedido_' + p.comp + '.txt'); fs.writeFileSync(arq, txt, 'latin1');
    await marca(id, 'executando', 'Abrindo o portal da VR…');
    try {
      const r = await rodar(rot.envio, { arquivo: arq, competencia: p.comp, credito: dmy(p.cred), total: Number(p.total).toFixed(2).replace('.', ',') }, id, m => marca(id, 'executando', m).catch(() => {}), async () => { await patch('benped', id, { status: 'enviado', enviadoEm: new Date().toISOString() }); await marca(id, 'aguardando_boleto', 'Pedido confirmado no portal. Conferindo o número do pedido…', { enviado: true, tentativas: 0 }); });
      const caps = await subirCapturas(r.capturas, id);
      if (r.parado) return marca(id, 'parado', 'Modo teste: o robô foi até a tela de confirmação e parou. Nada foi enviado. Para enviar de verdade, defina ROBO_CONFIRMA_FINAL=SIM.', { capturas: caps });
      return marca(id, 'aguardando_boleto', 'Pedido enviado ao portal' + (r.vars.numeroPedido ? ' (nº ' + r.vars.numeroPedido + ')' : '') + '. Aguardando o boleto.', { enviado: true, numeroPedidoVR: r.vars.numeroPedido || '', capturas: caps, tentativas: 0 });
    } catch (e) {
      const y = await um('benped', id).catch(() => null);
      if (y && y.dados.robo && y.dados.robo.enviado) await marca(id, 'aguardando_boleto', 'O pedido FOI confirmado no portal, mas um passo seguinte falhou (' + e.message + '). Não reenvie: confira o pedido no portal.').catch(() => {});
      else await marca(id, 'erro', e.message).catch(() => {});
      throw e;
    }
  }
  async function boleto(id) {
    const x = await um('benped', id); if (!x) throw new Error('Pedido não encontrado.'); const p = x.dados;
    if (p.status !== 'enviado' || !(p.robo && p.robo.enviado)) throw new Error('O pedido não está aguardando boleto do robô.');
    const rot = lerRoteiro(); if (temTodo(rot.boleto)) throw new Error('O roteiro do boleto ainda tem passos “TODO”.');
    const r0 = p.robo || {}; await marca(id, 'executando', 'Procurando o boleto no portal…', { tentativas: (r0.tentativas || 0) + 1 });
    try {
      const r = await rodar(rot.boleto, { pedido: r0.numeroPedidoVR || '', competencia: p.comp, total: Number(p.total).toFixed(2).replace('.', ',') }, id);
      const caps = await subirCapturas(r.capturas, id);
      if (!r.vars.boleto) return marca(id, 'aguardando_boleto', 'Boleto ainda não disponível no portal.', { capturas: caps });
      const buf = fs.readFileSync(r.vars.boleto), nome = 'boleto-' + id + '-' + path.basename(r.vars.boleto).replace(/[^\w.-]/g, '_'); await subir(buf, nome, 'application/pdf');
      let lin = (reLinha.exec(r.vars.linha || '') || [])[1];
      if (!lin) { try { const t = (await require('pdf-parse')(buf)).text; lin = (reLinha.exec(t) || [])[1]; } catch (e) { /* pdf-parse é opcional */ } }
      let venc = '', valor = 0, linha = '';
      const dec = lin ? decodificarLinha(lin) : null;
      if (dec && dec.ok) { venc = dec.venc; valor = dec.valor; linha = dec.linha; }
      else { venc = aaaammdd(r.vars.venc); valor = reais(r.vars.valor); linha = (lin || '').replace(/\D/g, ''); }
      if (!venc || !(valor > 0)) return marca(id, 'erro', 'Baixei o boleto, mas não consegui ler vencimento e valor. Lance manualmente (o PDF está salvo).', { capturas: caps, boletoDoc: nome });
      const dif = Math.abs(valor - p.total) > 0.005, ja = await rest('/rest/v1/registros?colecao=eq.pagar&dados->>benPedido=eq.' + encodeURIComponent(id) + '&select=id');
      let pid = ja[0] && ja[0].id;
      if (!pid) pid = (await rest('/rest/v1/registros', { method: 'POST', body: JSON.stringify({ colecao: 'pagar', dados: { fornecedor: 'VR Benefícios', cat: 'Benefícios', comp: p.comp, venc: venc, valor: valor, forma: 'Boleto', status: 'Em aberto', obs: 'Pedido VR ' + p.comp.split('-').reverse().join('/') + ' (lançado pelo robô)' + (linha ? ' · Linha digitável: ' + linha : '') + (dif ? ' · ATENÇÃO: valor diferente do pedido (' + p.total.toFixed(2) + ')' : ''), linha: linha, boletoDoc: nome, benPedido: id, origem: 'robo' } }) }))[0].id;
      await patch('benped', id, { status: 'boleto', boleto: { venc: venc, valor: valor, linha: linha, doc: nome, pagarId: pid } });
      return marca(id, 'ok', 'Boleto lançado em Contas a pagar (' + dmy(venc) + ', R$ ' + valor.toFixed(2).replace('.', ',') + ')' + (dif ? ' — DIFERENTE do pedido' : '') + '.', { capturas: caps, alerta: dif ? 'Valor do boleto diferente do pedido.' : '' });
    } catch (e) { await marca(id, 'aguardando_boleto', 'Falha ao buscar o boleto: ' + e.message).catch(() => {}); throw e; }
  }
  async function descobrir() {
    if (!E.VR_PORTAL_URL) throw new Error('VR_PORTAL_URL não configurado.');
    let chromium; try { chromium = require('playwright').chromium; } catch (e) { throw new Error('Playwright não está instalado no servidor.'); }
    const b = await chromium.launch({ headless: !E.ROBO_HEADED }), ctx = await b.newContext({ locale: 'pt-BR' }), page = await ctx.newPage(), mapa = [], caps = [];
    page.setDefaultTimeout(30000);
    const ver = async nome => {
      const f = path.join(dir, 'descoberta-' + Date.now() + '-' + nome + '.png'); await page.screenshot({ path: f, fullPage: true }).catch(() => {}); caps.push(f);
      mapa.push(await page.evaluate(n => ({ nome: n, url: location.href, titulo: document.title,
        links: [...document.querySelectorAll('a[href]')].map(a => ({ t: a.innerText.trim().slice(0, 60), h: a.getAttribute('href') })).filter(x => x.t).slice(0, 60),
        botoes: [...document.querySelectorAll('button,[role=button],input[type=submit]')].map(e => (e.innerText || e.value || '').trim().slice(0, 60)).filter(Boolean).slice(0, 40),
        campos: [...document.querySelectorAll('input,select,textarea')].map(e => ({ tipo: e.type || e.tagName, nome: e.name || e.id || '', rotulo: e.placeholder || e.getAttribute('aria-label') || '' })).slice(0, 40) }), nome));
    };
    try {
      await page.goto(E.VR_PORTAL_URL, { waitUntil: 'domcontentloaded' });
      await page.locator('input[type=email],input[name*=user i],input[name*=login i],input[id*=user i],input[id*=login i],input[type=text]').first().fill(E.VR_USUARIO);
      await page.locator('input[type=password]').first().fill(E.VR_SENHA);
      await page.getByRole('button', { name: /entrar|acessar|login|continuar/i }).first().click(); await page.waitForLoadState('networkidle').catch(() => {});
      await ver('inicial');
      if (/captcha|c[oó]digo de verifica[cç][aã]o|autentica[cç][aã]o em (dois|2) fatores|enviamos um c[oó]digo/i.test(await page.locator('body').innerText())) mapa[0].aviso = 'O portal pediu verificação adicional (captcha ou código): o robô não consegue entrar sozinho.';
      const base = new URL(page.url()).origin, vistos = {}, alvos = (mapa[0].links || []).filter(l => /^\/|^https?:/.test(l.h) && !/sair|logout|encerrar/i.test(l.t + l.h)).slice(0, 8);
      for (const l of alvos) { const u = new URL(l.h, page.url()); if (u.origin !== base || vistos[u.href]) continue; vistos[u.href] = 1; try { await page.goto(u.href, { waitUntil: 'domcontentloaded' }); await page.waitForLoadState('networkidle').catch(() => {}); await ver(l.t.replace(/[^\w]+/g, '_').slice(0, 24) || 'pagina'); } catch (e) {} }
    } finally { await b.close(); }
    const nomes = await subirCapturas(caps, 'descoberta');
    fs.writeFileSync(path.join(dir, 'mapa.json'), JSON.stringify(mapa, null, 1));
    await subir(Buffer.from(JSON.stringify(mapa, null, 1)), 'robo/descoberta/mapa.json', 'application/json').catch(() => {});
    const cf = await um('bencfg', 'cfg'); if (cf) await patch('bencfg', 'cfg', { roboCapturas: nomes.concat(['robo/descoberta/mapa.json']), roboCapturasEm: new Date().toISOString() });
    return { capturas: nomes.length, paginas: mapa.length };
  }

  /* ---------- fila, varredura e estado ---------- */
  let fila = Promise.resolve(); const ativos = {};
  function enfileirar(chave, fn) { if (ativos[chave]) return false; ativos[chave] = 1; fila = fila.then(fn).catch(e => console.error('robô:', e && e.message)).then(() => { delete ativos[chave]; }); return true; }
  const configurado = () => { const c = config(); return c.credenciais && c.servicoSupabase && c.playwright; };
  function config() {
    let pw = false; try { require.resolve('playwright'); pw = true; } catch (e) {}
    let rot = {}; try { rot = lerRoteiro(); } catch (e) {}
    return { playwright: pw, credenciais: !!(E.VR_PORTAL_URL && E.VR_USUARIO && E.VR_SENHA), servicoSupabase: !!(E.SUPABASE_URL && E.SUPABASE_SERVICE_KEY),
      roteiroEnvio: !temTodo(rot.envio), roteiroBoleto: !temTodo(rot.boleto), confirmaFinal: E.ROBO_CONFIRMA_FINAL === 'SIM' };
  }
  async function varrer() {
    if (!configurado() || temTodo(lerRoteiro().boleto)) return;
    const max = parseInt(E.ROBO_MAX_TENTATIVAS, 10) || 96;
    const l = await rest('/rest/v1/registros?colecao=eq.benped&select=id,dados');
    l.filter(x => x.dados.status === 'enviado' && x.dados.robo && x.dados.robo.enviado && (x.dados.robo.tentativas || 0) < max).forEach(x => enfileirar('boleto:' + x.id, () => boleto(x.id)));
  }
  function iniciar() { if (!configurado()) { console.log('Robô VR: desligado (faltam credenciais, chave de serviço ou Playwright).'); return; } const min = parseFloat(E.ROBO_INTERVALO_MIN) || 60; setInterval(() => varrer().catch(e => console.error('robô:', e.message)), min * 60000); setTimeout(() => varrer().catch(() => {}), 15000); console.log('Robô VR: ligado, busca de boleto a cada ' + min + ' min.'); }
  async function rota(d) {
    if (d.acao === 'status') return { ok: true, robo: config() };
    const c = config(); if (!c.servicoSupabase) throw { status: 500, erro: 'SUPABASE_URL e SUPABASE_SERVICE_KEY precisam estar configurados no servidor.' };
    if (!c.credenciais) throw { status: 500, erro: 'VR_PORTAL_URL, VR_USUARIO e VR_SENHA precisam estar configurados no servidor.' };
    if (d.acao === 'descobrir') { enfileirar('descobrir', () => descobrir()); return { ok: true, mensagem: 'Descoberta iniciada. As capturas aparecem em instantes na aba Empresa e layout.' }; }
    if (!d.pedidoId) throw { status: 400, erro: 'Informe o pedido.' };
    if (d.acao === 'enviar') { const ok = enfileirar('envio:' + d.pedidoId, () => enviar(d.pedidoId)); return { ok: ok, mensagem: ok ? 'Pedido na fila do robô.' : 'Este pedido já está em execução.' }; }
    if (d.acao === 'boleto') { const ok = enfileirar('boleto:' + d.pedidoId, () => boleto(d.pedidoId)); return { ok: ok, mensagem: ok ? 'Busca do boleto na fila.' : 'Já está em execução.' }; }
    throw { status: 400, erro: 'Ação desconhecida.' };
  }
  return { rota, iniciar, config, enviar, boleto, descobrir, decodificarLinha, fatorParaData };
};
module.exports.decodificarLinha = decodificarLinha;
module.exports.fatorParaData = fatorParaData;
