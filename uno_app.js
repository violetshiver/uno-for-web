'use strict';

// ========= Utilities & SFX =========
const randId = () => Math.random().toString(36).slice(2, 9);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
let _actx = null;
function sfx(type){
  try{
    _actx = _actx || new (window.AudioContext||window.webkitAudioContext)();
    const o = _actx.createOscillator();
    const g = _actx.createGain();
    o.connect(g); g.connect(_actx.destination);
    if (type==='draw') { o.type='triangle'; o.frequency.value=620; g.gain.setValueAtTime(0.12,_actx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001,_actx.currentTime+0.09); o.start(); o.stop(_actx.currentTime+0.1); }
    else if (type==='play') { o.type='square'; o.frequency.value=880; g.gain.setValueAtTime(0.15,_actx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001,_actx.currentTime+0.14); o.start(); o.stop(_actx.currentTime+0.15); }
  }catch(e){}
}
function toast(msg, ms=1600){
  const wrap = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  wrap.appendChild(el);
  while (wrap.children.length>3){ wrap.removeChild(wrap.firstElementChild); }
  requestAnimationFrame(()=> el.classList.add('show'));
  setTimeout(()=>{ el.classList.remove('show'); setTimeout(()=>{ el.parentNode && wrap.removeChild(el); }, 220); }, ms);
}

// ========= Options (house rules) =========
const GAME_OPTIONS = { challengeWild4:true, strictWild4:true, stacking:true, allowCrossStacking:true, sevenSwap:false, zeroPass:false, progressiveDraw:false, forcePlayDrawn:true };

// ========= Card registry =========
const CARD_TYPES = {
  number:{key:'number', matches:({card,topCard,currentColor})=> card.color===currentColor || (topCard&&topCard.kind==='number'&&card.value===topCard.value), onPlay:({game,card})=>{
    if(card.value===7 && GAME_OPTIONS.sevenSwap){
      const i=game.turn; const current=game.players[i];
      const others=game.players.map((p,idx)=>({idx,len:p.hand.length})).filter(o=>o.idx!==i);
      const minLen=Math.min(...others.map(o=>o.len));
      const target=pick(others.filter(o=>o.len===minLen)).idx;
      [game.players[i].hand, game.players[target].hand] = [game.players[target].hand, game.players[i].hand];
      toast(`${current.name} swapped hands with ${game.players[target].name}`);
    }
    if(card.value===0 && GAME_OPTIONS.zeroPass){
      const dir=game.direction; const arr=game.players.map(p=>p.hand);
      if(dir===1){ arr.unshift(arr.pop()); } else { arr.push(arr.shift()); }
      game.players.forEach((p,idx)=> p.hand=arr[idx]);
      toast('Hands rotated');
    }
  }},
  skip:{ key:'skip', label:'Skip', matches:({card,currentColor,topCard})=> card.color===currentColor || (topCard&&topCard.kind==='skip'), onPlay:({game})=>{ game.advance(1); } },
  reverse:{ key:'reverse', label:'Reverse', matches:({card,currentColor,topCard})=> card.color===currentColor || (topCard&&topCard.kind==='reverse'), onPlay:({game})=>{ if(game.players.length===2){ game.advance(1); } else { game.direction*=-1; } } },
  draw2:{ key:'draw2', label:'+2', matches:({card,currentColor,topCard})=> card.color===currentColor || (topCard&&topCard.kind==='draw2'), onPlay:({game})=>{ game.pendingDraw+=2; } },
  wild:{ key:'wild', label:'Wild', matches:()=>true, onPlay:({game})=> game.promptWildColor() },
  wild4:{ key:'wild4', label:'+4', matches:({currentColor,handHasColor})=> !GAME_OPTIONS.strictWild4 || !handHasColor(currentColor), onPlay:({game})=>{
    const i=game.turn;
    const wasLegal=!game.players[i].hand.some(c=> c.color===game.currentColor && c.kind!=='wild' && c.kind!=='wild4');
    if(GAME_OPTIONS.challengeWild4){ game._pendingChallenge={playedBy:i, wasLegal}; game._advanceDeferred=true; }
    game.pendingDraw+=4; game.promptWildColor();
  }},
};
window.registerCardType = (key, def)=>{ CARD_TYPES[key]=Object.assign({key}, def); toast(`Registered card type: ${key}`); };

// ========= Deck materialization =========
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function buildDeckFrom(list){ const deck=[]; for(const entry of list){ const [kind,color,count=1,opts={}] = entry; for(let i=0;i<count;i++){ const type=CARD_TYPES[kind]; if(!type){ console.warn('Unknown kind',kind); continue; } const value=opts.value??null; const label=opts.label??(kind==='number'? String(value) : (type.label||kind.toUpperCase())); deck.push({id:randId(), color, kind, value, label}); } } return shuffle(deck); }

