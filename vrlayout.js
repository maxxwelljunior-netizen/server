/* Layout posicional (350 colunas) do arquivo de pedido do Super Portal VR — conferido contra um arquivo real (ArquivoGerado.txt). */
var VRL=(function(){
var W=350;
function limpa(s){return String(s==null?'':s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim()}
function txt(s,n){s=limpa(s);return (s+' '.repeat(n)).slice(0,n)}
function num(v,n){var d=String(v==null?'':v).replace(/\D/g,'');if(d.length>n)throw new Error('Número maior que o campo ('+n+'): '+v);return ('0'.repeat(n)+d).slice(-n)}
function sp(n){return ' '.repeat(n)}
function lin(corpo,seq){corpo=corpo+sp(W-9-corpo.length);if(corpo.length!=W-9)throw new Error('Linha '+seq+' com '+corpo.length+' colunas');return corpo+num(seq,9)}
var DEF={versao:'011',codLocal:'000000000000000000001',codBenef:'000000000001',nomeBenef:'BENEFICIOS',produto:'FXM',tpLogr:'RUA',cargaFim:'00'};
/* cfg: cnpj, razao, fantasia, tpLogr, logradouro, numero, compl, bairro, cidade, uf, cep, responsavel (+ campos de DEF)
   itens: [{cpf, nome, nasc:'AAAA-MM-DD'|'DDMMAAAA', sexo:'M'|'F'|'', valor: reais}]   dtCredito: 'AAAA-MM-DD' */
function gerar(cfg,itens,dtCredito){
  var c=Object.assign({},DEF,cfg),cnpj=num(c.cnpj,14),L=[],s=0,add=function(b){L.push(lin(b,++s))};
  add('00'+txt(c.versao,3).replace(/ /g,'0')+cnpj+txt(c.razao,322));
  add('10'+cnpj+c.codLocal+sp(9)+txt(c.fantasia||c.razao,80)+txt(c.tpLogr,20)+txt(c.logradouro,40)+num(c.numero||'0',6)+txt(c.compl,20)+txt(c.bairro,30)+txt(c.cidade,30)+txt(c.uf,2)+num(c.cep,8)+txt(c.responsavel,59));
  add('11'+cnpj+c.codLocal+sp(9)+cnpj+txt(c.fantasiaCurta||c.razao,281));
  add('20'+cnpj+c.codBenef+txt(c.nomeBenef,313));
  itens.forEach(function(i){var n=txt(i.nome,40),nasc=/^\d{4}-\d{2}-\d{2}$/.test(i.nasc||'')?i.nasc.split('-').reverse().join(''):String(i.nasc||'').replace(/\D/g,'');
    if(nasc.length!=8)throw new Error('Data de nascimento inválida: '+i.nome);
    add('30'+cnpj+num(i.cpf,11)+c.codLocal+sp(9)+c.codBenef+sp(10)+n.trim().padEnd(40)+txt(n,24)+nasc+(i.sexo=='M'||i.sexo=='F'?i.sexo:' ')+c.cargaFim)});
  var d=String(dtCredito||'');if(/^\d{4}-\d{2}-\d{2}$/.test(d))d=d.split('-').reverse().join('');if(d.length!=8)throw new Error('Data de crédito inválida.');
  add('50'+cnpj+c.produto+d);
  itens.forEach(function(i){add('60'+cnpj+c.produto+num(i.cpf,11)+sp(40)+num(Math.round(i.valor*100),11))});
  add('99'+cnpj);
  return L.join('\r\n')+'\r\n'}
/* lê um arquivo no mesmo layout (para conferência e para importar o modelo) */
function ler(t){var L=t.split(/\r?\n/).filter(Boolean),f=function(l,a,b){return l.slice(a-1,b)},o={cfg:{},itens:[],dtCredito:''};
  L.forEach(function(l){var t2=l.slice(0,2);
    if(t2=='00'){o.cfg.versao=f(l,3,5);o.cfg.cnpj=f(l,6,19);o.cfg.razao=f(l,20,341).trim()}
    if(t2=='10'){o.cfg.codLocal=f(l,17,37);o.cfg.fantasia=f(l,47,126).trim();o.cfg.tpLogr=f(l,127,146).trim();o.cfg.logradouro=f(l,147,186).trim();o.cfg.numero=f(l,187,192);o.cfg.compl=f(l,193,212).trim();o.cfg.bairro=f(l,213,242).trim();o.cfg.cidade=f(l,243,272).trim();o.cfg.uf=f(l,273,274);o.cfg.cep=f(l,275,282);o.cfg.responsavel=f(l,283,341).trim()}
    if(t2=='11')o.cfg.fantasiaCurta=f(l,61,341).trim();
    if(t2=='20'){o.cfg.codBenef=f(l,17,28);o.cfg.nomeBenef=f(l,29,341).trim()}
    if(t2=='30')o.itens.push({cpf:f(l,17,27),nome:f(l,80,119).trim(),nasc:f(l,144,151),sexo:f(l,152,152).trim(),valor:0});
    if(t2=='50'){o.cfg.produto=f(l,17,19);o.dtCredito=f(l,20,27)}
    if(t2=='60'){var i=o.itens.find(function(x){return x.cpf==f(l,20,30)});if(i)i.valor=parseInt(f(l,71,81),10)/100}});
  return o}
return {gerar:gerar,ler:ler,limpa:limpa,DEF:DEF}})();
if(typeof module!='undefined')module.exports=VRL;
