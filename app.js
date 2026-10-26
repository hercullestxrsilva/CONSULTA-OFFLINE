'use strict';
/* Consulta de Preços — app offline (PWA).
   Dados: arquivo produtos.json gerado no computador a partir do backup do Shop 9.
   Produto = [codigo, nome, unidade, [precos em centavos por tabela], "barras1 barras2", estoque, flags] */

const VERSAO_APP = '1.1.0';
const LIMITE_LISTA = 100;

const $ = (s) => document.querySelector(s);
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const fmt = (centavos) => brl.format((centavos || 0) / 100);
const fmtQtd = (q) => Number(q).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normalizar = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const arred3 = (n) => Math.round(n * 1000) / 1000;

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dataBR(iso, comHora) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const s = d.toLocaleDateString('pt-BR');
  return comHora ? `${s} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : s;
}
function lerNumero(txt) {
  let s = String(txt ?? '').trim().replace(/\s|R\$/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* ---------------------------------------------------------------- armazenamento */
const idb = {
  _db: null,
  abrir() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((ok, erro) => {
      const r = indexedDB.open('consulta-precos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this._db = r.result; ok(this._db); };
      r.onerror = () => erro(r.error);
    });
  },
  async get(chave) {
    const db = await this.abrir();
    return new Promise((ok, erro) => {
      const r = db.transaction('kv').objectStore('kv').get(chave);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => erro(r.error);
    });
  },
  async set(chave, valor) {
    const db = await this.abrir();
    return new Promise((ok, erro) => {
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(valor, chave);
      t.oncomplete = () => ok();
      t.onerror = () => erro(t.error);
    });
  },
};
const local = {
  get(chave, padrao) {
    try { const v = localStorage.getItem(chave); return v ? JSON.parse(v) : padrao; } catch { return padrao; }
  },
  set(chave, valor) {
    try { localStorage.setItem(chave, JSON.stringify(valor)); } catch (e) { toast('Não foi possível salvar no celular: ' + e.message); }
  },
};

/* ---------------------------------------------------------------- estado */
let dados = null;
const indice = { norm: [], codigos: new Map(), promos: new Map() };
let soma = local.get('soma', []);
let vendas = local.get('vendas', []);
const config = Object.assign({ tabela: 0, somarDireto: false }, local.get('config', {}));
let listaAtual = [];
let mostrando = 0;

/* ---------------------------------------------------------------- dados */
async function carregarTexto(texto, salvar) {
  const d = JSON.parse(texto);
  if (!d || d.formato !== 'consulta-precos-shop9' || !Array.isArray(d.produtos)) {
    throw new Error('este arquivo não é o produtos.json gerado pelo ATUALIZAR DADOS');
  }
  dados = d;
  indexar();
  if (config.tabela >= dados.tabelas.length) config.tabela = 0;
  if (salvar) await idb.set('dados', texto);
  atualizarCabecalho();
  preencherTabelas();
  renderResultados();
  renderSoma();
}

function indexar() {
  const P = dados.produtos;
  const norm = new Array(P.length);
  const codigos = new Map();
  const add = (c, i) => {
    if (!c) return;
    const k = c.toUpperCase();
    const l = codigos.get(k);
    if (!l) codigos.set(k, [i]);
    else if (!l.includes(i)) l.push(i);
  };
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    norm[i] = normalizar(p[1]) + ' \u0001' + String(p[0]).toUpperCase() + ' ' + (p[4] || '');
    add(p[0], i);
    if (p[4]) for (const b of p[4].split(' ')) add(b, i);
  }
  const promos = new Map();
  for (const [cod, tab, preco, ini, fim] of dados.promocoes || []) promos.set(cod + '|' + tab, { preco, ini, fim });
  indice.norm = norm;
  indice.codigos = codigos;
  indice.promos = promos;
}

function precoDe(i, tab = config.tabela) {
  const p = dados.produtos[i];
  const promo = indice.promos.get(p[0] + '|' + tab);
  const hoje = hojeISO();
  if (promo && promo.ini <= hoje && hoje <= promo.fim) return { valor: promo.preco, promo };
  return { valor: p[3][tab] || 0, promo: null };
}

function acharPorCodigo(texto) {
  const k = String(texto).trim().toUpperCase();
  if (!dados || !k || /\s/.test(k)) return [];
  const tentativas = [k];
  if (/^\d+$/.test(k)) tentativas.push(k.replace(/^0+/, ''), '0' + k);
  const r = [];
  for (const t of tentativas) for (const i of indice.codigos.get(t) || []) if (!r.includes(i)) r.push(i);
  return r;
}

// q = barra principal (nome, código ou cód. de barras); filtros = textos das barras extras.
// O produto precisa conter todas as palavras de todas as barras.
function procurar(q, filtros = []) {
  const termosFiltro = normalizar(filtros.join(' ')).split(/\s+/).filter(Boolean);
  const termos = normalizar(q).split(/\s+/).filter(Boolean).concat(termosFiltro);
  if (!termos.length) return [];
  const exatos = acharPorCodigo(q).filter((i) => termosFiltro.every((t) => indice.norm[i].includes(t)));
  const ja = new Set(exatos);
  const comeca = [];
  const resto = [];
  const norm = indice.norm;
  const t0 = termos[0];
  for (let i = 0; i < norm.length; i++) {
    const s = norm[i];
    let ok = true;
    for (const t of termos) if (s.indexOf(t) === -1) { ok = false; break; }
    if (!ok || ja.has(i)) continue;
    (s.startsWith(t0) ? comeca : resto).push(i);
  }
  return exatos.concat(comeca, resto);
}

/* ---------------------------------------------------------------- consulta */
function htmlPreco(i) {
  const { valor, promo } = precoDe(i);
  const p = dados.produtos[i];
  let outros = '';
  dados.tabelas.forEach((nome, t) => {
    if (t !== config.tabela && p[3][t] > 0) outros += `<small>${esc(nome)} ${fmt(p[3][t])}</small>`;
  });
  if (!valor) return `<div class="preco"><span class="sem-preco">sem preço</span>${outros}</div>`;
  return `<div class="preco">${promo ? '<span class="promo">PROMOÇÃO</span>' : ''}${fmt(valor)}${outros}</div>`;
}

function htmlItem(i) {
  const p = dados.produtos[i];
  const meta = [`Cód ${esc(p[0])}`];
  if (p[2]) meta.push(esc(p[2]));
  if (p[5] !== null && p[5] !== undefined) meta.push(`Estoque ${fmtQtd(p[5])}`);
  if (p[4]) meta.push(esc(p[4].split(' ')[0]));
  if (p[6] & 1) meta.push('<span class="bloq">BLOQUEADO P/ VENDA</span>');
  return `<li class="item" data-i="${i}">
    <div class="info"><div class="nome">${esc(p[1])}</div><div class="meta">${meta.join(' · ')}</div></div>
    ${htmlPreco(i)}
    <button class="add" data-add="${i}" aria-label="Somar ${esc(p[1])}">+</button>
  </li>`;
}

function renderResultados() {
  const q = $('#q').value.trim();
  const filtros = [$('#q2').value.trim(), $('#q3').value.trim()];
  const temBusca = !!(q || filtros[0] || filtros[1]);
  const ul = $('#resultados');
  $('#semDados').hidden = !!dados;
  $('#dicaBusca').hidden = !dados || temBusca;
  if (!dados || !temBusca) {
    ul.innerHTML = '';
    $('#resumoBusca').textContent = '';
    listaAtual = [];
    return;
  }
  listaAtual = procurar(q, filtros);
  mostrando = 0;
  ul.innerHTML = '';
  $('#resumoBusca').textContent = listaAtual.length
    ? `${listaAtual.length.toLocaleString('pt-BR')} produto${listaAtual.length > 1 ? 's' : ''}`
    : 'Nenhum produto encontrado.';
  mostrarMais();
}

function mostrarMais() {
  const ul = $('#resultados');
  ul.querySelector('.mais-resultados')?.remove();
  const fim = Math.min(listaAtual.length, mostrando + LIMITE_LISTA);
  let html = '';
  for (let k = mostrando; k < fim; k++) html += htmlItem(listaAtual[k]);
  mostrando = fim;
  if (mostrando < listaAtual.length) {
    html += `<li class="mais-resultados">Mostrando ${mostrando} de ${listaAtual.length.toLocaleString('pt-BR')}.
      Digite mais palavras para filtrar ou <button data-mais>mostrar mais</button></li>`;
  }
  ul.insertAdjacentHTML('beforeend', html);
}

function abrirProduto(i) {
  const p = dados.produtos[i];
  $('#detNome').textContent = p[1];
  let precos = '';
  dados.tabelas.forEach((nome, t) => {
    const { valor, promo } = precoDe(i, t);
    if (t !== config.tabela && !valor) return;
    const tag = promo ? `<span class="tag-promo">PROMOÇÃO até ${dataBR(promo.fim + 'T12:00')}</span>` : '';
    precos += `<div class="p ${t === config.tabela ? 'principal' : ''}"><span>${esc(nome)}${tag}</span><b>${valor ? fmt(valor) : 'sem preço'}</b></div>`;
  });
  $('#detPrecos').innerHTML = precos;
  let info = `<dt>Código</dt><dd>${esc(p[0])}</dd>`;
  if (p[4]) info += `<dt>Cód. barras</dt><dd>${esc(p[4].split(' ').join(', '))}</dd>`;
  if (p[2]) info += `<dt>Unidade</dt><dd>${esc(p[2])}</dd>`;
  if (p[5] !== null && p[5] !== undefined) info += `<dt>Estoque</dt><dd>${fmtQtd(p[5])} (no dia do backup)</dd>`;
  if (p[6] & 1) info += `<dt>Situação</dt><dd style="color:var(--perigo)">Bloqueado para venda no Shop 9</dd>`;
  $('#detInfo').innerHTML = info;
  $('#detQtd').value = '1';
  const dlg = $('#dlgProduto');
  dlg.dataset.i = i;
  dlg.returnValue = '';
  dlg.showModal();
}

/* ---------------------------------------------------------------- soma */
function salvarSoma() { local.set('soma', soma); }
const subtotal = (it) => Math.round(it.preco * it.qtd);
const totalSoma = () => soma.reduce((s, it) => s + subtotal(it), 0);

function somar(i, qtd = 1, silencioso = false) {
  const p = dados.produtos[i];
  const { valor } = precoDe(i);
  const ex = soma.find((it) => !it.avulso && it.cod === p[0] && it.preco === valor);
  if (ex) ex.qtd = arred3(ex.qtd + qtd);
  else soma.push({ cod: p[0], nome: p[1], un: p[2], preco: valor, qtd });
  salvarSoma();
  renderSoma();
  if (!silencioso) toast(`${valor ? '' : 'SEM PREÇO! '}+${fmtQtd(qtd)} ${esc(p[1])}<br><b>Total ${fmt(totalSoma())}</b>`);
}

function renderSoma() {
  const ul = $('#itensSoma');
  ul.innerHTML = soma.map((it, k) => `<li class="item item-soma" data-k="${k}">
      <div class="info">
        <div class="nome">${esc(it.nome)}</div>
        <div class="meta">${it.cod ? 'Cód ' + esc(it.cod) : 'Valor avulso'}${it.un ? ' · ' + esc(it.un) : ''}</div>
      </div>
      <button class="remover" data-remover="${k}" aria-label="Remover item">✕</button>
      <div class="linha2">
        <div class="stepper">
          <button data-menos="${k}" aria-label="Diminuir">−</button>
          <button class="qtd" data-qtd="${k}" aria-label="Alterar quantidade">${fmtQtd(it.qtd)}</button>
          <button data-mais1="${k}" aria-label="Aumentar">+</button>
        </div>
        <button class="unit" data-preco="${k}">${it.preco ? fmt(it.preco) : 'digitar preço'} un.</button>
        <span class="sub">${fmt(subtotal(it))}</span>
      </div>
    </li>`).join('');
  const n = soma.reduce((s, it) => s + it.qtd, 0);
  $('#somaVazia').hidden = soma.length > 0;
  $('#qtdItens').textContent = `${fmtQtd(n)} ${n === 1 ? 'item' : 'itens'}`;
  $('#totalSoma').textContent = fmt(totalSoma());
  const badge = $('#badgeSoma');
  badge.hidden = !soma.length;
  badge.textContent = soma.length;
  atualizarTroco();
}

function atualizarTroco() {
  const rec = lerNumero($('#recebido').value);
  const el = $('#troco');
  if (rec === null) { el.textContent = ''; return; }
  const dif = Math.round(rec * 100) - totalSoma();
  el.textContent = dif >= 0 ? `Troco ${fmt(dif)}` : `Falta ${fmt(-dif)}`;
  el.style.color = dif >= 0 ? 'var(--preco)' : 'var(--perigo)';
}

async function editarQtd(k) {
  const it = soma[k];
  const r = await perguntar({ titulo: it.nome, rotulo: 'Quantidade', valor: fmtQtd(it.qtd) });
  if (!r) return;
  const n = lerNumero(r.valor);
  if (n === null || n < 0) return toast('Quantidade inválida');
  if (n === 0) soma.splice(k, 1); else it.qtd = arred3(n);
  salvarSoma();
  renderSoma();
}

async function editarPreco(k) {
  const it = soma[k];
  const r = await perguntar({ titulo: it.nome, rotulo: 'Preço unitário (R$)', valor: it.preco ? (it.preco / 100).toFixed(2).replace('.', ',') : '' });
  if (!r) return;
  const n = lerNumero(r.valor);
  if (n === null || n < 0) return toast('Preço inválido');
  it.preco = Math.round(n * 100);
  salvarSoma();
  renderSoma();
}

async function adicionarAvulso() {
  const r = await perguntar({ titulo: 'Valor avulso', rotulo: 'Valor (R$)', comTexto: true });
  if (!r) return;
  const n = lerNumero(r.valor);
  if (!n || n < 0) return toast('Valor inválido');
  soma.push({ cod: '', nome: r.texto.trim() || 'Avulso', un: '', preco: Math.round(n * 100), qtd: 1, avulso: true });
  salvarSoma();
  renderSoma();
}

function finalizarVenda() {
  if (!soma.length) return toast('A soma está vazia.');
  const rec = lerNumero($('#recebido').value);
  const venda = { id: Date.now(), data: new Date().toISOString(), itens: soma, total: totalSoma() };
  if (rec !== null) venda.recebido = Math.round(rec * 100);
  vendas.push(venda);
  local.set('vendas', vendas);
  soma = [];
  salvarSoma();
  $('#recebido').value = '';
  renderSoma();
  renderVendas();
  toast(`Venda anotada: <b>${fmt(venda.total)}</b><br>Veja na aba Vendas.`);
}

/* ---------------------------------------------------------------- vendas */
function textoVenda(v) {
  const linhas = [`Venda ${dataBR(v.data, true)}`];
  for (const it of v.itens) {
    linhas.push(`${fmtQtd(it.qtd)} x ${it.nome}${it.cod ? ' (cód ' + it.cod + ')' : ''} ${fmt(it.preco)} = ${fmt(subtotal(it))}`);
  }
  linhas.push(`TOTAL ${fmt(v.total)}`);
  if (v.recebido !== undefined) linhas.push(`Recebido ${fmt(v.recebido)} · Troco ${fmt(v.recebido - v.total)}`);
  return linhas.join('\n');
}

function renderVendas() {
  const cont = $('#listaVendas');
  $('#vendasVazia').hidden = vendas.length > 0;
  $('#btnCompartilharVendas').disabled = !vendas.length;
  $('#btnApagarVendas').disabled = !vendas.length;
  const porDia = new Map();
  for (const v of [...vendas].reverse()) {
    const dia = dataBR(v.data);
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(v);
  }
  let html = '';
  for (const [dia, lista] of porDia) {
    const tot = lista.reduce((s, v) => s + v.total, 0);
    html += `<div class="dia"><span>${dia} · ${lista.length} venda${lista.length > 1 ? 's' : ''}</span><span>${fmt(tot)}</span></div>`;
    for (const v of lista) {
      const hora = new Date(v.data).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const n = v.itens.reduce((s, it) => s + it.qtd, 0);
      html += `<details class="venda"><summary><span>${hora} · ${fmtQtd(n)} ${n === 1 ? 'item' : 'itens'}</span><b>${fmt(v.total)}</b></summary>
        <div class="corpo">
          ${v.itens.map((it) => `<div><span>${fmtQtd(it.qtd)} x ${esc(it.nome)}</span><span>${fmt(subtotal(it))}</span></div>`).join('')}
          ${v.recebido !== undefined ? `<div><span>Recebido ${fmt(v.recebido)}</span><span>Troco ${fmt(v.recebido - v.total)}</span></div>` : ''}
          <div class="acoes"><button data-compartilhar-venda="${v.id}">Compartilhar</button><button class="perigo" data-apagar-venda="${v.id}">Excluir</button></div>
        </div></details>`;
    }
  }
  cont.innerHTML = html;
}

async function compartilhar(texto, titulo) {
  if (navigator.share) {
    try { await navigator.share({ title: titulo, text: texto }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(texto);
    toast('Texto copiado. Cole no WhatsApp ou em outro app.');
  } catch {
    alert(texto);
  }
}

/* ---------------------------------------------------------------- diálogos e avisos */
let toastTimer;
function toast(html, ms = 2600) {
  const el = $('#toast');
  el.innerHTML = html;
  el.classList.add('visivel');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visivel'), ms);
}

function perguntar({ titulo, rotulo, valor = '', comTexto = false }) {
  return new Promise((ok) => {
    const dlg = $('#dlgPergunta');
    $('#pergTitulo').textContent = titulo;
    $('#pergLabel').textContent = rotulo;
    $('#pergValor').value = valor;
    $('#pergTexto').value = '';
    $('#pergLabelTexto').hidden = !comTexto;
    dlg.returnValue = '';
    dlg.onclose = () => ok(dlg.returnValue === 'ok' ? { valor: $('#pergValor').value, texto: $('#pergTexto').value } : null);
    dlg.showModal();
    const campo = comTexto ? $('#pergTexto') : $('#pergValor');
    setTimeout(() => { campo.focus(); campo.select(); }, 60);
  });
}

function atualizarCabecalho() {
  if (!dados) return;
  $('#nomeLoja').textContent = dados.loja || 'Consulta de Preços';
  const dias = Math.floor((Date.now() - new Date(dados.dataBackup)) / 864e5);
  const idade = dias <= 0 ? 'hoje' : dias === 1 ? 'há 1 dia' : `há ${dias} dias`;
  $('#infoDados').textContent = `Preços do backup de ${dataBR(dados.dataBackup)} (${idade})`;
  $('#menuDados').innerHTML = `<b>${esc(dados.loja)}</b><br>Backup: ${esc(dados.backup)} de ${dataBR(dados.dataBackup, true)}<br>
    ${dados.produtos.length.toLocaleString('pt-BR')} produtos · tabelas: ${dados.tabelas.map(esc).join(', ')}<br>
    Importado do arquivo gerado em ${dataBR(dados.geradoEm, true)}`;
}

function preencherTabelas() {
  const sel = $('#selTabela');
  sel.innerHTML = (dados ? dados.tabelas : []).map((n, t) => `<option value="${t}">${esc(n)}</option>`).join('');
  sel.value = String(config.tabela);
}

function irPara(tela) {
  document.querySelectorAll('.tela').forEach((s) => s.classList.toggle('ativa', s.id === tela));
  document.querySelectorAll('.abas button').forEach((b) => b.classList.toggle('ativa', b.dataset.tela === tela));
  window.scrollTo(0, 0);
}

/* ---------------------------------------------------------------- importar / atualizar dados */
async function importarArquivo(arquivo) {
  try {
    toast('Lendo arquivo...', 10000);
    const texto = await arquivo.text();
    await carregarTexto(texto, true);
    $('#dlgMenu').close();
    toast(`Dados importados: <b>${dados.produtos.length.toLocaleString('pt-BR')} produtos</b><br>backup de ${dataBR(dados.dataBackup)}`, 4000);
  } catch (e) {
    toast('');
    alert('Não foi possível importar: ' + e.message);
  }
}

async function verificarDadosOnline(manual) {
  if (!navigator.onLine && !manual) return;
  try {
    const r = await fetch('produtos.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('arquivo não encontrado no servidor');
    const texto = await r.text();
    const d = JSON.parse(texto);
    if (d.formato !== 'consulta-precos-shop9') throw new Error('formato inválido');
    $('#btnDadosOnline').hidden = false;
    if (!dados || d.geradoEm > dados.geradoEm) {
      await carregarTexto(texto, true);
      toast(`Dados atualizados: backup de ${dataBR(dados.dataBackup)}`, 4000);
    } else if (manual) {
      toast('Os dados já estão atualizados.');
    }
  } catch (e) {
    if (manual) alert('Não foi possível baixar os dados: ' + e.message);
  }
}

/* ---------------------------------------------------------------- leitor de código de barras */
const scan = { stream: null, track: null, detectar: null, ativo: false, timer: 0, ultimo: '', vistoEm: 0, lanterna: false, canvas: null, ctx: null };
let audioCtx = null;
const scriptsCarregados = {};

function carregarScript(src) {
  if (!scriptsCarregados[src]) {
    scriptsCarregados[src] = new Promise((ok, erro) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = () => erro(new Error('não foi possível carregar ' + src));
      document.head.appendChild(s);
    });
  }
  return scriptsCarregados[src];
}

function iniciarAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* sem som */ }
}
function bip(freq = 1800, dur = 0.08) {
  if (!audioCtx) return;
  try {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.value = 0.06;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch { /* sem som */ }
}

async function criarDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const suportados = await window.BarcodeDetector.getSupportedFormats();
      if (suportados.includes('ean_13')) {
        const formatos = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'].filter((f) => suportados.includes(f));
        const det = new window.BarcodeDetector({ formats: formatos });
        return async (canvas) => (await det.detect(canvas)).map((b) => b.rawValue);
      }
    } catch { /* usa o leitor embutido */ }
  }
  await carregarScript('vendor/zxing-reader.js');
  const wasm = new URL('vendor/zxing_reader.wasm', document.baseURI).href;
  await window.ZXingWASM.prepareZXingModule({
    overrides: { locateFile: (caminho, prefixo) => (caminho.endsWith('.wasm') ? wasm : prefixo + caminho) },
    fireImmediately: true,
  });
  const opcoes = { formats: ['EANUPC', 'Code128', 'Code39', 'ITF', 'Codabar'], tryHarder: true, maxNumberOfSymbols: 1 };
  return async (canvas, ctx) => {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const r = await window.ZXingWASM.readBarcodes(img, opcoes);
    return r.filter((x) => x.isValid !== false && x.text).map((x) => x.text);
  };
}

function scanMsg(html) { $('#scanMsg').innerHTML = html; }
function atualizarScanTotal() {
  const el = $('#scanTotal');
  el.hidden = !$('#somarDireto').checked;
  el.textContent = `Soma: ${fmt(totalSoma())} (${soma.length} ${soma.length === 1 ? 'produto' : 'produtos'})`;
}

async function abrirScanner() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Este navegador não deixa usar a câmera aqui. Abra o app instalado (endereço https).');
    return;
  }
  iniciarAudio();
  $('#scanner').hidden = false;
  $('#somarDireto').checked = !!config.somarDireto;
  atualizarScanTotal();
  scanMsg('Abrindo a câmera...');
  try {
    scan.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (e) {
    scanMsg(e.name === 'NotAllowedError'
      ? 'Permissão da câmera negada. Libere a câmera para este app nas configurações do celular.'
      : 'Não foi possível abrir a câmera: ' + esc(e.message));
    return;
  }
  if ($('#scanner').hidden) { pararCamera(); return; }
  const video = $('#video');
  video.srcObject = scan.stream;
  try { await video.play(); } catch { /* autoplay */ }
  scan.track = scan.stream.getVideoTracks()[0];
  const caps = scan.track.getCapabilities ? scan.track.getCapabilities() : {};
  $('#btnLanterna').hidden = !caps.torch;
  if (caps.focusMode && caps.focusMode.includes('continuous')) {
    scan.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }
  try {
    scan.detectar = scan.detectar || await criarDetector();
  } catch (e) {
    scanMsg('Leitor de código indisponível: ' + esc(e.message));
    return;
  }
  if (!scan.canvas) {
    scan.canvas = document.createElement('canvas');
    scan.ctx = scan.canvas.getContext('2d', { willReadFrequently: true });
  }
  scanMsg('Aponte para o código de barras');
  scan.ativo = true;
  scan.ultimo = '';
  laco();
}

function recorte(video) {
  // faixa horizontal do vídeo na altura da mira (com folga), na largura inteira do quadro:
  // com object-fit: cover as laterais do vídeo ficam fora da tela, mas o código pode estar lá
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const esc2 = Math.max(video.clientWidth / vw, video.clientHeight / vh);
  const oy = (video.clientHeight - vh * esc2) / 2;
  const m = $('.mira').getBoundingClientRect();
  const folgaY = m.height * 0.35;
  const y = Math.max(0, (m.top - folgaY - oy) / esc2);
  const h = Math.min(vh - y, (m.height + 2 * folgaY) / esc2);
  return { x: 0, y, w: vw, h };
}

async function laco() {
  if (!scan.ativo) return;
  const video = $('#video');
  try {
    if (video.readyState >= 2 && video.videoWidth) {
      const r = recorte(video);
      const fator = Math.min(1, 1000 / r.w);
      scan.canvas.width = Math.max(1, Math.round(r.w * fator));
      scan.canvas.height = Math.max(1, Math.round(r.h * fator));
      scan.ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, scan.canvas.width, scan.canvas.height);
      const codigos = await scan.detectar(scan.canvas, scan.ctx);
      if (scan.ativo) {
        if (codigos.length) lido(String(codigos[0]).trim());
        else if (Date.now() - scan.vistoEm > 1000) scan.ultimo = '';
      }
    }
  } catch (e) {
    console.warn('leitura', e);
  }
  if (scan.ativo) scan.timer = setTimeout(laco, 90);
}

function lido(codigo) {
  const agora = Date.now();
  if (codigo === scan.ultimo) { scan.vistoEm = agora; return; }
  scan.ultimo = codigo;
  scan.vistoEm = agora;
  const mira = $('.mira');
  mira.classList.add('ok');
  setTimeout(() => mira.classList.remove('ok'), 400);
  const achados = acharPorCodigo(codigo);
  if (navigator.vibrate) navigator.vibrate(achados.length ? 60 : [60, 80, 60]);
  if (achados.length) bip(); else { bip(400, 0.25); }

  if ($('#somarDireto').checked) {
    if (achados.length === 1) {
      const i = achados[0];
      somar(i, 1, true);
      const { valor } = precoDe(i);
      scanMsg(`+1 ${esc(dados.produtos[i][1])}<br>${valor ? fmt(valor) : 'SEM PREÇO'}`);
      atualizarScanTotal();
    } else if (!achados.length) {
      scanMsg(`Código <b>${esc(codigo)}</b> não encontrado`);
    } else {
      fecharScanner();
      mostrarBusca(codigo);
      toast(`${achados.length} produtos com o código ${esc(codigo)}. Escolha na lista.`);
    }
    return;
  }
  fecharScanner();
  mostrarBusca(codigo);
  if (achados.length === 1) abrirProduto(achados[0]);
  else if (!achados.length) toast(`Código ${esc(codigo)} não encontrado nos dados.`, 3500);
}

function mostrarBusca(texto) {
  $('#q').value = texto;
  $('#q2').value = '';
  $('#q3').value = '';
  irPara('telaConsulta');
  renderResultados();
}

function pararCamera() {
  scan.ativo = false;
  clearTimeout(scan.timer);
  if (scan.stream) scan.stream.getTracks().forEach((t) => t.stop());
  scan.stream = null;
  scan.track = null;
  scan.lanterna = false;
  $('#btnLanterna').classList.remove('ligada');
  $('#video').srcObject = null;
}

function fecharScanner() {
  $('#scanner').hidden = true;
  pararCamera();
}

/* ---------------------------------------------------------------- service worker */
function registrarSW() {
  if (!('serviceWorker' in navigator)) return;
  const tinhaControle = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const avisar = (sw) => {
      $('#avisoAtualizacao').hidden = false;
      $('#btnAtualizarApp').onclick = () => sw.postMessage('atualizar');
    };
    if (reg.waiting && tinhaControle) avisar(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) avisar(sw);
      });
    });
  }).catch((e) => console.warn('service worker', e));
  let recarregou = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!tinhaControle || recarregou) return;
    recarregou = true;
    location.reload();
  });
}

/* ---------------------------------------------------------------- eventos */
function ligarEventos() {
  let espera;
  document.querySelectorAll('.campo-busca').forEach((campo) => {
    campo.addEventListener('input', () => {
      clearTimeout(espera);
      espera = setTimeout(renderResultados, 140);
    });
    campo.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      clearTimeout(espera);
      renderResultados();
      if (campo.id === 'q' && listaAtual.length === 1 && acharPorCodigo(campo.value).length === 1) abrirProduto(listaAtual[0]);
      campo.blur();
    });
  });
  $('#resultados').addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) { somar(Number(add.dataset.add), 1); return; }
    if (e.target.closest('[data-mais]')) { mostrarMais(); return; }
    const li = e.target.closest('.item');
    if (li) abrirProduto(Number(li.dataset.i));
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-acao="importar"]')) $('#arquivo').click();
  });
  $('#arquivo').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importarArquivo(f);
  });
  $('#btnCamera').addEventListener('click', abrirScanner);
  $('#btnFecharScanner').addEventListener('click', fecharScanner);
  $('#btnLanterna').addEventListener('click', async () => {
    if (!scan.track) return;
    scan.lanterna = !scan.lanterna;
    try { await scan.track.applyConstraints({ advanced: [{ torch: scan.lanterna }] }); } catch { scan.lanterna = false; }
    $('#btnLanterna').classList.toggle('ligada', scan.lanterna);
  });
  $('#somarDireto').addEventListener('change', (e) => {
    config.somarDireto = e.target.checked;
    local.set('config', config);
    atualizarScanTotal();
    scanMsg(e.target.checked ? 'Cada código lido entra na soma' : 'Aponte para o código de barras');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !$('#scanner').hidden) fecharScanner();
  });

  document.querySelectorAll('.abas button').forEach((b) => b.addEventListener('click', () => irPara(b.dataset.tela)));
  $('#btnMenu').addEventListener('click', () => {
    $('#versaoApp').textContent = `Versão do app ${VERSAO_APP}`;
    $('#dicaInstalar').hidden = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    $('#dlgMenu').showModal();
  });
  $('#btnDadosOnline').addEventListener('click', () => verificarDadosOnline(true));
  $('#selTabela').addEventListener('change', (e) => {
    config.tabela = Number(e.target.value);
    local.set('config', config);
    renderResultados();
  });

  // detalhe do produto
  const dlgP = $('#dlgProduto');
  dlgP.querySelector('[value="fechar"]').addEventListener('click', (e) => { e.preventDefault(); dlgP.close('fechar'); });
  dlgP.querySelectorAll('[data-passo]').forEach((b) => b.addEventListener('click', () => {
    const atual = lerNumero($('#detQtd').value) || 0;
    $('#detQtd').value = fmtQtd(Math.max(1, arred3(atual + Number(b.dataset.passo))));
  }));
  dlgP.addEventListener('close', () => {
    if (dlgP.returnValue !== 'somar') return;
    const q = lerNumero($('#detQtd').value);
    if (!q || q <= 0) return toast('Quantidade inválida');
    somar(Number(dlgP.dataset.i), arred3(q));
  });
  // fechar diálogos tocando fora
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close('fora'); }));
  const dlgPerg = $('#dlgPergunta');
  dlgPerg.querySelector('[value="cancelar"]').addEventListener('click', (e) => { e.preventDefault(); dlgPerg.close('cancelar'); });

  // soma
  $('#itensSoma').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.remover !== undefined) { soma.splice(Number(d.remover), 1); salvarSoma(); renderSoma(); }
    else if (d.menos !== undefined) {
      const it = soma[Number(d.menos)];
      it.qtd = arred3(it.qtd - 1);
      if (it.qtd <= 0) soma.splice(Number(d.menos), 1);
      salvarSoma(); renderSoma();
    } else if (d.mais1 !== undefined) {
      const it = soma[Number(d.mais1)];
      it.qtd = arred3(it.qtd + 1);
      salvarSoma(); renderSoma();
    } else if (d.qtd !== undefined) editarQtd(Number(d.qtd));
    else if (d.preco !== undefined) editarPreco(Number(d.preco));
  });
  $('#recebido').addEventListener('input', atualizarTroco);
  $('#btnAvulso').addEventListener('click', adicionarAvulso);
  $('#btnLimpar').addEventListener('click', () => {
    if (!soma.length || !confirm('Limpar todos os itens da soma?')) return;
    soma = [];
    salvarSoma();
    $('#recebido').value = '';
    renderSoma();
  });
  $('#btnFinalizar').addEventListener('click', finalizarVenda);

  // vendas
  $('#listaVendas').addEventListener('click', (e) => {
    const c = e.target.closest('[data-compartilhar-venda]');
    const a = e.target.closest('[data-apagar-venda]');
    if (c) {
      const v = vendas.find((x) => String(x.id) === c.dataset.compartilharVenda);
      if (v) compartilhar(textoVenda(v), 'Venda');
    } else if (a) {
      if (!confirm('Excluir esta venda anotada?')) return;
      vendas = vendas.filter((x) => String(x.id) !== a.dataset.apagarVenda);
      local.set('vendas', vendas);
      renderVendas();
    }
  });
  $('#btnCompartilharVendas').addEventListener('click', () => {
    const total = vendas.reduce((s, v) => s + v.total, 0);
    const texto = [`Vendas anotadas${dados ? ' - ' + dados.loja : ''}`, ...vendas.map(textoVenda), `TOTAL GERAL ${fmt(total)} (${vendas.length} vendas)`].join('\n\n');
    compartilhar(texto, 'Vendas anotadas');
  });
  $('#btnApagarVendas').addEventListener('click', () => {
    if (!confirm('Apagar TODAS as vendas anotadas? Faça isso só depois de lançar no Shop 9.')) return;
    vendas = [];
    local.set('vendas', vendas);
    renderVendas();
  });
}

/* ---------------------------------------------------------------- início */
async function iniciar() {
  ligarEventos();
  registrarSW();
  renderSoma();
  renderVendas();
  try {
    const texto = await idb.get('dados');
    if (texto) await carregarTexto(texto, false);
  } catch (e) {
    console.error(e);
    toast('Erro ao abrir os dados salvos: ' + esc(e.message), 5000);
  }
  renderResultados();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  verificarDadosOnline(false);
}

iniciar();