// ========= Config loader =========
let CONFIG=null;
async function loadConfig(){
  if (CONFIG) return CONFIG;
  try{
    const res = await fetch('uno-config.json', {cache:'no-store'});
    if(!res.ok) throw new Error('HTTP '+res.status);
    CONFIG = await res.json();
  }catch(e){
    console.warn('Config fetch failed, falling back to built-in deck.', e);
    CONFIG = { standardDeck: standardDeckFallback(), customDeck: [] };
  }
  return CONFIG;
}
function standardDeckFallback(){
  const colors=['red','yellow','green','blue'];
  const list=[];
  for(const c of colors){
    list.push(['number', c, 1, {value:0}]);
    for(let v=1; v<=9; v++) list.push(['number', c, 2, {value:v}]);
    list.push(['skip', c, 2]); list.push(['reverse', c, 2]); list.push(['draw2', c, 2]);
  }
  list.push(['wild','wild',4]); list.push(['wild4','wild',4]);
  return list;
}

// ========= Game engine =========
class Game{
  constructor({humans=1,bots=1,handSize=7,stacking=true,hotseat=false,deckList}){
    this.players=[]; for(let i=0;i<humans;i++) this.players.push(new Player({name:`Human ${i+1}`, isAI:false})); for(let i=0;i<bots;i++) this.players.push(new Player({name:`AI ${i+1}`, isAI:true})); if(this.players.length<2) this.players.push(new Player({name:'AI', isAI:true}));
    this.direction=1; this.turn=0; this.pendingDraw=0; this.stacking=stacking; this.hotseat=hotseat;
    this.drawPile=buildDeckFrom(deckList); this.discardPile=[];
    for(let p of this.players) this.drawTo(this.players.indexOf(p), handSize);
    // prime top (non-wild)
    let buffer=[], top;
    while(true){ top=this.drawPile.pop(); if(!top) break; if(top.kind==='wild'||top.kind==='wild4'){ buffer.push(top); continue;} break; }
    this.discardPile.push(top);
    if(buffer.length){ this.drawPile.push(...buffer); this.drawPile=shuffle(this.drawPile); }
    this.currentColor=top.color;
    this.updateUI(); setTimeout(()=> this.maybeAIMove(), 350);
  }
  get current(){ return this.players[this.turn]; }
  get topCard(){ return this.discardPile[this.discardPile.length-1]||null; }
  drawTo(playerIndex,n=1){ for(let i=0;i<n;i++){ if(this.drawPile.length===0) this.restock(); if(this.drawPile.length===0) return; this.players[playerIndex].hand.push(this.drawPile.pop()); sfx('draw'); } this.updateUI(); }
  restock(){ if(this.discardPile.length<=1) return; const top=this.discardPile.pop(); this.drawPile=shuffle(this.discardPile); this.discardPile=[top]; toast('Reshuffled the discard into draw pile'); }
  isPlayable(card,playerIndex){ const type=CARD_TYPES[card.kind]; const ctx={game:this, card, topCard:this.topCard, currentColor:this.currentColor, playerIndex, handHasColor:(color)=> this.players[playerIndex].hand.some(c=> c.color===color && c.kind!=='wild' && c.kind!=='wild4')}; if(this.pendingDraw>0 && this.stacking){ const allowed = GAME_OPTIONS.allowCrossStacking ? ['draw2','wild4'] : [this.topCard?.kind]; if(!allowed.includes(card.kind)) return false; } if(card.kind==='number'){ return CARD_TYPES.number.matches({card, topCard:this.topCard, currentColor:this.currentColor}); } const basic=(card.color===this.currentColor) || (this.topCard && this.topCard.kind===card.kind); const extra=type.matches ? type.matches(ctx) : true; return basic || extra; }
  play(cardId){
    this._inPlayContext=true; this._didAdvanceThisPlay=false;
    const player=this.current; const idx=player.hand.findIndex(c=>c.id===cardId); if(idx<0) return;
    const card=player.hand[idx];
    if(!this.isPlayable(card,this.turn)){ toast('That card is not playable.'); return; }
    const willUno = player.hand.length===2;
    player.hand.splice(idx,1);
    this.discardPile.push(card);
    this.pulsePlay(card, player.name);
    if(card.color!=='wild') this.currentColor=card.color;
    const type=CARD_TYPES[card.kind];
    this._advanceDeferred=false; this._pendingPostWild={player, willUno};
    if (type && type.onPlay){ type.onPlay({ game:this, card, topCard:this.topCard, currentColor:this.currentColor, playerIndex:this.turn }); }
    this._inPlayContext=false;

    if (this._advanceDeferred){ return; } // waiting on color / challenge UI
    if (!this._didAdvanceThisPlay){ this.advance(); }

    if (willUno && !player._unoCalled){ const penaltyTo=this.prevIndex(); this.drawTo(penaltyTo,2); toast(`${player.name} forgot to call UNO! +2 penalty.`); }
    player._unoCalled=false;
    this.updateUI();
    this.maybeAIMove();
  }
  advance(extraSteps=0){
    if (this._inPlayContext) this._didAdvanceThisPlay=true;
    const step = 1 + (extraSteps||0); const total=this.players.length;
    this.turn = (this.turn + (this.direction * step) % total + total) % total;
    if (this.pendingDraw>0){
      this.drawTo(this.turn, this.pendingDraw);
      toast(`${this.players[this.turn].name} draws ${this.pendingDraw}`);
      this.pendingDraw = 0;
      this.turn = (this.turn + this.direction + total) % total; // lose turn
    }
    this.updateUI();
    if (this.hotseat && !this.current.isAI){ this.showHotseatCover(); }
  }
  prevIndex(){ const total=this.players.length; return (this.turn - this.direction + total) % total; }
  draw(){
    const player = this.current;
    const doOneAndEnd = !GAME_OPTIONS.progressiveDraw;
    if (doOneAndEnd){ this.drawTo(this.turn,1); this.updateUI(); this.advance(); this.maybeAIMove(); return; }
    if (this._drawLoop) return; // already drawing
    const rateMs = 500; // 2 per second
    const checkAndMaybePlay = ()=>{
      const last = player.hand[player.hand.length-1];
      if (!last) return false;
      const playableNow = this.isPlayable(last, this.turn);
      if (!playableNow) return false;
      if (GAME_OPTIONS.forcePlayDrawn){ setTimeout(()=> this.play(last.id), 1500); }
      clearInterval(this._drawLoop); this._drawLoop=null;
      if (!GAME_OPTIONS.forcePlayDrawn){ this.updateUI(); }
      return true;
    };
    this._drawLoop = setInterval(()=>{
      if (checkAndMaybePlay()) return;
      this.drawTo(this.turn, 1);
      this.updateUI();
      checkAndMaybePlay();
    }, rateMs);
  }
  callUNO(){ const player=this.current; if(player.hand.length===2){ player._unoCalled=true; toast(`${player.name} called UNO!`);} else { toast('UNO only when you have 2 cards.'); } this.updateUI(); }
  promptWildColor(){
    const colors=['red','yellow','green','blue'];
    if (this.current.isAI){
      const c=this.current.bestColor(); this.currentColor=c; this.updateUI();
      if (this._pendingChallenge){ this.handleWild4Challenge(); }
      return;
    }
    this._advanceDeferred=true;
    const modal=document.getElementById('modal'); const sheet=document.getElementById('modalSheet');
    sheet.innerHTML = `<h3>Choose a color</h3><div class="color-grid">${colors.map(c=>`<button class="color-btn ${c}" data-c="${c}">${c.toUpperCase()}</button>`).join('')}</div>`;
    modal.classList.add('show');
    sheet.querySelectorAll('.color-btn').forEach(btn=>{
      btn.onclick = ()=>{
        const chosen=btn.dataset.c; this.currentColor=chosen; modal.classList.remove('show'); this.updateUI();
        if (this._pendingChallenge){ this.handleWild4Challenge(); return; }
        const pending=this._pendingPostWild||{}; const player=pending.player; const willUno=pending.willUno;
        this._advanceDeferred=false; this._pendingPostWild=null; this.advance();
        if (player && willUno && !player._unoCalled){ const penaltyTo=this.prevIndex(); this.drawTo(penaltyTo,2); toast(`${player.name} forgot to call UNO! +2 penalty.`); }
        if (player) player._unoCalled=false; this.updateUI(); this.maybeAIMove();
      };
    });
  }
  handleWild4Challenge(){
    const total=this.players.length; const playedBy=this._pendingChallenge.playedBy; const challenger=(this.turn + this.direction + total) % total; const wasLegal=this._pendingChallenge.wasLegal;
    const finish=(challenged)=>{
      if (challenged){
        if (wasLegal){ this.turn=challenger; this.drawTo(this.turn,6); this.turn=(this.turn + this.direction + total) % total; toast(`${this.players[challenger].name} failed the challenge (+6)`); }
        else { this.drawTo(playedBy,4); this.turn=challenger; toast(`${this.players[challenger].name} won the challenge; ${this.players[playedBy].name} draws 4`); }
      } else {
        this.turn=challenger; this.drawTo(this.turn,4); this.turn=(this.turn + this.direction + total) % total; toast(`${this.players[challenger].name} accepts (+4)`);
      }
      this._pendingChallenge=null; this._advanceDeferred=false; this.pendingDraw=0; this.updateUI(); this.maybeAIMove();
    };
    if (this.players[challenger].isAI){ const shouldChallenge=Math.random()<0.35 || this.players[playedBy].hand.length>7; finish(shouldChallenge); return; }
    const modal=document.getElementById('modal'); const sheet=document.getElementById('modalSheet'); modal.classList.add('show');
    sheet.innerHTML = `<h3>Challenge +4 from ${this.players[playedBy].name}?</h3><p>If you challenge and are right, they draw 4 and you play. If you're wrong, you draw 6 and lose your turn.</p><div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px"><button id="btnAccept" class="btn secondary">Accept (+4)</button><button id="btnChallenge" class="btn">Challenge</button></div>`;
    document.getElementById('btnAccept').onclick = ()=>{ modal.classList.remove('show'); finish(false); };
    document.getElementById('btnChallenge').onclick = ()=>{
      const accused=this.players[playedBy];
      const handHTML=accused.hand.map(c=>`<div class="card small ${c.color}"><div class="color-ring"></div><div class="label">${c.label}</div><div class="tag">${c.kind.toUpperCase()}</div></div>`).join('');
      sheet.innerHTML = `<h3>${accused.name}'s hand (peek)</h3><div class="hand" style="justify-content:center">${handHTML}</div>`;
      setTimeout(()=>{ modal.classList.remove('show'); finish(true); }, 1500);
    };
  }
  pulsePlay(card, by){
    const el=document.getElementById('discardTop'); const pile=el.closest('.discard');
    if (pile){ pile.classList.remove('pulse'); void el.offsetWidth; pile.classList.add('pulse'); }
    el.classList.remove('play-flash'); void el.offsetWidth; el.classList.add('play-flash');
    sfx('play');
    toast(`${by} played ${card.label}${card.color!=='wild' ? ' ('+card.color.toUpperCase()+')' : ''}`);
  }
  maybeAIMove(){
    const p=this.current; if(!p||!p.isAI) return;
    if (p.hand.length===2 && !p._unoCalled){ p._unoCalled=Math.random()<0.9; if(p._unoCalled) toast(`${p.name} called UNO!`); }
    setTimeout(()=>{
      const playable=p.hand.filter(c=>this.isPlayable(c,this.turn));
      if (!playable.length){ this.draw(); return; }
      playable.sort((a,b)=>{ const score=(card)=>{ let s=0; if(card.color===this.currentColor) s+=3; if(this.topCard && card.kind===this.topCard.kind) s+=2; if(card.kind==='number') s+=1; if(card.kind==='wild4') s-=3; return -s; }; return score(a)-score(b); });
      this.play(playable[0].id);
    }, 450);
  }
  updateUI(){
    const pills=document.getElementById('playersPills');
    pills.innerHTML=this.players.map((p,i)=>`<span class="pill ${i===this.turn?'active':''}">${p.name} · ${p.hand.length}</span>`).join('');
    const top=this.topCard; const discardTop=document.getElementById('discardTop');
    document.getElementById('topLabel').textContent = top? `${top.label}` : '—';
    document.getElementById('colorLabel').textContent = this.currentColor?.toUpperCase?.()||'—';
    document.getElementById('dirLabel').textContent = this.direction===1?'→':'←';
    document.getElementById('turnLabel').textContent = `Turn: ${this.current?.name ?? '—'}`;
    document.getElementById('drawCount').textContent = this.drawPile.length;
    document.getElementById('discardCount').textContent = this.discardPile.length;
    renderCardFace(discardTop, top);
    discardTop.classList.remove('forcecolor-red','forcecolor-yellow','forcecolor-green','forcecolor-blue');
    if (top && (top.kind==='wild'||top.kind==='wild4')) discardTop.classList.add('forcecolor-'+this.currentColor);

    const handEl=document.getElementById('hand');
    handEl.innerHTML='';
    if (!this.current){ handEl.textContent='—'; return; }
    if (this.current.isAI){
      for(let i=0;i<this.current.hand.length;i++){ const back=document.createElement('div'); back.className='deckback small'; handEl.appendChild(back); }
      const note=document.createElement('div'); note.className='aiThinking'; note.textContent='AI is thinking…'; handEl.appendChild(note);
    } else {
      this.current.hand.forEach(card=>{
        const playable=this.isPlayable(card,this.turn);
        const div=document.createElement('div');
        div.className=`card small ${card.color} ${playable?'playable':'unplayable'}`;
        div.innerHTML=`<div class="color-ring"></div><div class="label">${card.label}</div><div class="tag">${card.kind.toUpperCase()}</div>`;
        if (playable) div.onclick=()=> this.play(card.id);
        handEl.appendChild(div);
      });
    }
    document.getElementById('drawBtn').disabled=!!this.current?.isAI;
    document.getElementById('unoBtn').disabled=!(this.current && !this.current.isAI && this.current.hand.length===2);
  }
  showHotseatCover(){ const modal=document.getElementById('modal'); const sheet=document.getElementById('modalSheet'); sheet.innerHTML=`<h3>${this.current.name}: Ready?</h3><p>Tap to reveal your hand.</p><div style="text-align:right"><button class="btn" id="startTurnBtn">Start Turn</button></div>`; modal.classList.add('show'); document.getElementById('startTurnBtn').onclick=()=> modal.classList.remove('show'); }
}
class Player{ constructor({name,isAI}){ this.name=name; this.isAI=isAI; this.hand=[]; this._unoCalled=false; } bestColor(){ const counts={red:0,yellow:0,green:0,blue:0}; for(const c of this.hand){ if(counts[c.color]!=null) counts[c.color]++; } let best='red',max=-1; for(const k in counts){ if(counts[k]>max){ max=counts[k]; best=k; } } return best; } }
function renderCardFace(el,card){ if(!card){ el.innerHTML='<span>—</span>'; el.className='card'; return; } el.className=`card ${card.color}`; el.innerHTML=`<div class="color-ring"></div><div class="label">${card.label}</div><div class="tag">${card.kind.toUpperCase()}</div>`; }

// ========= Wire-up =========
let game=null;
async function startNewGame(){
  const cfg = await loadConfig();
  const humans=+document.getElementById('humans').value||1;
  const bots=+document.getElementById('bots').value||1;
  const handSize=+document.getElementById('handSize').value||7;
  GAME_OPTIONS.challengeWild4=document.getElementById('rule_challengeWild4').checked;
  GAME_OPTIONS.strictWild4=document.getElementById('rule_strictWild4').checked;
  GAME_OPTIONS.stacking=document.getElementById('rule_stacking').checked;
  GAME_OPTIONS.allowCrossStacking=document.getElementById('rule_crossStacking').checked;
  GAME_OPTIONS.sevenSwap=document.getElementById('rule_sevenSwap').checked;
  GAME_OPTIONS.zeroPass=document.getElementById('rule_zeroPass').checked;
  GAME_OPTIONS.progressiveDraw=document.getElementById('rule_progressiveDraw').checked;
  GAME_OPTIONS.forcePlayDrawn=document.getElementById('rule_forcePlayDrawn').checked;
  const deckList=[...cfg.standardDeck, ...cfg.customDeck];
  game = new Game({humans,bots,handSize,stacking:GAME_OPTIONS.stacking,deckList});
  const expected=108 - ((humans+bots)*handSize) - 1;
  console.assert(game.drawPile.length===expected, `Draw pile should be ${expected}, got ${game.drawPile.length}`);
}
function runSelfTests(){ try{ console.assert(typeof CARD_TYPES.wild4==='object','wild4 exists'); toast('A'); toast('B'); const wrap=document.getElementById('toasts'); console.assert(wrap.children.length>=2,'Toast stack visible'); console.log('%cSelf-tests passed','color:#10b981'); }catch(e){ console.error('Self-tests error:',e); } }

window.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('newGame').onclick=startNewGame;
  document.getElementById('shuffleBtn').onclick=startNewGame;
  document.getElementById('drawBtn').onclick=()=> game?.draw();
  document.getElementById('unoBtn').onclick=()=> game?.callUNO();
  document.getElementById('drawBtnDev').onclick=()=> game?.draw();
  document.getElementById('skipBtnDev').onclick=()=> { game?.advance(); game?.maybeAIMove(); };
  const prog=document.getElementById('rule_progressiveDraw');
  const forceRow=document.getElementById('forcePlayRow');
  prog.addEventListener('change', ()=>{ forceRow.style.display = prog.checked ? 'flex' : 'none'; });
  runSelfTests();
  startNewGame();
});
